// flightview.js - FlightView data adapter for the United Delay Tracker.
//
// Turns FlightView flight pages into the same flight objects server.js already
// uses (same field names as the old FlightAware data), follows each flight's
// "Aircraft's Previous Flight" link, and chains delays down an aircraft's
// rotation.
//
// LIVE RETRIEVAL IS OFF BY DEFAULT. No request is ever made to flightview.com
// unless the Railway variable FLIGHTVIEW_LIVE is set to "true". Only turn that on
// once OAG has confirmed in writing that this use is allowed (Terms of Use 7.1 / 7.3.1).
//
// Ground rules for live mode (do not remove):
//   - runs only when the Search button is pressed, never on a schedule
//   - hard cap on pages per search, with a pause between pages
//   - stops at the first CAPTCHA, block or error status page; never retries around it
//   - reads only the labelled fields a person sees on the page (no hidden data decoding)
//   - default browser identity, no stealth or evasion tricks
//
// Airport time zones: airport-tz.json, built from the airportsdata project
// (MIT License, (c) 2020- Mike Borsetti).

const fs = require('fs');
const path = require('path');

const TZ_GROUPS = require('./airport-tz.json');
const AIRPORT_TZ = {};
for (const [tz, codes] of Object.entries(TZ_GROUPS)) {
  for (const c of codes.split(' ')) AIRPORT_TZ[c] = tz;
}

const envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const CONFIG = {
  live: process.env.FLIGHTVIEW_LIVE === 'true',
  fixtureDir: process.env.FV_FIXTURE_DIR || '',     // testing only: read saved pages from a folder
  maxFlights: envInt('FV_MAX_FLIGHTS', 15),          // flights you can search at once
  maxPages: envInt('FV_MAX_PAGES', 30),              // total FlightView pages per search, incl. previous flights
  prevDepth: envInt('FV_PREV_DEPTH', 2),             // how many previous flights to follow back per flight
  pageGapMs: envInt('FV_PAGE_GAP_MS', 4000),         // pause between page loads (live mode)
  pageTimeoutMs: envInt('FV_PAGE_TIMEOUT_MS', 30000),
  turnaroundMin: 35
};

// FV_TEST_BASE_URL is for local testing only (points the browser at a test server
// serving made-up pages). Leave it unset on Railway.
const BASE = (process.env.FV_TEST_BASE_URL || 'https://www.flightview.com').replace(/\/$/, '') + '/flight-tracker';

class BlockedError extends Error {}
class DisabledError extends Error {}

function mode() {
  if (CONFIG.fixtureDir) return 'fixtures';
  if (CONFIG.live) return 'live';
  return 'disabled';
}

// ---------- flight references ----------

