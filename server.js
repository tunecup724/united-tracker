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
const REFRESH_INTERVAL_MIN = 30;
const CALL_GAP_MS = 9000;
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 20000;
const SCAN_TIMEOUT_MS = 45 * 60 * 1000;

const QUIET_START_HOUR = 2;
const QUIET_END_HOUR = 8;

const OPERATORS = ['UAL', 'SKW', 'RPA', 'GJS', 'AWI'];

let cache = {
  data: [], total: 0, confirmedDelays: 0, predictedDelays: 0,
  lastUpdated: null, refreshing: false, refreshStartedAt: null,
  lastError: null, operatorStats: {}, quietHours: false, rateLimitHits: 0,
  scanProgress: ''
};

function isQuietHours() {
  const etHour = parseInt(new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false
  }));
  return etHour >= QUIET_START_HOUR && etHour < QUIET_END_HOUR;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastCallTime = 0;
async function throttledGet(url, params, attempt = 0) {
  const wait = CALL_GAP_MS - (Date.now() - lastCallTime);
  if (wait > 0) await sleep(wait);
  lastCallTime = Date.now();
  try {
    return await axios.get(url, { headers: { 'x-apikey': FA_KEY }, params, timeout: 30000 });
  } catch (e) {
    const status = e.response?.status;
    if (status === 429 && attempt < MAX_RETRIES) {
      cache.rateLimitHits++;
      const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
      console.warn(`429 - backing off ${backoff/1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
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

async function fetchOperatorFlights(operator, maxPageLoops = 40) {
  const flights = [];
  let error = null;
  try {
    const r = await throttledGet(`${FA_URL}/operators/${operator}/flights/scheduled`, { max_pages: 20 });
    flights.push(...(r.data?.scheduled || []));
    let nextLink = r.data?.links?.next;
    let loops = 1;
    while (nextLink && loops < maxPageLoops) {
      const cursorMatch = nextLink.match(/cursor=([^&]+)/);
      if (!cursorMatch) break;
      try {
        const r2 = await throttledGet(`${FA_URL}/operators/${operator}/flights/scheduled`, { max_pages: 20, cursor: cursorMatch[1] });
        const batch = r2.data?.scheduled || [];
        flights.push(...batch);
        nextLink = r2.data?.links?.next;
        cache.scanProgress = `${operator}: ${flights.length} flights fetched`;
        if (batch.length === 0) break;
      } catch (pageErr) {
        error = pageErr.response?.status ? `HTTP ${pageErr.response.status} (partial)` : pageErr.message;
        break;
      }
      loops++;
    }
  } catch(e) {
    error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
  }
  return { flights, error };
}

function baseEligible(f, now) {
  if (!f._uaIdent) return false;
  const statusLower = (f.status || '').toLowerCase();
  if (f.actual_off) return false;
  if (statusLower.includes('taxiing') || statusLower.includes('en route') ||
      statusLower.includes('landed') || statusLower.includes('arrived')) return false;
  if (!f.scheduled_out) return false;
  const minsUntilSchedDep = (new Date(f.scheduled_out) - now) / 60000;
  if (minsUntilSchedDep < 30) return false;
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

function commitToCache(confirmedList, predictedList, totalScanned, stats) {
  const finalList = [...confirmedList, ...predictedList].sort((a, b) => {
    const r = { high: 0, med: 1, low: 2 };
    return (r[a.risk] - r[b.risk]) || (b.depDelay - a.depDelay);
  });
  cache.data = finalList;
  cache.total = totalScanned;
  cache.confirmedDelays = confirmedList.length;
  cache.predictedDelays = predictedList.length;
  cache.lastUpdated = new Date().toISOString();
  cache.operatorStats = stats;
}

async function refreshCache() {
  if (isQuietHours()) {
    cache.quietHours = true;
    console.log('Quiet hours - skipping scan');
    return;
  }
  cache.quietHours = false;

  if (cache.refreshing) {
    const running = cache.refreshStartedAt ? (Date.now() - cache.refreshStartedAt) : 0;
    if (running < SCAN_TIMEOUT_MS) return;
    console.warn(`Abandoning stuck scan (${Math.round(running/60000)}m)`);
  }
  cache.refreshing = true;
  cache.refreshStartedAt = Date.now();
  cache.rateLimitHits = 0;
  cache.scanProgress = 'starting';
  console.log('Scan started', new Date().toISOString());

  // Accumulators that persist across the whole scan
  const allConfirmed = [];
  const allCandidates = [];
  const stats = {};
  const seen = new Set();
  let totalScanned = 0;

  try {
    // PHASE 1: fetch each operator, commit results as we go
    for (const op of OPERATORS) {
      cache.scanProgress = `fetching ${op}`;
      const { flights, error } = await fetchOperatorFlights(op);

      const uaFlights = [];
      for (const f of flights) {
        const uaIdent = getUAIdent(f);
        if (uaIdent) { f._uaIdent = uaIdent; uaFlights.push(f); }
      }
      stats[op] = { fetched: flights.length, uaCoded: uaFlights.length, error: error || null };

      const now = new Date();
      const deduped = uaFlights.filter(f => {
        const key = `${f._uaIdent}-${f.scheduled_out}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      totalScanned += deduped.length;

      const eligible = deduped.filter(f => baseEligible(f, now));

      eligible
        .filter(f => (f.departure_delay || 0) >= 1800)
        .forEach(f => allConfirmed.push(mapFlight(f, { predicted: false })));

      eligible
        .filter(f => (f.departure_delay || 0) < 1800 && f.inbound_fa_flight_id)
        .forEach(f => allCandidates.push(mapFlight(f, { predicted: true })));

      // COMMIT NOW - confirmed delays visible immediately after each operator
      commitToCache(allConfirmed, [], totalScanned, stats);
      console.log(`${op} done: ${allConfirmed.length} confirmed so far, ${totalScanned} scanned`);
      cache.scanProgress = `${op} done - ${allConfirmed.length} confirmed`;
    }

    // PHASE 2: inbound lookups for confirmed delays first (most useful)
    cache.scanProgress = 'checking inbounds for confirmed delays';
    for (let i = 0; i < allConfirmed.length; i++) {
      await attachInbound(allConfirmed[i]);
      if (i % 5 === 0) {
        commitToCache(allConfirmed, [], totalScanned, stats);
        cache.scanProgress = `inbound ${i + 1}/${allConfirmed.length} (confirmed)`;
      }
    }
    commitToCache(allConfirmed, [], totalScanned, stats);

    // PHASE 3: inbound lookups for predicted candidates, committing progressively
    const predicted = [];
    cache.scanProgress = `checking ${allCandidates.length} candidates for predicted delays`;
    for (let i = 0; i < allCandidates.length; i++) {
      const f = allCandidates[i];
      await attachInbound(f);
      if (f.inboundEstArr && !f.inboundLanded && f.willSlip) {
        const schedDep = new Date(f.schedDepIso).getTime();
        const estDep = new Date(f.estDepIso).getTime();
        const readyTime = estDep + f.slipMins * 60000;
        if ((readyTime - schedDep) / 60000 >= 30) predicted.push(f);
      }
      if (i % 5 === 0) {
        commitToCache(allConfirmed, predicted, totalScanned, stats);
        cache.scanProgress = `inbound ${i + 1}/${allCandidates.length} (predicted) - ${predicted.length} found`;
      }
    }

    commitToCache(allConfirmed, predicted, totalScanned, stats);
    cache.lastError = null;
    cache.scanProgress = 'complete';
    console.log(`Scan complete: ${allConfirmed.length} confirmed, ${predicted.length} predicted, ${totalScanned} scanned, ${cache.rateLimitHits} backoffs`);
  } catch(e) {
    cache.lastError = e.message + (e.response?.status ? ` (HTTP ${e.response.status})` : '');
    console.error('Scan failed:', e.message);
    // keep whatever was committed
  } finally {
    cache.refreshing = false;
    cache.refreshStartedAt = null;
  }
}

function liveFilter(list) {
  const now = Date.now();
  return list.filter(f => {
    if (!f.estDepIso) return true;
    return new Date(f.estDepIso).getTime() > now;
  });
}

app.get('/api/delays', (req, res) => {
  const live = liveFilter(cache.data);
  res.json({
    success: true,
    data: live,
    total: cache.total,
    confirmedDelays: live.filter(f => !f.predicted).length,
    predictedDelays: live.filter(f => f.predicted).length,
    lastUpdated: cache.lastUpdated,
    refreshing: cache.refreshing,
    quietHours: isQuietHours(),
    rateLimitHits: cache.rateLimitHits,
    scanProgress: cache.scanProgress,
    lastError: cache.lastError,
    operatorStats: cache.operatorStats,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/force-refresh', (req, res) => {
  cache.refreshing = false;
  cache.refreshStartedAt = null;
  refreshCache();
  res.json({ success: true, message: 'Scan started. Confirmed delays appear within a few minutes.' });
});

app.get('/api/keytest', async (req, res) => {
  const out = {};
  try {
    const r = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
      headers: { 'x-apikey': FA_KEY }, params: { max_pages: 1 }, timeout: 20000
    });
    out.operatorTest = { status: r.status, count: (r.data?.scheduled || []).length };
  } catch(e) {
    out.operatorTest = { error: e.response?.status || e.message };
  }
  out.keyPreview = FA_KEY ? `${FA_KEY.slice(0,4)}...${FA_KEY.slice(-4)}` : 'MISSING';
  res.json(out);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshCache();
  setInterval(refreshCache, REFRESH_INTERVAL_MIN * 60 * 1000);
});
