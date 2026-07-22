const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const FA_KEY = '7s7aNdZg9AzDzG3QA5oJ0GdpaCpjjTdt';
const FA_URL = 'https://aeroapi.flightaware.com/aeroapi';

const TURNAROUND_MIN = 35;
const REFRESH_INTERVAL_MIN = 30;
const CALL_GAP_MS = 7000; // 7s between every API call to stay under 10 req/min

// United mainline + active regional carriers (CPZ removed — defunct)
const OPERATORS = ['UAL', 'SKW', 'RPA', 'GJS', 'AWI'];

let cache = {
  data: [],
  total: 0,
  confirmedDelays: 0,
  predictedDelays: 0,
  lastUpdated: null,
  refreshing: false,
  lastError: null,
  operatorStats: {}
};

// Single shared throttle — guarantees CALL_GAP_MS between ANY two API calls
let lastCallTime = 0;
async function throttledGet(url, params) {
  const wait = CALL_GAP_MS - (Date.now() - lastCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallTime = Date.now();
  return axios.get(url, { headers: { 'x-apikey': FA_KEY }, params, timeout: 30000 });
}

function fmtTime(isoStr, timezone) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: timezone || 'America/New_York'
    });
  } catch { return '—'; }
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
  } catch(e) {
    return null;
  }
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
      const r2 = await throttledGet(`${FA_URL}/operators/${operator}/flights/scheduled`, { max_pages: 20, cursor: cursorMatch[1] });
      const batch = r2.data?.scheduled || [];
      flights.push(...batch);
      nextLink = r2.data?.links?.next;
      loops++;
      if (batch.length === 0) break;
    }
  } catch(e) {
    error = e.response?.status ? `HTTP ${e.response.status}` : e.message;
  }
  return { flights, error };
}

async function fetchAllFlights() {
  const all = [];
  const stats = {};
  for (const op of OPERATORS) {
    const { flights, error } = await fetchOperatorFlights(op);
    const uaFlights = [];
    for (const f of flights) {
      const uaIdent = getUAIdent(f);
      if (uaIdent) {
        f._uaIdent = uaIdent;
        uaFlights.push(f);
      }
    }
    stats[op] = { fetched: flights.length, uaCoded: uaFlights.length, error: error || null };
    all.push(...uaFlights);
  }
  return { flights: all, stats };
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
    operatedAs: f.ident_iata || f.ident || '—',
    depAirport: f.origin?.code_iata || '—',
    dest: f.destination?.code_iata || '—',
    gate: f.gate_origin || '—',
    terminal: f.terminal_origin || '—',
    schedDep: fmtTime(f.scheduled_out, tz),
    estDep: fmtTime(f.estimated_out || f.estimated_off, tz),
    schedArr: fmtTime(f.scheduled_in, f.destination?.timezone),
    estArr: fmtTime(f.estimated_in, f.destination?.timezone),
    duration: durMins,
    depDelay: depDelayMins,
    arrDelay: arrDelayMins,
    status: f.status || '—',
    operatedBy: f.operator || '—',
    risk,
    _estDepIso: f.estimated_out || f.estimated_off || f.scheduled_out,
    _schedDepIso: f.scheduled_out,
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

  flight.inboundFlightNum = inb.ident_iata || inb.ident || '—';
  flight.inboundOrigin = inb.origin?.code_iata || '—';
  flight.inboundSchedArr = fmtTime(inb.scheduled_in, tz);
  flight.inboundEstArr = fmtTime(inbEstArrIso, tz);
  flight.inboundActualArr = fmtTime(inb.actual_in || inb.actual_on, tz);
  flight.inboundLanded = !!(inb.actual_in || inb.actual_on);

  if (inbEstArrIso && flight._estDepIso && !flight.inboundLanded) {
    const readyTime = new Date(inbEstArrIso).getTime() + TURNAROUND_MIN * 60000;
    const estDepTime = new Date(flight._estDepIso).getTime();
    const slipMins = Math.round((readyTime - estDepTime) / 60000);
    if (slipMins > 0) {
      flight.willSlip = true;
      flight.slipMins = slipMins;
    } else {
      flight.willSlip = false;
    }
  }
  return flight;
}

async function refreshCache() {
  if (cache.refreshing) return;
  cache.refreshing = true;
  console.log('Cache refresh started at', new Date().toISOString());

  try {
    const now = new Date();
    const { flights: raw, stats } = await fetchAllFlights();

    const seen = new Set();
    const deduped = raw.filter(f => {
      const key = `${f._uaIdent}-${f.scheduled_out}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const eligible = deduped.filter(f => baseEligible(f, now));

    const delayed = eligible
      .filter(f => (f.departure_delay || 0) >= 1800)
      .map(f => mapFlight(f, { predicted: false }));

    const candidates = eligible
      .filter(f => {
        const depDelay = f.departure_delay || 0;
        if (depDelay >= 1800) return false;
        if (!f.inbound_fa_flight_id) return false;
        return true;
      })
      .map(f => mapFlight(f, { predicted: true }));

    const all = [...delayed, ...candidates];
    for (const f of all) {
      await attachInbound(f);
    }

    const predicted = candidates.filter(f => {
      if (!f.inboundEstArr || f.inboundLanded) return false;
      if (!f.willSlip) return false;
      const schedDep = new Date(f._schedDepIso).getTime();
      const estDep = new Date(f._estDepIso).getTime();
      const readyTime = estDep + f.slipMins * 60000;
      return (readyTime - schedDep) / 60000 >= 30;
    });

    const finalList = [...delayed, ...predicted]
      .map(f => {
        const { _estDepIso, _schedDepIso, _inboundId, _tz, ...clean } = f;
        return clean;
      })
      .sort((a, b) => {
        const r = { high: 0, med: 1, low: 2 };
        return (r[a.risk] - r[b.risk]) || (b.depDelay - a.depDelay);
      });

    cache.data = finalList;
    cache.total = deduped.length;
    cache.confirmedDelays = delayed.length;
    cache.predictedDelays = predicted.length;
    cache.lastUpdated = new Date().toISOString();
    cache.lastError = null;
    cache.operatorStats = stats;

    console.log(`Cache refreshed: ${delayed.length} confirmed, ${predicted.length} predicted, ${deduped.length} UA flights scanned`);
    console.log('Operator breakdown:', JSON.stringify(stats));
  } catch(e) {
    cache.lastError = e.message + (e.response?.status ? ` (HTTP ${e.response.status})` : '');
    console.error('Cache refresh failed:', e.message);
  } finally {
    cache.refreshing = false;
  }
}

app.get('/api/delays', (req, res) => {
  res.json({
    success: true,
    data: cache.data,
    total: cache.total,
    confirmedDelays: cache.confirmedDelays,
    predictedDelays: cache.predictedDelays,
    lastUpdated: cache.lastUpdated,
    refreshing: cache.refreshing,
    lastError: cache.lastError,
    operatorStats: cache.operatorStats,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/force-refresh', async (req, res) => {
  refreshCache();
  res.json({ success: true, message: 'Refresh started in background. Full scan takes 10-15 min.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshCache();
  setInterval(refreshCache, REFRESH_INTERVAL_MIN * 60 * 1000);
});
