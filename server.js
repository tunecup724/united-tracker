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

app.get('/api/delays', async (req, res) => {
  try {
    // Get all scheduled United departures
    const response = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
      headers: { 'x-apikey': FA_KEY },
      params: { max_pages: 5 },
      timeout: 15000
    });

    const flights = response.data.flights || [];
    const now = new Date();

    const filtered = flights
      .filter(f => {
        // Must have departure delay of 30+ mins
        const depDelay = f.departure_delay || 0;
        if (depDelay < 1800) return false; // FlightAware delay is in seconds

        // Must not have actually departed yet
        if (f.actual_off) return false;

        // Estimated departure must be in the future
        const estDep = f.estimated_off || f.scheduled_out;
        if (!estDep) return false;
        if (new Date(estDep) <= now) return false;

        // Duration must be <= 2 hours
        const schedOut = f.scheduled_out;
        const schedIn = f.scheduled_in;
        if (!schedOut || !schedIn) return false;
        const durMins = (new Date(schedIn) - new Date(schedOut)) / 60000;
        if (durMins > 120) return false;

        return true;
      })
      .map(f => {
        const tz = f.origin?.timezone || 'America/New_York';
        const depDelaySecs = f.departure_delay || 0;
        const arrDelaySecs = f.arrival_delay || 0;
        const depDelayMins = Math.round(depDelaySecs / 60);
        const arrDelayMins = Math.round(arrDelaySecs / 60);

        const schedOut = f.scheduled_out;
        const schedIn = f.scheduled_in;
        const durMins = schedOut && schedIn
          ? Math.round((new Date(schedIn) - new Date(schedOut)) / 60000)
          : null;

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

    res.json({ success: true, data: filtered, total: flights.length, timestamp: new Date().toISOString() });
  } catch(e) {
    res.json({ success: false, error: e.message, details: e.response?.data });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
