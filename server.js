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

async function getInboundFlight(faFlightId, tz) {
  try {
    const r = await axios.get(`${FA_URL}/flights/${faFlightId}`, {
      headers: { 'x-apikey': FA_KEY },
      timeout: 10000
    });
    const f = r.data?.flights?.[0];
    if (!f) return null;
    return {
      inboundFlightNum: f.ident_iata || f.ident || '—',
      inboundOrigin: f.origin?.code_iata || '—',
      inboundSchedArr: fmtTime(f.scheduled_in, tz),
      inboundEstArr: fmtTime(f.estimated_in || f.estimated_on, tz),
      inboundActualArr: fmtTime(f.actual_in || f.actual_on, tz),
      inboundStatus: f.status || '—'
    };
  } catch(e) {
    return null;
  }
}

app.get('/api/delays', async (req, res) => {
  try {
    const now = new Date();
    const allFlights = [];

    // Fetch all pages using max_pages to get as many as possible in one call
    const r = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
      headers: { 'x-apikey': FA_KEY },
      params: { max_pages: 20 },
      timeout: 30000
    });

    const flights = r.data?.scheduled || [];
    allFlights.push(...flights);

    // If there are more pages, follow the cursor
    let nextLink = r.data?.links?.next;
    let pageCount = 1;

    while (nextLink && pageCount < 10) {
      const cursorMatch = nextLink.match(/cursor=([^&]+)/);
      if (!cursorMatch) break;
      const cursor = cursorMatch[1];

      await new Promise(r => setTimeout(r, 500));

      const r2 = await axios.get(`${FA_URL}/operators/UAL/flights/scheduled`, {
        headers: { 'x-apikey': FA_KEY },
        params: { max_pages: 20, cursor },
        timeout: 30000
      });

      const more = r2.data?.scheduled || [];
      allFlights.push(...more);
      nextLink = r2.data?.links?.next;
      pageCount++;
      if (more.length === 0) break;
    }

    const filtered = allFlights
      .filter(f => {
        const depDelay = f.departure_delay || 0;
        if (depDelay < 1800) return false;

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
      })
      .map(f => {
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
          inboundFlightId: f.inbound_fa_flight_id || null,
          originTz: tz,
          risk
        };
      })
      .sort((a, b) => {
        const r = { high: 0, med: 1, low: 2 };
        return r[a.risk] - r[b.risk] || b.depDelay - a.depDelay;
      });

    // Fetch inbound flight details
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i].inboundFlightId) {
        const inbound = await getInboundFlight(filtered[i].inboundFlightId, filtered[i].originTz);
        if (inbound) filtered[i] = { ...filtered[i], ...inbound };
        await new Promise(r => setTimeout(r, 300));
      }
    }

    res.json({
      success: true,
      data: filtered,
      total: allFlights.length,
      pages_fetched: pageCount,
      timestamp: new Date().toISOString()
    });
  } catch(e) {
    res.json({ success: false, error: e.message, details: e.response?.data });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
