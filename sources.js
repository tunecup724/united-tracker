// sources.js - addresses and page readers for the discovery search.
// Readers use only the labelled text/tables a person sees on each page.

const { base } = require('./fetchers');
const { AIRPORT_TZ, localToIso } = require('./flightview');
const ICAO_EXCEPTIONS = require('./airport-icao.json');
const GEO = require('./airport-geo.json');

// Fleet number -> tail number. Only pairs confirmed from a source that shows both
// together; never derived from numbering patterns. Extra pairs can be added in Railway
// with FV_FLEET_TAILS="4504=N14504,5409=N509UA". Every pair is still checked against the
// aircraft's flight history before it is used for a prediction (see discovery.js).
let FLEET_TAILS = {};
try {
  const raw = require('./fleet-tails.json');
  for (const [k, v] of Object.entries(raw)) FLEET_TAILS[k] = typeof v === 'string' ? v : v.tail;
} catch { FLEET_TAILS = {}; }
for (const pair of (process.env.FV_FLEET_TAILS || '').split(',')) {
  const m = pair.trim().match(/^#?(\d{3,5})\s*=\s*(N[0-9A-Z]{1,5})$/i);
  if (m) FLEET_TAILS[m[1]] = m[2].toUpperCase();
}

// Great-circle miles between two airports (null if unknown).
function distanceMi(a, b) {
  const p = GEO[a], q = GEO[b];
  if (!p || !q) return null;
  const r = Math.PI / 180;
  const x = Math.sin((q[0] - p[0]) * r / 2) ** 2 + Math.cos(p[0] * r) * Math.cos(q[0] * r) * Math.sin((q[1] - p[1]) * r / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(x));
}

const MAX_UA_NUMBER = 6999;   // UA 7000+ are United codes on partner airlines (excluded, like the original tracker)

// ---------- helpers ----------
function localDate(iso, code) {
  const tz = AIRPORT_TZ[code] || 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "6:08 PM" (no date) at airport -> ISO, choosing yesterday/today/tomorrow closest to nowMs
function timeNearest(t, code, nowMs) {
  if (!t || !/\d{1,2}:\d{2}\s*[AP]M/i.test(t)) return null;
  const tm = t.match(/\d{1,2}:\d{2}\s*[AP]M/i)[0];
  let best = null;
  const [y0, m0, d0] = localDate(new Date(nowMs).toISOString(), code).split('-').map(Number);
  for (const dd of [-1, 0, 1]) {                       // yesterday / today / tomorrow by calendar date
    const d = new Date(Date.UTC(y0, m0 - 1, d0 + dd));
    const iso = localToIso(`${tm}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`, code, d.getTime() + 12 * 3600000);
    if (iso && (best === null || Math.abs(Date.parse(iso) - nowMs) < Math.abs(Date.parse(best) - nowMs))) best = iso;
  }
  return best;
}
// Local clock time "h:mm AM" at airport, on startYmd or the next day(s) - the first that is not before notBeforeMs.
// Converts each calendar date separately, so daylight-saving changes are handled correctly.
function localOnOrAfter(t, startYmd, code, notBeforeMs) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
  if (!m || !startYmd) return null;
  const [y, mo, d] = startYmd.split('-').map(Number);
  for (let k = 0; k < 3; k++) {
    const day = new Date(Date.UTC(y, mo - 1, d + k));
    const iso = localToIso(`${+m[1]}:${m[2]} ${m[3]}M, ${MON[day.getUTCMonth()]} ${day.getUTCDate()}`, code, day.getTime() + 12 * 3600000);
    if (iso && Date.parse(iso) >= notBeforeMs) return iso;
  }
  return null;
}
const code3 = s => { const m = String(s || '').match(/\(([A-Z0-9]{3})\)/); return m ? m[1] : null; };

function icaoToIata(icao, text) {
  const both = String(text || '').match(/\(([A-Z0-9]{3})\s*\/\s*([A-Z0-9]{4})\)/);
  if (both) return both[1];
  if (!icao) return null;
  if (ICAO_EXCEPTIONS[icao]) return ICAO_EXCEPTIONS[icao];
  if (/^K[A-Z0-9]{3}$/.test(icao)) return icao.slice(1);
  if (/^[CP][A-Z0-9]{3}$/.test(icao)) return icao.slice(1);
  return null;
}

// ---------- FlightView airport boards ----------
const boardUrl = (code, kind) => `${base('flightview')}/airport/${code}/${kind}`;

// -> [{ number, airport, other, status, schedIso, updIso, gate, kind, lateMin }]
function parseBoard(page, airport, kind, nowMs) {
  const tbl = (page.tables || []).find(t => t[0] && /scheduled/i.test(t[0].join(' ')) && /updated/i.test(t[0].join(' ')));
  if (!tbl) return null;
  const out = [];
  for (const row of tbl.slice(1)) {
    if (row.length < 6) continue;
    const airline = row[0].replace(/\s+/g, ' ').trim();
    const num = parseInt(row[1], 10);
    if (airline !== 'United Airlines' || !Number.isFinite(num) || num > MAX_UA_NUMBER) continue;
    const schedIso = timeNearest(row[4], airport, nowMs);
    const updIso = timeNearest(row[5], airport, nowMs) || schedIso;
    if (!schedIso) continue;
    let lateMin = Math.round((Date.parse(updIso) - Date.parse(schedIso)) / 60000);
    if (lateMin < -720) lateMin += 1440;
    out.push({ number: String(num), airport, other: code3(row[2]), status: row[3], schedIso, updIso, gate: row[6] || null, kind, lateMin });
  }
  return out;
}

// ---------- FlightView route results (whole-day schedule for one route) ----------
const routeUrl = (from, to, date) => `${base('flightview')}/flight-tracker/by-route-results/${from}/${to}/${date}?time=ANY`;

// -> [{ number, status, depIso, arrIso }]  (United-operated rows only)
function parseRoute(page, from, to) {
  const tbl = (page.tables || []).find(t => t[0] && /flight number/i.test(t[0].join(' ')) && /departure time/i.test(t[0].join(' ')));
  if (!tbl) return null;
  const out = [];
  for (const row of tbl.slice(1)) {
    if (row.length < 6) continue;
    const airline = row[0].replace(/\s+/g, ' ').trim();
    const num = parseInt(row[1], 10);
    if (airline !== 'United Airlines' || row[3] || !Number.isFinite(num) || num > MAX_UA_NUMBER) continue;
    const dt = s => s.replace(/\s*\n\s*/, ', ');
    out.push({ number: String(num), status: row[2], depIso: localToIso(dt(row[4]), from, Date.now()), arrIso: localToIso(dt(row[5]), to, Date.now()) });
  }
  return out;
}

// ---------- United flight status (fleet number) ----------
const unitedUrl = (num, date, from, to) => `${base('united')}/en/us/flightstatus/details/${num}/${date}/${from}/${to}/UA`;

// -> { fleet, aircraftType, inbound:{number,date,from,to} } | null
function parseUnited(page) {
  const t = page.text || '';
  const i = t.indexOf('Aircraft details');
  const seg = i >= 0 ? t.slice(i, i + 300) : t;
  const m = seg.match(/\n?\s*([^\n|]+?)\s*\|\s*#(\d{3,5})/);
  const inbLink = (page.links || []).find(a => /coming from/i.test(a.text || ''));
  let inbound = null;
  if (inbLink) {
    const lm = inbLink.href.match(/flightstatus\/details\/(\d+)\/(\d{4}-\d{2}-\d{2})\/([A-Z]{3})\/([A-Z]{3})/);
    if (lm) inbound = { number: lm[1], date: lm[2], from: lm[3], to: lm[4] };
  }
  if (!m && !inbound) return null;
  return { fleet: m ? m[2] : null, aircraftType: m ? m[1].trim() : null, inbound };
}

const tailForFleet = fleet => (fleet && FLEET_TAILS[fleet]) || null;

// ---------- FlightAware aircraft history page (future legs by tail) ----------
const faHistoryUrl = tail => `${base('flightaware')}/live/flight/${tail}/history`;

// -> legs sorted by departure: [{ from, to, depIso, arrIso, status }]
// FlightAware nests the flight list inside layout tables whose text also mentions "Origin",
// so pick the table whose header CELLS are Date/Origin/Destination/Departure (most rows wins),
// and read each flight's date, airports and times from its own row.
function parseFaHistory(page, tail) {
  const isHead = r => { const c = (r || []).map(x => String(x).replace(/\s+/g, ' ').trim().toLowerCase());
    return ['date', 'origin', 'destination', 'departure'].every(h => c.includes(h)); };
  const tbl = (page.tables || []).filter(t => isHead(t[0])).sort((a, b) => b.length - a.length)[0];
  if (!tbl) return null;
  const head = tbl[0].map(x => String(x).replace(/\s+/g, ' ').trim().toLowerCase());
  const col = h => head.indexOf(h);
  const MONS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const legs = [];
  for (const row of tbl.slice(1)) {
    const dm = String(row[col('date')] || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (!dm || MONS[dm[2].toUpperCase()] === undefined) continue;
    const ymd = `${dm[3]}-${String(MONS[dm[2].toUpperCase()] + 1).padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    const code = cell => { const t = String(cell || ''); const m = t.match(/\(([A-Z0-9]{3,4})(?:\s*\/\s*([A-Z0-9]{4}))?\)/);
      if (!m) return null; if (m[2]) return m[1]; return m[1].length === 3 ? m[1] : icaoToIata(m[1], t); };
    const from = code(row[col('origin')]), to = code(row[col('destination')]);
    if (!from || !to || !AIRPORT_TZ[from]) continue;
    const depIso = fr24Time(row[col('departure')], ymd, from);
    if (!depIso) continue;
    const arrIso = col('arrival') >= 0 && AIRPORT_TZ[to] ? localOnOrAfter(row[col('arrival')], localDate(depIso, to), to, Date.parse(depIso)) : null;
    const status = row[head.length - 1] || '';
    legs.push({ from, to, depIso, arrIso, status: String(status) });
  }
  return legs.sort((a, b) => Date.parse(a.depIso) - Date.parse(b.depIso));
}

// ---------- Flightradar24 (tail number by flight, upcoming flights by tail) ----------
const fr24FlightUrl = num => `${base('fr24')}/data/flights/ua${num}`;
const fr24AircraftUrl = tail => `${base('fr24')}/data/aircraft/${String(tail).toLowerCase()}`;
const MON_IDX = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function fr24Date(s) {                       // "02 Nov 2026" -> "2026-11-02"
  const m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m || MON_IDX[m[2].toUpperCase()] === undefined) return null;
  return `${m[3]}-${String(MON_IDX[m[2].toUpperCase()] + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
function fr24Table(page, need) {
  for (const t of page.tables || []) {
    const head = (t[0] || []).map(h => h.replace(/\s+/g, ' ').trim().toUpperCase());
    if (need.every(n => head.includes(n))) return { head, rows: t.slice(1) };
  }
  return null;
}
// local "6:00 AM" on date "2026-11-02" at airport -> ISO
function fr24Time(t, ymd, code) {
  if (!t || !ymd || !/\d{1,2}:\d{2}\s*[AP]M/i.test(t)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  return localToIso(`${t.match(/\d{1,2}:\d{2}\s*[AP]M/i)[0]}, ${MON[m - 1]} ${d}`, code, Date.UTC(y, m - 1, d, 12));
}

// Flight page: which aircraft (tail) flies UA<num> from depapt on date. -> "N14503" | null
function parseFr24Flight(page, depapt, ymd) {
  const t = fr24Table(page, ['DATE', 'FROM', 'TO', 'AIRCRAFT']);
  if (!t) return null;
  const i = k => t.head.indexOf(k);
  for (const r of t.rows) {
    if (fr24Date(r[i('DATE')]) !== ymd || code3(r[i('FROM')]) !== depapt) continue;
    const m = String(r[i('AIRCRAFT')] || '').match(/\((N[0-9A-Z]{1,5})\)/i);
    return m ? m[1].toUpperCase() : null;      // no tail yet = not assigned
  }
  return null;
}

// Aircraft page: the plane's flights, oldest first. -> [{ number, from, to, depIso, arrIso, status }]
function parseFr24Aircraft(page) {
  const t = fr24Table(page, ['DATE', 'FROM', 'TO', 'FLIGHT', 'STD', 'STA']);
  if (!t) return null;
  const i = k => t.head.indexOf(k);
  const legs = [];
  for (const r of t.rows) {
    const ymd = fr24Date(r[i('DATE')]);
    const from = code3(r[i('FROM')]), to = code3(r[i('TO')]);
    const fm = String(r[i('FLIGHT')] || '').match(/^UA(\d{1,4})$/i);
    if (!ymd || !from || !to) continue;
    const depIso = fr24Time(r[i('STD')], ymd, from);
    const arrIso = depIso && AIRPORT_TZ[to] ? localOnOrAfter(r[i('STA')], localDate(depIso, to), to, Date.parse(depIso)) : null;
    legs.push({ number: fm ? String(parseInt(fm[1], 10)) : null, ident: r[i('FLIGHT')] || '', from, to, depIso, arrIso, status: r[i('STATUS')] || '' });
  }
  return legs.filter(l => l.depIso).sort((a, b) => Date.parse(a.depIso) - Date.parse(b.depIso));
}

// ---------- JetBlue points search (award availability for a route and date) ----------
function jetblueUrl(from, to, ymd) {
  const [y, m, d] = ymd.split('-');
  return `${base('jetblue')}/booking/flights?from=${from}&to=${to}&depart=${m}/${d}/${y}` +
    '&isMultiCity=false&noOfRoute=1&adults=1&children=0&infants=0&usePoints=true';
}
// -> { status: 'available' | 'none' | 'unknown', options: [...], minPoints, nonstop, ownFlight }
//    ownFlight: the delayed flight itself if it is bookable with points (flightNum like "5132")
function parseJetBlue(page, ownNumber) {
  const lines = String(page.text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const starts = [];
  lines.forEach((l, i) => { if (/^(Nonstop|\d+\s+Stops?)$/i.test(l)) starts.push(i); });
  const options = [];
  starts.forEach((st, k) => {
    const seg = lines.slice(st, k + 1 < starts.length ? starts[k + 1] : st + 40);
    const times = seg.filter(l => /^\d{1,2}:\d{2}\s*[ap]m$/i.test(l));
    const fi = seg.findIndex(l => /^Options from$/i.test(l));
    const ptsLine = (fi >= 0 ? seg.slice(fi, fi + 3) : seg).find(l => /[\d,]+\s*pts/i.test(l));
    const fee = seg.find(l => /^\+\$[\d.,]+$/.test(l));
    // "United UA 51321" -> UA 5132 (a footnote digit is glued on); United numbers have at most 4 digits
    // A footnote marker can be glued on: "United UA 51321" + next line "1Equipment and crew by..." = UA 5132
    const flights = [];
    seg.forEach((l, li) => {
      const foot = (seg[li + 1] || '').match(/^(\d)[A-Za-z]/);
      const ms = [...l.matchAll(/\b(UA|B6)\s?(\d{1,5})\b/g)];
      ms.forEach((m, mi) => {
        let n = m[2];
        if (n.length > 4) n = n.slice(0, 4);
        else if (foot && mi === ms.length - 1 && n.length > 1 && n.endsWith(foot[1]) && /\d$/.test(l)) n = n.slice(0, -1);
        flights.push(m[1] + n);
      });
    });
    if (!ptsLine) return;
    options.push({
      stops: /^nonstop$/i.test(seg[0]) ? 0 : parseInt(seg[0], 10),
      dep: times[0] || null, arr: times[1] || null,
      flights: [...new Set(flights)],
      points: parseInt(ptsLine.match(/([\d,]+)\s*pts/i)[1].replace(/,/g, ''), 10),
      fee: fee || null
    });
  });
  if (!options.length) {
    const none = /no (available )?flights|no flights (are )?available|sold out|no results/i.test(page.text || '');
    return { status: none ? 'none' : 'unknown', options: [], minPoints: null, nonstop: 0, ownFlight: null };
  }
  const own = ownNumber ? options.find(o => o.flights.includes('UA' + ownNumber)) || null : null;
  return {
    status: 'available',
    options,
    minPoints: Math.min(...options.map(o => o.points)),
    nonstop: options.filter(o => o.stops === 0).length,
    ownFlight: own ? { points: own.points, fee: own.fee } : null
  };
}

// ---------- AirNav Radar (tail by flight; a plane's "Future" flights) ----------
const airnavFlightUrl = num => `${base('airnav')}/data/flights/UA${num}`;
const airnavAircraftUrl = tail => `${base('airnav')}/data/registration/${String(tail).toUpperCase()}`;

// Rows look like (one value per line):
//   Nov 4 | UA1572 | UAL1572 | Denver | KDEN | DEN | 09:40 MST | [ATD] | Phoenix | KPHX | PHX | 11:44 MST | [type] | [N12345] | Estimated | 02h04m
// -> [{ ymd, number, from, to, depIso, arrIso, tail, status }]
function parseAirnavRows(page, nowMs = Date.now()) {
  const L = String(page.text || '').split('\n').map(x => x.trim()).filter(Boolean);
  const out = [];
  const t12 = s => { const m = s.match(/^(\d{1,2}):(\d{2})/); if (!m) return null; let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };
  for (let i = 0; i < L.length - 10; i++) {
    const dm = L[i].match(/^([A-Z][a-z]{2})\s+(\d{1,2})$/);
    const fm = (L[i + 1] || '').match(/^UA(\d{1,4})$/);
    if (!dm || !fm || MON_IDX[dm[1].toUpperCase()] === undefined) continue;
    const seg = L.slice(i + 2, i + 20);
    const end = seg.findIndex((x, k) => k > 4 && /^[A-Z][a-z]{2}\s+\d{1,2}$/.test(x) && /^UA\d+$/.test(seg[k + 1] || ''));
    const row = end > 0 ? seg.slice(0, end) : seg;
    const icao = row.map((x, k) => /^[A-Z0-9]{4}$/.test(x) && /^[A-Z0-9]{3}$/.test(row[k + 1] || '') ? k : -1).filter(k => k >= 0);
    if (icao.length < 2) continue;
    const from = row[icao[0] + 1], to = row[icao[1] + 1];
    const std = row.slice(icao[0] + 2, icao[1]).find(x => /^\d{1,2}:\d{2}\s+[A-Z]{3,4}$/.test(x));
    const sta = row.slice(icao[1] + 2).find(x => /^\d{1,2}:\d{2}\s+[A-Z]{3,4}$/.test(x));
    const tailTok = row.slice(icao[1] + 2).find(x => /^N[0-9][0-9A-Z]{0,4}$/.test(x));
    const status = row.slice(icao[1] + 2).find(x => /^(Estimated|Scheduled|Landed|En Route|Delayed|Cancel|Diverted|Departed)/i.test(x)) || '';
    // year: the one that puts the date closest to now
    const mo = MON_IDX[dm[1].toUpperCase()], d = +dm[2], y0 = new Date(nowMs).getUTCFullYear();
    const y = [y0 - 1, y0, y0 + 1].sort((a, b) => Math.abs(Date.UTC(a, mo, d) - nowMs) - Math.abs(Date.UTC(b, mo, d) - nowMs))[0];
    const ymd = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const depIso = std && AIRPORT_TZ[from] ? fr24Time(t12(std), ymd, from) : null;
    const arrIso = depIso && sta && AIRPORT_TZ[to] ? localOnOrAfter(t12(sta), localDate(depIso, to), to, Date.parse(depIso)) : null;
    out.push({ ymd, number: String(parseInt(fm[1], 10)), from, to, depIso, arrIso, tail: tailTok || null, status });
  }
  return out;
}
// Flight page -> tail of UA<num> leaving depapt on ymd (null if not assigned / not shown)
function parseAirnavFlight(page, depapt, ymd) {
  const r = parseAirnavRows(page).find(x => x.from === depapt && x.ymd === ymd);
  return r && r.tail ? r.tail : null;
}
// Aircraft page -> the plane's flights, oldest first
function parseAirnavAircraft(page) {
  const seen = new Set();
  return parseAirnavRows(page).filter(l => l.depIso && !seen.has(l.number + l.depIso) && seen.add(l.number + l.depIso))
    .sort((a, b) => Date.parse(a.depIso) - Date.parse(b.depIso));
}

// ---------- adsb.lol (open ADS-B data: callsign -> registration of the plane flying it now) ----------
// United mainline flies as UAL<n>; United Express partners fly the same number under their own
// callsign (e.g. SkyWest UA5528 = SKW5528), so Express numbers try those prefixes too.
const EXPRESS_PREFIXES = (process.env.FV_EXPRESS_CALLSIGNS || 'SKW,RPA,GJS,ASH,UCA,AWI').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const adsbCallsignUrl = cs => `${base('adsb')}/v2/callsign/${cs}`;
function adsbCallsigns(num) {
  const n = parseInt(num, 10);
  return n >= 3000 ? [...EXPRESS_PREFIXES.map(p => p + n), 'UAL' + n] : ['UAL' + n];
}
// All aircraft within 250 nm of an airport in one request (covers every airline's callsign at once).
function adsbPointUrl(code) {
  const g = GEO[code];
  return g ? `${base('adsb')}/v2/point/${g[0]}/${g[1]}/250` : null;
}
// -> Map(callsign -> { tail, type, callsign, onGround }) | null
function parseAdsbAll(page) {
  let j;
  try { j = JSON.parse(page.text || ''); } catch { return null; }
  const m = new Map();
  for (const x of j.ac || []) {
    const cs = String(x.flight || '').trim().toUpperCase();
    if (cs && /^N[0-9][0-9A-Z]{0,4}$/i.test(String(x.r || ''))) m.set(cs, { tail: String(x.r).toUpperCase(), type: x.t || null, callsign: cs, onGround: x.alt_baro === 'ground' });
  }
  return m;
}
// -> { tail, type, callsign, onGround } | null
function parseAdsb(page, callsign) {
  let j;
  try { j = JSON.parse(page.text || ''); } catch { return null; }
  const a = (j.ac || []).find(x => String(x.flight || '').trim().toUpperCase() === callsign && /^N[0-9][0-9A-Z]{0,4}$/i.test(String(x.r || '')));
  return a ? { tail: String(a.r).toUpperCase(), type: a.t || null, callsign, onGround: a.alt_baro === 'ground' } : null;
}

module.exports = {
  adsbCallsignUrl, adsbCallsigns, parseAdsb, adsbPointUrl, parseAdsbAll,
  airnavFlightUrl, airnavAircraftUrl, parseAirnavRows, parseAirnavFlight, parseAirnavAircraft,
  jetblueUrl, parseJetBlue,
  fr24FlightUrl, fr24AircraftUrl, parseFr24Flight, parseFr24Aircraft,
  boardUrl, parseBoard, routeUrl, parseRoute, unitedUrl, parseUnited, tailForFleet,
  faHistoryUrl, parseFaHistory, localDate, timeNearest, icaoToIata, distanceMi, MAX_UA_NUMBER
};
