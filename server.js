const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const FA_KEY = process.env.FA_KEY || 'oJr6tdNWilpJRBsIrnTzKDQpXJFfqwyl';
const FA_URL = 'https://aeroapi.flightaware.com/aeroapi';

const TURNAROUND_MIN = 35;
const AUTO_INTERVAL_MIN = 30;
const CALL_GAP_MS = 9000;
const MAX_RETRIES = 4;
const BACKOFF_BASE_MS = 20000;
const SCAN_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_DATA_AGE_MS = 2 * 60 * 60 * 1000;   // discard cache older than 2 hours

const MAX_PAGE_LOOPS = 8;
const HORIZON_HOURS = 14;

const OPERATORS = ['UAL', 'SKW', 'RPA', 'GJS', 'AWI'];

let autoMode = false;          // OFF by default - no scans unless asked
let autoTimer = null;

let cache = {
  data: [], total: 0, confirmedDelays: 0, predictedDelays: 0,
  lastUpdated: null, refreshing: false, refreshStartedAt: null,
  lastError: null, operatorStats: {}, rateLimitHits: 0, scanProgress: ''
};

let acc = { confirmed: [], predicted: [], candidates: [], seen: new Set(), totalScanned: 0, stats: {} };

const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastCallTime = 0;
async function throttledGet(url, params, attempt = 0) {
  const wait = CALL_GAP_MS - (Date.now() - lastCallTime);
  if (wait > 0) await sleep(wait);
  lastCallTime = Date.now();
  try {
    return await axios.get(url, { headers: { 'x-apikey': FA_KEY }, params, timeout: 30000 });
  } catch (e) {
    if (e.response?.status === 429 && attempt < MAX_RETRIES) {
      cache.rateLimitHits++;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`429 - backing off ${backoff/1000}s`);
      await sleep(backoff);
      lastCallTime = 0;
      return throttledGet(url, params, attempt + 1);
    }
    throw e;
  }
}

function fmtTime(isoStr, timezone) {
  if (!isoStr) return '-';
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: timezone || 'America/New_York'
    });
  } catch { return '-'; }
}

function getUAIdent(f) {
  const iata = f.ident_iata || '';
  if (iata.startsWith('UA')) return iata;
  const cs = f.codeshares_iata || [];
  const ua = cs.find(c => typeof c === 'string' && c.startsWith('UA'));
  return ua || null;
}

async function getInboundFlight(faFlightId) {
  try {
    const r = await throttledGet(`${FA_URL}/flights/${faFlightId}`, {});
    return r.data?.flights?.[0] || null;
  } catch(e) { return null; }
}

function baseEligible(f, now) {
  if (!f._uaIdent) return false;
  const s = (f.status || '').toLowerCase();
  if (f.actual_off) return false;
  if (s.includes('taxiing') || s.includes('en route') || s.includes('landed') || s.includes('arrived')) return false;
  if (!f.scheduled_out) return false;
  if ((new Date(f.scheduled_out) - now) / 60000 < 30) return false;
  if (!f.scheduled_in) return false;
  const durMins = (new Date(f.scheduled_in) - new Date(f.scheduled_out)) / 60000;
  if (durMins > 130 || durMins <= 0) return false;
  return true;
}

function mapFlight(f, extra = {}) {
  const tz = f.origin?.timezone || 'America/New_York';
  const depDelayMins = Math.round((f.departure_delay || 0) / 60);
  const arrDelayMins = Math.round((f.arrival_delay || 0) / 60);
  const durMins = Math.round((new Date(f.scheduled_in) - new Date(f.scheduled_out)) / 60000);
  let risk;
  if (depDelayMins >= 90) risk = 'high';
  else if (depDelayMins >= 45) risk = 'med';
  else risk = 'low';
  return {
    flightNum: f._uaIdent,
    operatedAs: f.ident_iata || f.ident || '-',
    depAirport: f.origin?.code_iata || '-',
    dest: f.destination?.code_iata || '-',
    gate: f.gate_origin || '-',
    terminal: f.terminal_origin || '-',
    schedDep: fmtTime(f.scheduled_out, tz),
    estDep: fmtTime(f.estimated_out || f.estimated_off, tz),
    schedArr: fmtTime(f.scheduled_in, f.destination?.timezone),
    estArr: fmtTime(f.estimated_in, f.destination?.timezone),
    duration: durMins,
    depDelay: depDelayMins,
    arrDelay: arrDelayMins,
    status: f.status || '-',
    operatedBy: f.operator || '-',
    risk,
    estDepIso: f.estimated_out || f.estimated_off || f.scheduled_out,
    schedDepIso: f.scheduled_out,
    _inboundId: f.inbound_fa_flight_id || null,
    _tz: tz,
    ...extra
  };
}

