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

// United hubs + focus cities in ICAO format
const AIRPORTS = [
  'KORD','KEWR','KIAH','KDEN','KSFO','KLAX','KIAD','KMIA','KBOS','KSEA',
  'KATL','KDFW','KPHX','KMCO','KSLC','KSAN','KDCA','KTPA','KAUS','KBNA',
  'KLAS','KMSP','KPDX','KCLT','KRDU','KSTL','KMCI','KIND','KCMH','KPIT'
];

function fmtTime(isoStr, timezone) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: timezone || 'America/New_York'
    });
  } catch { return '—'; }
}

function fmtDur(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function fetchAirportDepartures(airport) {
  try {
    const r = await axios.get(`${FA_URL}/airports/${airport}/flights/scheduled_departures`, {
      headers: { 'x-apikey': FA_KEY },
      params: { max_pages: 1 },
      timeout: 10000
    });
    return r.data?.departures || r.data?.flights || [];
  } catch(e) {
    console.warn(`Failed ${airport}:`, e.message);
    return [];
  }
}

app.get('/api/test', async (req, res) => {
  try {
    const flights = await fetchAirportDepartures('KORD');
    const sample = flights.slice(0, 3).map(f => ({
      ident: f.ident_iata || f.ident,
      dep: f.origin?.code_iata,
      arr: f.destination?.code_iata,
      operator: f.operator_iata,
      departure_delay: f.departure_delay,
      status: f.status,
      actual_off: f.actual_off,
      estimated_off: f.estimated_off,
      scheduled_out: f.scheduled_out,
      scheduled_in: f.scheduled_in
    }));
    res.json({ total: flights.length, sample });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/api/delays', async (req, res) => {
  try {
    const now = new Date();
    const allFlights = [];

    // Fetch airports in batches of 5
    for (let i = 0; i < AIRPORTS.length; i += 5) {
      const batch = AIRPORTS.slice(i, i + 5);
      const results = await Promise.all(batch.map(ap => fetchAirportDepartures(ap)));
      results.forEach(flights => allFlights.push(...flights));
      if (i + 5 < AIRPORTS.length) await new Promise(r => setTimeout(r, 300));
    }

    const filtered = allFlights
      .filter(f => {
        // Must be United Airlines
        if (f.operator_iata !== 'UA') return false;

        // Must have 30+ min departure delay (delay is in seconds)
        const depDelay = f.departure_delay || 0;
        if (depDelay < 1800) return false;

        // Must not have actually departed
        if (f.actual_off) return false;

        // Estimated departure must be in the future
        const estDep = f.estimated_off || f.estimated_out || f.scheduled_out;
        if (!estDep || new Date(estDep) <= now) return false;

        // Duration must be <= 2 hours
        if (!f.scheduled_out || !f.scheduled_in) return false;
        const durMins = (new Date(f.scheduled_in) - new Date(f.scheduled_out)) / 60000;
        if (durMins > 120 || durMins <= 0) return false;

        return true;
      })
      .map(f => {
        const tz = f.origin?.timezone || 'America/New_York';
        const depDelayMins = Math.round((f.departure_delay || 0) / 60);
        const arrDelayMins = Math.round((f.arrival_delay || 0) / 60);
        const durMins = Math.round((new Date(f.scheduled_in) - new Date(f.scheduled_out)) / 60000);

        let risk;
        if (depDelayMins >= 90 || arrDelayMins >= 60) risk = 'high';
        else if (depDelayMins >= 45 || arrDelayMins >= 25) risk = 'med';
        else risk = 'low';

        return {
          flightNum: f.ident_iata || f.ident || '—',
          depAirport: f.origin?.code_iata || '—',
          dest: f.destination?.code_iata || '—',
          gate: f.gate_origin || '—',
          terminal: f.terminal_origin || '—',
          schedDep: fmtTime(f.scheduled_out, tz),
          estDep: fmtTime(f.estimated_off || f.estimated_out, tz),
          schedArr: fmtTime(f.scheduled_in, f.destination?.timezone),
          estArr: fmtTime(f.estimated_in, f.destination?.timezone),
          duration: durMins,
          depDelay: depDelayMins,
          arrDelay: arrDelayMins,
          status: f.status || '—',
          inboundFlightId: f.inbound_fa_flight_id || null,
          risk
        };
      })
      .sort((a, b) => {
        const r = { high: 0, med: 1, low: 2 };
        return r[a.risk] - r[b.risk] || b.depDelay - a.depDelay;
      });

    res.json({ 
      success: true, 
      data: filtered, 
      total: allFlights.length,
      airports_scanned: AIRPORTS.length,
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
