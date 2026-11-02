// discovery.js - SEARCH FLIGHTS with an empty box: find delayed and likely-delayed
// United / United Express flights across the network, soonest departures first.
//
//  1. Hub boards (FlightView departures + arrivals) first; every airport seen on them is
//     queued for its own departures board (busiest-soonest first).
//  2. Confirmed: United departures posted 30+ min late (and not obviously > 135 min long)
//     -> FlightView flight page.
//  3. Late aircraft: decided from actual times, not a fixed lateness cutoff. A plane can only
//     cause a 30-min predicted delay if  estArr + 35 - nextDep >= 30. Since the next departure
//     is at least FV_MIN_GROUND_MIN (20) after scheduled arrival, planes arriving less than
//     30 + 20 - 35 = 15 min late cannot qualify; everything else is followed:
//       United page -> fleet # -> verified tail -> FlightAware aircraft page -> next legs ->
//       UA number (board or route list) -> FlightView page confirms the previous flight.
//     A fleet/tail pair is used only if the aircraft page contains this exact flight;
//     otherwise (or with no pair) the previous-flight fallback is used.
//  4. Results are pushed to the dashboard as they are found (onUpdate).

const fv = require('./flightview');
const src = require('./sources');
const { createLoader, BlockedError, DisabledError, LimitError } = require('./fetchers');

const envInt = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) && v >= 0 ? v : d; };
const envList = (n, d) => (process.env[n] || d).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60000;

function config() {
  return {
    hubs: envList('FV_HUBS', 'EWR,ORD,DEN,IAH,SFO,IAD,LAX,GUM'),
    extraAirports: envList('FV_AIRPORTS', ''),
    expandAirports: process.env.FV_EXPAND_AIRPORTS !== 'false',
    maxPages: envInt('FV_DISCOVERY_MAX_PAGES', 1500),
    maxMinutes: envInt('FV_DISCOVERY_MAX_MINUTES', 30),
    workers: Math.max(1, envInt('FV_WORKERS', 8)),
    legsAhead: envInt('FV_LEGS_AHEAD', 3),
    lookaheadHours: envInt('FV_LOOKAHEAD_HOURS', 24),
    fallbackCandidates: envInt('FV_FALLBACK_CANDIDATES', 4),
    minGroundMin: envInt('FV_MIN_GROUND_MIN', 20),
    enRouteMarginMin: envInt('FV_ENROUTE_MARGIN_MIN', 10),
    maxDistanceMi: envInt('FV_MAX_DISTANCE_MI', 1150),
    turnaroundMin: 35,
    thresholdMin: 30
  };
}

const isBlock = e => e instanceof BlockedError || e instanceof fv.BlockedError;
const DONE_RE = /departed|in air|en route|landed|arrived|cancel/i;
const ms = v => (v ? Date.parse(v) : null);

