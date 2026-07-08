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

const TURNAROUND_MIN = 35; // minimum minutes to unload/board a domestic narrowbody

function fmtTime(isoStr, timezone) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: timezone || 'America/New_York'
    });
  } catch { return '—'; }
}

async function getInboundFlight(faFlightId) {
  try {
    const r = await axios.get(`${FA_URL}/flights/${faFlightId}`, {
      headers: { 'x-apikey': FA_KEY },
      timeout: 8000
    });
    return r.data?.flights?.[0] || null;
  } catch(e) {
    return null;
  }
}

async function fetchAllOperatorFlights() {
  const allFlights = [];
  const r = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
    headers: { 'x-apikey': FA_KEY },
    params: { max_pages: 20 },
    timeout: 30000
  });
  allFlights.push(...(r.data?.scheduled || []));

  let nextLink = r.data?.links?.next;
  let pageCount = 1;
  while (nextLink && pageCount < 10) {
    const cursorMatch = nextLink.match(/cursor=([^&]+)/);
    if (!cursorMatch) break;
    await new Promise(r => setTimeout(r, 300));
    const r2 = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
      headers: { 'x-apikey': FA_KEY },
      params: { max_pages: 20, cursor: cursorMatch[1] },
      timeout: 30000
    });
    allFlights.push(...(r2.data?.scheduled || []));
    nextLink = r2.data?.links?.next;
    pageCount++;
  }
  return allFlights;
}

function baseEligible(f, now) {
  const ident = f.ident_iata || f.ident || '';
  if (!ident.startsWith('UA')) return false;

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
    flightNum: f.ident_iata || f.ident || '—',
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
    risk,
    _estDepIso: f.estimated_out || f.estimated_off || f.scheduled_out,
    _schedDepIso: f.scheduled_out,
    _inboundId: f.inbound_fa_flight_id || null,
    _tz: tz,
    ...extra
  };
}

// Attach inbound info + compute slip prediction
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

  // SLIP PREDICTION: inbound est arrival + turnaround vs estimated departure
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

app.get('/api/delays', async (req, res) => {
  try {
    const now = new Date();
    const raw = await fetchAllOperatorFlights();

    // Dedupe
    const seen = new Set();
    const deduped = raw.filter(f => {
      const key = `${f.ident_iata||f.ident}-${f.scheduled_out}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const eligible = deduped.filter(f => baseEligible(f, now));

    // GROUP A: Already delayed 30+ min
    const delayed = eligible
      .filter(f => (f.departure_delay || 0) >= 1800)
      .map(f => mapFlight(f, { predicted: false }));

    // GROUP B: Not delayed yet, departing within next 3 hours, has inbound — candidates for predicted delay
    const candidates = eligible
      .filter(f => {
        const depDelay = f.departure_delay || 0;
        if (depDelay >= 1800) return false;
        if (!f.inbound_fa_flight_id) return false;
        const minsUntil = (new Date(f.scheduled_out) - now) / 60000;
        return minsUntil <= 180; // next 3 hours only, to limit API calls
      })
      .map(f => mapFlight(f, { predicted: true }));

    // Attach inbound info in parallel chunks of 5
    const all = [...delayed, ...candidates];
    for (let i = 0; i < all.length; i += 5) {
      await Promise.all(all.slice(i, i + 5).map(f => attachInbound(f)));
    }

    // Keep candidates ONLY if inbound math predicts 30+ min effective delay vs scheduled dep
    const predicted = candidates.filter(f => {
      if (!f.inboundEstArr || f.inboundLanded) return false;
      // predicted ready time vs SCHEDULED departure
      const inbEstArrIso = null; // use slip fields computed against est dep; recompute vs sched:
      return f.willSlip && f.slipMins >= 1 &&
        // effective delay vs scheduled departure must be >= 30 min
        (() => {
          const schedDep = new Date(f._schedDepIso).getTime();
          const estDep = new Date(f._estDepIso).getTime();
          const readyTime = estDep + f.slipMins * 60000;
          return (readyTime - schedDep) / 60000 >= 30;
        })();
    });

    const finalList = [...delayed, ...predicted]
      .map(f => {
        // cleanup internal fields
        const { _estDepIso, _schedDepIso, _inboundId, _tz, ...clean } = f;
        return clean;
      })
      .sort((a, b) => {
        const r = { high: 0, med: 1, low: 2 };
        return (r[a.risk] - r[b.risk]) || (b.depDelay - a.depDelay);
      });

    res.json({
      success: true,
      data: finalList,
      total: deduped.length,
      confirmedDelays: delayed.length,
      predictedDelays: predicted.length,
      timestamp: new Date().toISOString()
    });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