// "UA1234", "UA 1234", "UA1234/EWR", "UA1234/EWR/2026-11-02"
function parseTarget(str, defaultDate) {
  const s = String(str || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = s.match(/^([A-Z0-9]{2})(\d{1,4})(?:\/([A-Z]{3}))?(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (!m) return null;
  if (/^\d{2}$/.test(m[1])) return null;
  return { airline: m[1], number: String(parseInt(m[2], 10)), depapt: m[3] || null, date: m[4] || defaultDate || null };
}

function targetKey(t) {
  return `${t.airline}${t.number}|${t.date || ''}|${t.depapt || ''}`;
}

function flightUrl(t) {
  const q = [];
  if (t.date) q.push(`date=${encodeURIComponent(t.date)}`);
  if (t.depapt) q.push(`depapt=${encodeURIComponent(t.depapt)}`);
  return `${BASE}/${encodeURIComponent(t.airline)}/${encodeURIComponent(t.number)}${q.length ? '?' + q.join('&') : ''}`;
}

function targetFromUrl(href) {
  try {
    const u = new URL(href, 'https://www.flightview.com');
    const m = u.pathname.match(/\/flight-tracker\/([A-Za-z0-9]{2})\/(\d{1,4})/);
    if (!m) return null;
    return {
      airline: m[1].toUpperCase(),
      number: String(parseInt(m[2], 10)),
      date: u.searchParams.get('date') || null,
      depapt: (u.searchParams.get('depapt') || '').toUpperCase() || null
    };
  } catch { return null; }
}

// ---------- time handling ----------

function tzOffsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - ts;
}

function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const next = wall - tzOffsetMs(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// "10:40 PM, Nov 01" at airport `code` -> ISO string (UTC). Year is taken as the
// one that puts the date closest to refMs. Returns null if anything is unknown.
function localToIso(str, code, refMs) {
  if (!str || !code) return null;
  const tz = AIRPORT_TZ[code];
  if (!tz) return null;
  const m = String(str).match(/(\d{1,2}):(\d{2})\s*([AP])M\s*,?\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  const mi = parseInt(m[2], 10);
  const mo = MONTHS[m[4].toUpperCase()];
  const d = parseInt(m[5], 10);
  if (mo === undefined) return null;
  const refYear = new Date(refMs).getUTCFullYear();
  let best = null;
  for (const y of [refYear - 1, refYear, refYear + 1]) {
    const t = zonedToUtcMs(y, mo, d, h, mi, tz);
    if (best === null || Math.abs(t - refMs) < Math.abs(best - refMs)) best = t;
  }
  return new Date(best).toISOString();
}

// ---------- page parsing ----------
// Reads the labelled text a person sees on a FlightView flight page.

function lines(text) {
  return String(text || '').split('\n').map(l => l.replace(/\s+$/, ''));
}

function sectionBetween(all, startLabel, endLabels) {
  const start = all.findIndex(l => l.trim() === startLabel);
  if (start === -1) return [];
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    if (endLabels.includes(all[i].trim())) { end = i; break; }
  }
  return all.slice(start + 1, end);
}

function field(sec, label) {
  const re = new RegExp('^\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':?\\s*(?:\\t|\\s{2,}|$)(.*)$', 'i');
  for (let i = 0; i < sec.length; i++) {
    const m = sec[i].match(re);
    if (m) {
      const v = m[1].trim();
      if (v) return v;
      const nxt = (sec[i + 1] || '').trim();      // value on the following line
      return nxt || null;
    }
  }
  return null;
}

function airportCode(v) {
  const m = String(v || '').match(/\(([A-Z]{3})\)/);
  return m ? m[1] : null;
}

function durationMins(v) {
  if (!v) return null;
  const h = String(v).match(/(\d+)\s*hr/i);
  const m = String(v).match(/(\d+)\s*min/i);
  if (!h && !m) return null;
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

const BLOCK_PATTERNS = /captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|access denied|request (has been )?blocked|press (and|&) hold|bot detection|checking your browser/i;

// page = { status, text, links:[{text, href}], url }
// returns { ok:true, flight } | { ok:false, reason }
function parsePage(page, requested, refMs) {
  if (page.status && [401, 403, 407, 429, 451, 503].includes(page.status)) {
    throw new BlockedError(`FlightView returned HTTP ${page.status} - stopped`);
  }
  if (BLOCK_PATTERNS.test(page.text || '')) {
    throw new BlockedError('FlightView showed a CAPTCHA / verification page - stopped');
  }
  const all = lines(page.text);
  const fsIdx = all.findIndex(l => l.trim().toUpperCase() === 'FLIGHT STATUS');
  if (fsIdx === -1) return { ok: false, reason: 'no flight details on page (not found, or page layout changed)' };

  let airline = requested.airline, number = requested.number;
  for (let i = fsIdx - 1; i >= Math.max(0, fsIdx - 6); i--) {
    const m = all[i].match(/\(([A-Z0-9]{2})\)\s*(\d{1,4})\s*$/);
    if (m) { airline = m[1]; number = String(parseInt(m[2], 10)); break; }
  }
  let status = null;
  for (let i = fsIdx + 1; i < all.length; i++) { if (all[i].trim()) { status = all[i].trim(); break; } }

  const dep = sectionBetween(all, 'Departure', ['Arrival', 'Flight Details']);
  const arr = sectionBetween(all, 'Arrival', ['Flight Details', "Aircraft's Previous Flight"]);
  const det = sectionBetween(all, 'Flight Details', ["Aircraft's Previous Flight", 'Track Another Flight']);
  const prevSec = sectionBetween(all, "Aircraft's Previous Flight", ['All times listed are local times unless otherwise stated.', 'Track Another Flight']);

  const origin = airportCode(field(dep, 'Airport'));
  const dest = airportCode(field(arr, 'Airport'));
  if (!origin || !dest) return { ok: false, reason: 'departure/arrival airport missing on page' };

  const t = (sec, label, code) => localToIso(field(sec, label), code, refMs);
  const flight = {
    airline, number, ident: `${airline}${number}`, status,
    origin, dest,
    originTz: AIRPORT_TZ[origin] || null,
    destTz: AIRPORT_TZ[dest] || null,
    schedDep: t(dep, 'Scheduled Time', origin),
    estDep: t(dep, 'Estimated Time', origin),
    actDep: t(dep, 'Actual Time', origin),
    schedArr: t(arr, 'Scheduled Time', dest),
    estArr: t(arr, 'Estimated Time', dest),
    actArr: t(arr, 'Actual Time', dest),
    terminal: field(dep, 'Terminal'),
    gate: field(dep, 'Gate'),
    durationMins: durationMins(field(dep, 'Duration')),
    aircraft: field(det, 'Aircraft'),
    prev: null,
    url: page.url
  };

  // Aircraft's Previous Flight: prefer the page's own link (it pins date + airport).
  let prevRef = null;
  const prevLabel = prevSec.map(l => l.trim()).find(l => /\([A-Z0-9]{2}\)\s*\d{1,4}$/.test(l));
  if (prevLabel) {
    const lm = prevLabel.match(/\(([A-Z0-9]{2})\)\s*(\d{1,4})$/);
    const link = (page.links || []).find(a =>
      (a.text || '').replace(/\s+/g, ' ').trim() === prevLabel && targetFromUrl(a.href));
    prevRef = link ? targetFromUrl(link.href) : null;
    if (!prevRef && lm) prevRef = { airline: lm[1], number: String(parseInt(lm[2], 10)), date: requested.date, depapt: null };
  }
  flight.prev = prevRef;
  return { ok: true, flight };
}

// ---------- shape the result like the old FlightAware objects ----------

const DEPARTED_RE = /departed|in air|in flight|en route|airborne|landed|arrived/i;

function toTrackerShape(fv) {
  const secs = (a, b) => (a && b) ? Math.round((new Date(a) - new Date(b)) / 1000) : 0;
  const departed = !!fv.actDep || DEPARTED_RE.test(fv.status || '');
  return {
    ident: fv.ident,
    ident_iata: fv.ident,
    codeshares_iata: [],
    status: fv.status || '-',
    operator: null,                      // FlightView page doesn't show the operating carrier
    origin: { code_iata: fv.origin, timezone: fv.originTz || undefined },
    destination: { code_iata: fv.dest, timezone: fv.destTz || undefined },
    gate_origin: fv.gate || null,
    terminal_origin: fv.terminal || null,
    scheduled_out: fv.schedDep,
    estimated_out: fv.estDep || fv.schedDep,
    actual_off: fv.actDep || (departed ? (fv.estDep || fv.schedDep) : null),
    scheduled_in: fv.schedArr,
    estimated_in: fv.estArr || fv.schedArr,
    actual_in: fv.actArr || (/landed|arrived/i.test(fv.status || '') ? (fv.estArr || fv.schedArr) : null),
    departure_delay: secs(fv.estDep, fv.schedDep),
    arrival_delay: secs(fv.estArr, fv.schedArr),
    inbound_fa_flight_id: null,
    _fv: { url: fv.url, aircraft: fv.aircraft, prev: fv.prev, durationMins: fv.durationMins }
  };
}

// ---------- page fetchers ----------

function fixtureFetcher(dir) {
  const delay = envInt('FV_FIXTURE_DELAY_MS', 0);    // testing only: simulate slow pages
  return {
    async get(url) {
      if (delay) await sleep(delay);
      const t = targetFromUrl(url);
      const base = `${t.airline}${t.number}`;
      const candidates = [
        `${base}_${t.date || ''}_${t.depapt || ''}.json`, `${base}_${t.date || ''}_.json`, `${base}.json`
      ];
      for (const f of candidates) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) return { ...JSON.parse(fs.readFileSync(p, 'utf8')), url };
      }
      return { status: 404, text: '', links: [], url };
    },
    async close() {}
  };
}

function liveFetcher() {
  let browser = null, context = null;
  return {
    async get(url) {
      if (!browser) {
        let pw;
        try { pw = require('playwright'); } catch {
          throw new Error('Live FlightView retrieval needs the "playwright" package (see setup notes)');
        }
        // --disable-dev-shm-usage: Railway containers have a tiny /dev/shm, which crashes Chromium otherwise
        const opts = { headless: true, args: ['--disable-dev-shm-usage'] };
        if (process.env.FV_CHROMIUM_PATH) opts.executablePath = process.env.FV_CHROMIUM_PATH;
        browser = await pw.chromium.launch(opts);
        context = await browser.newContext();
      }
      const page = await context.newPage();
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.pageTimeoutMs });
        const status = resp ? resp.status() : 0;
        if (status < 400) {
          await page.waitForFunction(
            () => /FLIGHT STATUS/i.test(document.body.innerText) ||
                  /captcha|verify you are human|access denied/i.test(document.body.innerText),
            null, { timeout: Math.min(15000, CONFIG.pageTimeoutMs) }
          ).catch(() => {});
        }
        const text = await page.evaluate(() => document.body.innerText);
        const links = await page.$$eval('a[href*="/flight-tracker/"]',
          as => as.slice(0, 50).map(a => ({ text: a.innerText, href: a.href })));
        return { status, text, links, url };
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() {
      if (browser) await browser.close().catch(() => {});
      browser = null;
    }
  };
}

function makeFetcher() {
  const m = mode();
  if (m === 'fixtures') return fixtureFetcher(CONFIG.fixtureDir);
  if (m === 'live') return liveFetcher();
  throw new DisabledError(
    'FlightView live retrieval is OFF (FLIGHTVIEW_LIVE is not "true"). No pages were requested. ' +
    'Turn it on in Railway only after OAG has given written permission.');
}

// ---------- search: watchlist flights + their previous flights ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// targets: [{airline, number, date, depapt}]
// returns { records: Map(key -> trackerShape), primaryKeys, pages, notes, stoppedReason }
async function search(targets, { fetcher, onProgress = () => {}, now = Date.now() } = {}) {
  const f = fetcher || makeFetcher();
  const records = new Map();       // record key -> tracker-shaped flight
  const reqToRec = new Map();      // request key -> record key
  const primaryKeys = [];
  const notes = [];
  let pages = 0, stoppedReason = null;

  const queue = targets.slice(0, CONFIG.maxFlights).map(t => ({ t, depth: 0 }));
  if (targets.length > CONFIG.maxFlights) notes.push(`only the first ${CONFIG.maxFlights} flights were searched`);

  try {
    while (queue.length) {
      const { t, depth } = queue.shift();
      const rk = targetKey(t);
      if (reqToRec.has(rk)) {
        if (depth === 0 && reqToRec.get(rk)) primaryKeys.push(reqToRec.get(rk));
        continue;
      }
      if (pages >= CONFIG.maxPages) { notes.push(`page limit (${CONFIG.maxPages}) reached`); break; }
      if (pages > 0 && mode() === 'live') await sleep(CONFIG.pageGapMs);
      pages++;
      onProgress(`FlightView page ${pages}/${CONFIG.maxPages}: ${t.airline}${t.number}`);

      const page = await f.get(flightUrl(t));
      const refMs = t.date ? Date.parse(t.date + 'T12:00:00Z') : now;
      const res = parsePage(page, t, refMs);          // throws BlockedError -> stop
      if (!res.ok) {
        reqToRec.set(rk, null);
        notes.push(`${t.airline}${t.number}: ${res.reason}`);
        continue;
      }
      const shaped = toTrackerShape(res.flight);
      const recKey = `${shaped.ident}|${shaped.scheduled_out || t.date}`;
      if (!records.has(recKey)) records.set(recKey, shaped);
      reqToRec.set(rk, recKey);
      if (depth === 0) primaryKeys.push(recKey);
      if (!shaped.scheduled_out) notes.push(`${shaped.ident}: unknown time zone for ${res.flight.origin}, times unavailable`);

      const prev = res.flight.prev;
      if (prev) {
        const prk = targetKey(prev);
        shaped._fv.prevReqKey = prk;
        if (depth < CONFIG.prevDepth) queue.push({ t: prev, depth: depth + 1 });
      }
    }
  } catch (e) {
    if (e instanceof BlockedError) stoppedReason = e.message;
    else throw e;
  } finally {
    await f.close();
  }

  // link each record to its previous-flight record (if we fetched it)
  for (const rec of records.values()) {
    const prk = rec._fv.prevReqKey;
    rec._fv.prevKey = prk && reqToRec.get(prk) ? reqToRec.get(prk) : null;
  }
  return { records, primaryKeys: [...new Set(primaryKeys)], pages, notes, stoppedReason };
}

// ---------- rotation chain ----------
// Carries a late aircraft forward: a flight can't leave before its previous
// flight's (possibly chained) arrival + turnaround.
// Returns Map(key -> { readyMs, effDepMs, effArrMs, prevLandedOrMissing })

function computeChains(records, turnaroundMin = CONFIG.turnaroundMin) {
  const out = new Map();
  const ms = v => (v ? new Date(v).getTime() : null);
  const visiting = new Set();

  function calc(key) {
    if (out.has(key)) return out.get(key);
    const r = records.get(key);
    if (!r || visiting.has(key)) return null;
    visiting.add(key);

    const landed = !!r.actual_in;
    const departed = !!r.actual_off;
    const schedDur = (ms(r.scheduled_in) && ms(r.scheduled_out)) ? ms(r.scheduled_in) - ms(r.scheduled_out) : null;
    const estDep = ms(r.estimated_out) || ms(r.scheduled_out);

    let readyMs = null;
    const prev = r._fv.prevKey ? records.get(r._fv.prevKey) : null;
    if (prev && !prev.actual_in) {
      const p = calc(r._fv.prevKey);
      if (p && p.effArrMs) readyMs = p.effArrMs + turnaroundMin * 60000;
    }

    let effDepMs, effArrMs;
    if (departed) {
      effDepMs = ms(r.actual_off) || estDep;
      effArrMs = ms(r.actual_in) || ms(r.estimated_in) || ms(r.scheduled_in);
    } else {
      effDepMs = Math.max(estDep || 0, readyMs || 0) || null;
      const ownArr = ms(r.estimated_in) || ms(r.scheduled_in);
      effArrMs = (effDepMs && schedDur) ? Math.max(ownArr || 0, effDepMs + schedDur) : ownArr;
    }
    if (landed) effArrMs = ms(r.actual_in);

    const res = { readyMs, effDepMs, effArrMs };
    out.set(key, res);
    visiting.delete(key);
    return res;
  }
  for (const k of records.keys()) calc(k);
  return out;
}

module.exports = {
  CONFIG, mode, BlockedError, DisabledError, AIRPORT_TZ,
  parseTarget, flightUrl, targetFromUrl, localToIso, parsePage, toTrackerShape,
  search, computeChains, makeFetcher
};