async function discover({ now = Date.now(), onProgress = () => {}, onUpdate = () => {}, loader } = {}) {
  const cfg = config();
  const t0 = Date.now();
  const needLate = cfg.thresholdMin + cfg.minGroundMin - cfg.turnaroundMin;   // minutes late on arrival needed to matter
  const L = loader || createLoader({ maxPages: cfg.maxPages });
  const notes = [];
  const off = new Set();
  let halt = null;                         // reason the search stopped early
  let stoppedReason = null;                // a block (shown as an error)

  const records = new Map();               // recKey -> tracker-shaped flight
  const primary = new Set();
  const flightCache = new Map();           // request key -> Promise<{recKey, rec, prev} | null>
  const boardCache = new Map();            // "AP|kind" -> Promise<rows | null>
  const routeCache = new Map();
  const hubSet = new Set(cfg.hubs);
  const airportsQueued = new Set(), airportsDone = new Set(), airportsFailed = new Set();
  const seedKeys = new Set();
  const tailsDone = new Set();
  const stats = { boardRows: 0, flightsChecked: 0, confirmedCandidates: 0, longSkipped: 0, aircraftFollowed: 0,
    aircraftNotLateEnough: 0, tailsVerified: 0, tailsNotVerified: 0, legsLinked: 0, fallbackLinks: 0, swaps: 0, linkConflicts: 0 };

  // ---------- page access ----------
  async function get(source, url) {
    if (halt) return null;
    try { return await L.get(source, url); }
    catch (e) {
      if (e instanceof DisabledError) { off.add(source); if (source === 'flightview') halt = halt || 'FlightView live retrieval is off'; return null; }
      if (e instanceof LimitError) { halt = halt || e.message; return null; }
      if (isBlock(e)) { stoppedReason = stoppedReason || e.message; halt = halt || e.message; return null; }
      throw e;
    }
  }

  function flight(t) {
    const k = `${t.airline}${t.number}|${t.date || ''}|${t.depapt || ''}`;
    if (!flightCache.has(k)) flightCache.set(k, (async () => {
      const page = await get('flightview', fv.flightUrl(t));
      if (!page) return null;
      let res;
      try { res = fv.parsePage(page, t, t.date ? Date.parse(t.date + 'T12:00:00Z') : now); }
      catch (e) { if (isBlock(e)) { stoppedReason = stoppedReason || e.message; halt = halt || e.message; return null; } throw e; }
      if (!res.ok) { notes.push(`UA${t.number}: ${res.reason}`); return null; }
      stats.flightsChecked++;
      const rec = fv.toTrackerShape(res.flight);
      const recKey = `${rec.ident}|${rec.scheduled_out || t.date}`;
      if (!records.has(recKey)) { rec._fv.prevKey = null; records.set(recKey, rec); }
      return { recKey, rec: records.get(recKey), prev: res.flight.prev };
    })());
    return flightCache.get(k);
  }

  function board(ap, kind) {
    const k = `${ap}|${kind}`;
    if (!boardCache.has(k)) boardCache.set(k, (async () => {
      airportsQueued.add(ap);
      const page = await get('flightview', src.boardUrl(ap, kind));
      if (!page) return null;
      const rows = src.parseBoard(page, ap, kind, now);
      if (!rows) { airportsFailed.add(ap); notes.push(`${ap} ${kind} board not readable`); return null; }
      stats.boardRows += rows.length;
      airportsDone.add(ap);
      return rows;
    })());
    return boardCache.get(k);
  }

  function route(from, to, date) {
    const k = `${from}-${to}-${date}`;
    if (!routeCache.has(k)) routeCache.set(k, (async () => {
      const page = await get('flightview', src.routeUrl(from, to, date));
      return page ? src.parseRoute(page, from, to) : null;
    })());
    return routeCache.get(k);
  }

  // ---------- priority task queue (soonest first) ----------
  const tasks = [];
  let running = 0, dirty = false;
  const push = (pri, fn) => { if (!halt) tasks.push({ pri, fn }); };
  const pop = () => { if (!tasks.length) return null; let b = 0; for (let i = 1; i < tasks.length; i++) if (tasks[i].pri < tasks[b].pri) b = i; return tasks.splice(b, 1)[0]; };

  const elapsed = () => { const s = Math.round((Date.now() - t0) / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
  const progressText = () =>
    `Discovery ${elapsed()} - airports ${airportsDone.size}/${airportsQueued.size}, ${stats.boardRows} board rows, ` +
    `${stats.flightsChecked} flights checked, ${stats.aircraftFollowed} late aircraft followed, ` +
    `${stats.legsLinked + stats.fallbackLinks} later flights linked, ${L.total} pages`;
  let lastEmit = 0;
  function emit(force) {
    onProgress(progressText());
    if (dirty && (force || lastEmit === 0 || Date.now() - lastEmit > 1000)) {
      dirty = false; lastEmit = Date.now();
      onUpdate({ records, chains: fv.computeChains(records, cfg.turnaroundMin) });
    }
  }

  // ---------- linking (safe under concurrency) ----------
  const numOf = rec => rec.ident.replace(/^[A-Z0-9]{2}/, '');
  function linkTo(child, parentKey) {
    const cur = child.rec._fv.prevKey;
    if (cur && cur !== parentKey) { stats.linkConflicts++; return false; }
    child.rec._fv.prevKey = parentKey;
    primary.add(child.recKey);
    dirty = true;
    return true;
  }
  // effective arrival of rec when its previous flight arrives at prevEffArr
  function effArr(rec, prevEffArr) {
    const sd = ms(rec.scheduled_out), sa = ms(rec.scheduled_in);
    const dur = sd && sa ? sa - sd : 0;
    if (rec.actual_off) return ms(rec.actual_in) || ms(rec.estimated_in) || sa;
    const dep = Math.max(ms(rec.estimated_out) || sd || 0, prevEffArr ? prevEffArr + cfg.turnaroundMin * MIN : 0);
    return Math.max(ms(rec.estimated_in) || sa || 0, dep + dur);
  }
  const stillMatters = (rec, eff) => eff && ms(rec.scheduled_in) && (eff - ms(rec.scheduled_in)) >= needLate * MIN;

  // ---------- tasks ----------
  const airportTasks = new Set();
  function queueAirport(ap, pri) {
    if (airportTasks.has(ap) || hubSet.has(ap) || halt) return;
    airportTasks.add(ap);
    push(pri, async () => {
      const rows = await board(ap, 'departures');
      if (rows) rows.forEach(r => handleRow(r));
    });
  }

  async function hubTask(ap) {
    for (const kind of ['arrivals', 'departures']) {
      const rows = await board(ap, kind);
      if (!rows) continue;
      rows.forEach(r => handleRow(r));
      if (cfg.expandAirports) for (const r of rows) {
        if (!r.other || hubSet.has(r.other)) continue;
        // spoke's own departures matter from about when this flight gets there
        const pri = kind === 'departures' ? ms(r.schedIso) + 60 * MIN : now;
        queueAirport(r.other, pri);
      }
    }
  }

  function handleRow(r) {
    const late = r.lateMin;
    if (r.kind === 'departures') {
      const dist = src.distanceMi(r.airport, r.other);
      // confirmed delay candidate
      if (late >= cfg.thresholdMin && !DONE_RE.test(r.status) && ms(r.schedIso) - now >= 30 * MIN) {
        if (dist && dist > cfg.maxDistanceMi) stats.longSkipped++;
        else {
          stats.confirmedCandidates++;
          push(ms(r.schedIso), async () => {
            const f = await flight({ airline: 'UA', number: r.number, date: src.localDate(r.schedIso, r.airport), depapt: r.airport });
            if (f) { primary.add(f.recKey); dirty = true; }
          });
        }
      }
      // late-aircraft candidate (arrival time not on this board; flights into hubs use the hub arrivals row instead)
      if (!hubSet.has(r.other) && late >= needLate - cfg.enRouteMarginMin && !/cancel|landed|arrived/i.test(r.status))
        queueFollow({ number: r.number, date: src.localDate(r.schedIso, r.airport), depapt: r.airport, dest: r.other }, ms(r.updIso));
    } else if (late >= needLate && !/cancel|landed|arrived/i.test(r.status) && r.other) {
      // hub arrivals board: estimated arrival known exactly
      queueFollow({ number: r.number, date: src.localDate(new Date(ms(r.schedIso) - 3 * 3600000).toISOString(), r.other), depapt: r.other, dest: r.airport }, ms(r.updIso));
    }
  }

  function queueFollow(s, pri) {
    const k = `${s.number}|${s.dest}`;
    if (seedKeys.has(k)) return;
    seedKeys.add(k);
    push(pri, () => follow(s));
  }

  async function follow(s) {
    const seed = await flight({ airline: 'UA', number: s.number, date: s.date, depapt: s.depapt });
    if (!seed || seed.rec.actual_in) return;
    const sr = seed.rec;
    const E = effArr(sr, null);
    if (!stillMatters(sr, E)) { stats.aircraftNotLateEnough++; return; }
    stats.aircraftFollowed++;
    const origin = sr.origin.code_iata, dest = sr.destination.code_iata;

    // ---- tail number from a verified fleet pair ----
    let verifiedLegs = null, tail = null;
    const up = await get('united', src.unitedUrl(numOf(sr), s.date, origin, dest));
    const ui = up ? src.parseUnited(up) : null;
    if (ui && ui.fleet) { sr._fv.fleet = ui.fleet; tail = src.tailForFleet(ui.fleet); }
    if (tail) {
      if (tailsDone.has(tail)) return;           // same plane already being followed by another task
      tailsDone.add(tail);
      const fp = await get('flightaware', src.faHistoryUrl(tail));
      const legs = fp ? src.parseFaHistory(fp, tail) : null;
      const sd = ms(sr.scheduled_out);
      const idx = legs ? legs.findIndex(l => l.from === origin && l.to === dest && Math.abs(ms(l.depIso) - sd) <= 90 * MIN) : -1;
      if (idx >= 0) { verifiedLegs = legs.slice(idx + 1); sr._fv.tail = tail; stats.tailsVerified++; }
      else { stats.tailsNotVerified++; notes.push(`fleet #${ui.fleet} -> ${tail} not confirmed for ${sr.ident} - using previous-flight check`); }
    }

    let prev = seed, prevEff = E;
    for (let step = 0; step < cfg.legsAhead && !halt; step++) {
      let next = null;
      if (verifiedLegs) {
        const leg = verifiedLegs[step];
        if (!leg || ms(leg.depIso) - now > cfg.lookaheadHours * 3600000) break;
        next = await legFlight(leg);
        if (!next) break;
        if (next.prev && next.prev.number !== numOf(prev.rec)) {
          notes.push(`${next.rec.ident}: previous flight is UA${next.prev.number}, not ${prev.rec.ident} (aircraft swap?)`);
          stats.swaps++; break;
        }
        if (!linkTo(next, prev.recKey)) break;
        next.rec._fv.tail = tail; stats.legsLinked++;
      } else {
        next = await fallbackNext(prev);
        if (!next) break;
        if (!linkTo(next, prev.recKey)) break;
        stats.fallbackLinks++;
      }
      prevEff = effArr(next.rec, prevEff);
      if (!stillMatters(next.rec, prevEff)) break;      // delay absorbed - stop following
      prev = next;
    }
  }

  // UA number for a FlightAware leg: departures board if soon, else the route list
  async function legFlight(leg) {
    const ld = ms(leg.depIso);
    const date = src.localDate(leg.depIso, leg.from);
    let num = null;
    if (ld - now <= 3 * 3600000) {
      const rows = await board(leg.from, 'departures');
      const m = (rows || []).filter(r => r.other === leg.to && Math.abs(ms(r.schedIso) - ld) <= 20 * MIN)
        .sort((a, b) => Math.abs(ms(a.schedIso) - ld) - Math.abs(ms(b.schedIso) - ld))[0];
      if (m) num = m.number;
    }
    if (!num) {
      const rows = await route(leg.from, leg.to, date);
      const m = (rows || []).filter(r => r.depIso && Math.abs(ms(r.depIso) - ld) <= 30 * MIN)
        .sort((a, b) => Math.abs(ms(a.depIso) - ld) - Math.abs(ms(b.depIso) - ld))[0];
      if (m) num = m.number;
    }
    if (!num) { notes.push(`no United flight found ${leg.from}-${leg.to} near ${leg.depIso.slice(11, 16)}Z`); return null; }
    return flight({ airline: 'UA', number: num, date, depapt: leg.from });
  }

  // next departure at the arrival airport whose "Aircraft's Previous Flight" is prev
  async function fallbackNext(prev) {
    const ap = prev.rec.destination.code_iata;
    const arr = ms(prev.rec.scheduled_in);
    const rows = await board(ap, 'departures');
    const cands = (rows || []).filter(r => { const d = ms(r.schedIso) - arr; return d >= 15 * MIN && d <= 4 * 3600000; })
      .sort((a, b) => ms(a.schedIso) - ms(b.schedIso)).slice(0, cfg.fallbackCandidates);
    for (const c of cands) {
      const f = await flight({ airline: 'UA', number: c.number, date: src.localDate(c.schedIso, ap), depapt: ap });
      if (f && f.prev && f.prev.number === numOf(prev.rec)) return f;
    }
    return null;
  }

  // ---------- run ----------
  try {
    cfg.hubs.forEach(h => push(-1, () => hubTask(h)));                 // hubs first
    cfg.extraAirports.forEach(a => queueAirport(a, now));
    const ticker = setInterval(() => emit(false), 1000);
    try {
      await Promise.all(Array.from({ length: cfg.workers }, async () => {
        for (;;) {
          if (!halt && Date.now() - t0 > cfg.maxMinutes * MIN) halt = `time limit (${cfg.maxMinutes} min) reached`;
          if (halt) return;
          const t = pop();
          if (!t) { if (running === 0) return; await sleep(25); continue; }
          running++;
          try { await t.fn(); }
          catch (e) { if (isBlock(e)) { stoppedReason = stoppedReason || e.message; halt = halt || e.message; } else notes.push(`error: ${e.message}`); }
          finally { running--; emit(false); }
        }
      }));
    } finally { clearInterval(ticker); }
  } finally {
    await L.close();
  }

  const tasksLeft = tasks.length;
  const partial = !!halt || tasksLeft > 0;
  for (const s of off) if (s !== 'flightview') notes.push(`${s} is off - used previous-flight check instead of tail numbers`);
  const coverage = {
    partial,
    reason: halt || null,
    airportsChecked: airportsDone.size,
    airportsQueued: airportsQueued.size,
    airportsFailed: airportsFailed.size,
    tasksNotDone: tasksLeft,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    pages: L.total,
    uniquePages: L.uniqueUrls
  };
  dirty = true; emit(true);
  return { records, chains: fv.computeChains(records, cfg.turnaroundMin), primaryKeys: [...primary], pages: L.total,
    counts: { ...L.counts }, notes, stoppedReason, stats: { ...stats, airports: airportsDone.size }, coverage,
    disabled: off.has('flightview') };
}

module.exports = { discover, config };