async function attachInbound(flight) {
  if (!flight._inboundId) return flight;
  const inb = await getInboundFlight(flight._inboundId);
  if (!inb) return flight;
  const tz = flight._tz;
  const inbEstArrIso = inb.estimated_in || inb.estimated_on || inb.scheduled_in;
  flight.inboundFlightNum = inb.ident_iata || inb.ident || '-';
  flight.inboundOrigin = inb.origin?.code_iata || '-';
  flight.inboundSchedArr = fmtTime(inb.scheduled_in, tz);
  flight.inboundEstArr = fmtTime(inbEstArrIso, tz);
  flight.inboundActualArr = fmtTime(inb.actual_in || inb.actual_on, tz);
  flight.inboundLanded = !!(inb.actual_in || inb.actual_on);
  if (inbEstArrIso && flight.estDepIso && !flight.inboundLanded) {
    const readyTime = new Date(inbEstArrIso).getTime() + TURNAROUND_MIN * 60000;
    const estDepTime = new Date(flight.estDepIso).getTime();
    const slipMins = Math.round((readyTime - estDepTime) / 60000);
    if (slipMins > 0) { flight.willSlip = true; flight.slipMins = slipMins; }
    else { flight.willSlip = false; }
  }
  return flight;
}

function commit() {
  cache.data = [...acc.confirmed, ...acc.predicted].sort((a, b) => {
    const r = { high: 0, med: 1, low: 2 };
    return (r[a.risk] - r[b.risk]) || (b.depDelay - a.depDelay);
  });
  cache.total = acc.totalScanned;
  cache.confirmedDelays = acc.confirmed.length;
  cache.predictedDelays = acc.predicted.length;
  cache.lastUpdated = new Date().toISOString();
  cache.operatorStats = acc.stats;
}

function ingest(flights, now) {
  for (const f of flights) {
    const uaIdent = getUAIdent(f);
    if (!uaIdent) continue;
    f._uaIdent = uaIdent;
    const key = `${uaIdent}-${f.scheduled_out}`;
    if (acc.seen.has(key)) continue;
    acc.seen.add(key);
    acc.totalScanned++;
    if (!baseEligible(f, now)) continue;
    if ((f.departure_delay || 0) >= 1800) {
      acc.confirmed.push(mapFlight(f, { predicted: false }));
    } else if (f.inbound_fa_flight_id) {
      acc.candidates.push(mapFlight(f, { predicted: true }));
    }
  }
  commit();
}

async function fetchOperatorProgressive(operator) {
  let fetched = 0;
  let error = null;
  const horizonMs = Date.now() + HORIZON_HOURS * 3600 * 1000;
  try {
    const r = await throttledGet(`${FA_URL}/operators/${operator}/flights/scheduled`, { max_pages: 20 });
    let batch = r.data?.scheduled || [];
    fetched += batch.length;
    ingest(batch, new Date());
    cache.scanProgress = `${operator}: ${fetched} fetched, ${acc.confirmed.length} confirmed`;

    let nextLink = r.data?.links?.next;
    let loops = 1;
    while (nextLink && loops < MAX_PAGE_LOOPS) {
      const cursorMatch = nextLink.match(/cursor=([^&]+)/);
      if (!cursorMatch) break;
      try {
        const r2 = await throttledGet(`${FA_URL}/operators/${operator}/flights/scheduled`, { max_pages: 20, cursor: cursorMatch[1] });
        batch = r2.data?.scheduled || [];
        if (batch.length === 0) break;
        fetched += batch.length;
        ingest(batch, new Date());
        cache.scanProgress = `${operator}: ${fetched} fetched, ${acc.confirmed.length} confirmed`;
        const lastSched = batch[batch.length - 1]?.scheduled_out;
        if (lastSched && new Date(lastSched).getTime() > horizonMs) break;
        nextLink = r2.data?.links?.next;
      } catch (pageErr) {
        error = pageErr.response?.status ? `HTTP ${pageErr.response.status} (partial)` : pageErr.message;
        break;
      }
      loops++;
    }
  } catch(e) {
    error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
  }
  acc.stats[operator] = { fetched, error: error || null };
  commit();
}

