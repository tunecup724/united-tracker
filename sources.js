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
    const arrIso = AIRPORT_TZ[to] ? localOnOrAfter(row[5], localDate(new Date(depMs).toISOString(), to), to, depMs) : null;
    legs.push({ from, to, depIso: new Date(depMs).toISOString(), arrIso, status: row[6] || '' });
  });
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

module.exports = {
  jetblueUrl, parseJetBlue,
  fr24FlightUrl, fr24AircraftUrl, parseFr24Flight, parseFr24Aircraft,
  boardUrl, parseBoard, routeUrl, parseRoute, unitedUrl, parseUnited, tailForFleet,
  faHistoryUrl, parseFaHistory, localDate, timeNearest, icaoToIata, distanceMi, MAX_UA_NUMBER
};
