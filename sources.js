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
  for (const dd of [-1, 0, 1]) {
    const d = new Date(nowMs + dd * 86400000);
    const [y, m, day] = localDate(d.toISOString(), code).split('-').map(Number);
    const iso = localToIso(`${tm}, ${MON[m - 1]} ${day}`, code, Date.UTC(y, m - 1, day, 12));
    if (iso && (best === null || Math.abs(Date.parse(iso) - nowMs) < Math.abs(Date.parse(best) - nowMs))) best = iso;
  }
  return best;
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
function parseFaHistory(page, tail) {
  const tbl = (page.tables || []).find(t => t[0] && /origin/i.test(t[0].join(' ')) && /destination/i.test(t[0].join(' ')) && /departure/i.test(t[0].join(' ')));
  if (!tbl) return null;
  const rowLinks = (page.links || []).map(a => a.href.match(/\/live\/flight\/[^/]+\/history\/(\d{8})\/(\d{4})Z\/([A-Z0-9]{4})\/([A-Z0-9]{4})/)).filter(Boolean);
  const legs = [];
  tbl.slice(1).forEach((row, idx) => {
    const lm = rowLinks[idx];
    if (!lm || row.length < 6) return;
    const from = icaoToIata(lm[3], row[2]);
    const to = icaoToIata(lm[4], row[3]);
    if (!from || !to) return;
    const d = lm[1], hm = lm[2];
    const depMs = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +hm.slice(0, 2), +hm.slice(2, 4));
    // arrival "07:35PM MST" is local at destination; place it on/after the departure
    let arrIso = null;
    const am = (row[5] || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
    if (am && AIRPORT_TZ[to]) {
      const depLocal = localDate(new Date(depMs).toISOString(), to);
      const [y, m, day] = depLocal.split('-').map(Number);
      let a = Date.parse(localToIso(`${+am[1]}:${am[2]} ${am[3]}M, ${MON[m - 1]} ${day}`, to, Date.UTC(y, m - 1, day, 12)));
      if (a < depMs) a += 86400000;
      arrIso = new Date(a).toISOString();
    }
    legs.push({ from, to, depIso: new Date(depMs).toISOString(), arrIso, status: row[6] || '' });
  });
  return legs.sort((a, b) => Date.parse(a.depIso) - Date.parse(b.depIso));
}

module.exports = {
  boardUrl, parseBoard, routeUrl, parseRoute, unitedUrl, parseUnited, tailForFleet,
  faHistoryUrl, parseFaHistory, localDate, timeNearest, icaoToIata, distanceMi, MAX_UA_NUMBER
};