async function runScan() {
  if (cache.refreshing) {
    const running = cache.refreshStartedAt ? (Date.now() - cache.refreshStartedAt) : 0;
    if (running < SCAN_TIMEOUT_MS) return;
    console.warn('Abandoning stuck scan');
  }
  cache.refreshing = true;
  cache.refreshStartedAt = Date.now();
  cache.rateLimitHits = 0;
  cache.scanProgress = 'starting';
  acc = { confirmed: [], predicted: [], candidates: [], seen: new Set(), totalScanned: 0, stats: {} };
  console.log('Scan started', new Date().toISOString());

  try {
    for (const op of OPERATORS) {
      await fetchOperatorProgressive(op);
    }

    cache.scanProgress = `inbound lookups for ${acc.confirmed.length} confirmed`;
    for (let i = 0; i < acc.confirmed.length; i++) {
      await attachInbound(acc.confirmed[i]);
      if (i % 3 === 0) {
        commit();
        cache.scanProgress = `inbound ${i + 1}/${acc.confirmed.length} (confirmed)`;
      }
    }
    commit();

    cache.scanProgress = `checking ${acc.candidates.length} candidates`;
    for (let i = 0; i < acc.candidates.length; i++) {
      const f = acc.candidates[i];
      await attachInbound(f);
      if (f.inboundEstArr && !f.inboundLanded && f.willSlip) {
        const schedDep = new Date(f.schedDepIso).getTime();
        const estDep = new Date(f.estDepIso).getTime();
        const readyTime = estDep + f.slipMins * 60000;
        if ((readyTime - schedDep) / 60000 >= 30) acc.predicted.push(f);
      }
      if (i % 3 === 0) {
        commit();
        cache.scanProgress = `inbound ${i + 1}/${acc.candidates.length} (predicted) - ${acc.predicted.length} found`;
      }
    }

    commit();
    cache.lastError = null;
    cache.scanProgress = 'complete';
    console.log(`Scan complete: ${acc.confirmed.length} confirmed, ${acc.predicted.length} predicted`);
  } catch(e) {
    cache.lastError = e.message + (e.response?.status ? ` (HTTP ${e.response.status})` : '');
    console.error('Scan failed:', e.message);
  } finally {
    cache.refreshing = false;
    cache.refreshStartedAt = null;
  }
}

// Drop departed flights AND anything from a stale (2h+) scan
function liveData() {
  if (!cache.lastUpdated) return [];
  const age = Date.now() - new Date(cache.lastUpdated).getTime();
  if (age > MAX_DATA_AGE_MS) return [];
  const now = Date.now();
  return cache.data.filter(f => {
    if (!f.estDepIso) return true;
    return new Date(f.estDepIso).getTime() > now;
  });
}

function setAuto(on) {
  autoMode = !!on;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (autoMode) {
    runScan();
    autoTimer = setInterval(runScan, AUTO_INTERVAL_MIN * 60 * 1000);
    console.log('AUTO mode ON');
  } else {
    console.log('AUTO mode OFF');
  }
}

app.get('/api/delays', (req, res) => {
  const live = liveData();
  const age = cache.lastUpdated ? Date.now() - new Date(cache.lastUpdated).getTime() : null;
  res.json({
    success: true,
    data: live,
    total: cache.total,
    confirmedDelays: live.filter(f => !f.predicted).length,
    predictedDelays: live.filter(f => f.predicted).length,
    lastUpdated: cache.lastUpdated,
    dataStale: age !== null && age > MAX_DATA_AGE_MS,
    refreshing: cache.refreshing,
    autoMode,
    rateLimitHits: cache.rateLimitHits,
    scanProgress: cache.scanProgress,
    lastError: cache.lastError,
    operatorStats: cache.operatorStats,
    timestamp: new Date().toISOString()
  });
});

// Manual single scan
app.post('/api/scan', (req, res) => {
  runScan();
  res.json({ success: true, message: 'Scan started' });
});
app.get('/api/scan', (req, res) => {
  runScan();
  res.json({ success: true, message: 'Scan started' });
});

// Toggle auto mode
app.post('/api/auto', (req, res) => {
  const on = req.query.on === 'true' || req.body?.on === true;
  setAuto(on);
  res.json({ success: true, autoMode });
});
app.get('/api/auto', (req, res) => {
  if (req.query.on !== undefined) setAuto(req.query.on === 'true');
  res.json({ success: true, autoMode });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} - AUTO mode OFF, manual scans only`);
  // No scan on startup - costs nothing until you ask
});
