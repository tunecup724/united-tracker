// fetchers.js - loads pages for the discovery search (FlightView, United, FlightAware website).
//
// Each site has its own switch; all are OFF unless set to "true" in Railway:
//   FLIGHTVIEW_LIVE, UNITED_LIVE, FLIGHTAWARE_WEB_LIVE, FR24_LIVE, JETBLUE_LIVE, AIRNAV_LIVE, ADSB_LIVE
// FV_FIXTURE_DIR (testing): read saved pages from a folder instead of any website.
//
// Speed settings (per site): FV_CONCURRENCY pages at once (default 2) and at least
// FV_PAGE_GAP_MS between page starts (default 1000). FV_LIGHT_PAGES=false loads images/fonts/video.
// Every URL is downloaded at most once per search (shared even between concurrent tasks).
// The first CAPTCHA / block page on any site stops all further requests.

const fs = require('fs');
const path = require('path');

class BlockedError extends Error {}
class DisabledError extends Error {}
class LimitError extends Error {}
class SiteBlockedError extends Error {}   // one site refused or challenged us; stop using that site this search

const envInt = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) && v >= 0 ? v : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SOURCES = {
  flightview:  { flag: 'FLIGHTVIEW_LIVE',      short: 'fv' },
  united:      { flag: 'UNITED_LIVE',          short: 'ua' },
  flightaware: { flag: 'FLIGHTAWARE_WEB_LIVE', short: 'fa' },
  fr24:        { flag: 'FR24_LIVE',            short: 'fr' },
  jetblue:     { flag: 'JETBLUE_LIVE',         short: 'jb' },
  airnav:      { flag: 'AIRNAV_LIVE',          short: 'an' },
  adsb:        { flag: 'ADSB_LIVE',            short: 'ad' }
};
const REAL_BASE = { flightview: 'https://www.flightview.com', united: 'https://www.united.com', flightaware: 'https://www.flightaware.com', fr24: 'https://www.flightradar24.com', jetblue: 'https://www.jetblue.com', airnav: 'https://www.airnavradar.com', adsb: 'https://api.adsb.lol' };
// Test-only base URL overrides (point a source at a local test server).
const TEST_ENV = { flightview: 'FV_TEST_BASE_URL', united: 'UA_TEST_BASE_URL', flightaware: 'FA_TEST_BASE_URL', fr24: 'FR24_TEST_BASE_URL', jetblue: 'JB_TEST_BASE_URL', airnav: 'AN_TEST_BASE_URL', adsb: 'AD_TEST_BASE_URL' };
const base = src => (process.env[TEST_ENV[src]] || REAL_BASE[src]).replace(/\/$/, '');

function sourceMode(src) {
  if (process.env.FV_FIXTURE_DIR) return 'fixtures';
  return process.env[SOURCES[src].flag] === 'true' ? 'live' : 'disabled';
}

function speedConfig() {
  return {
    concurrency: Math.max(1, envInt('FV_CONCURRENCY', 2)),
    gapMs: envInt('FV_PAGE_GAP_MS', 1000),
    lightPages: process.env.FV_LIGHT_PAGES !== 'false'
  };
}

function fixtureKey(src, url) {
  const u = new URL(url, 'http://x');
  const q = [...u.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');
  return (SOURCES[src].short + u.pathname + (q ? '?' + q : '')).replace(/[^A-Za-z0-9=&?._-]+/g, '_') + '.json';
}

const BLOCK_PATTERNS = /captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|access denied|request (has been )?blocked|press (and|&) hold|checking your browser|verifying your browser|pardon our interruption|just a moment\.\.\./i;

function checkBlocked(src, page) {
  if (page.status && [401, 403, 407, 429, 451, 503].includes(page.status)) throw new BlockedError(`${src}: HTTP ${page.status} - stopped`);
  if (BLOCK_PATTERNS.test((page.text || '').slice(0, 5000))) throw new BlockedError(`${src}: CAPTCHA / verification page - stopped`);
}

// One loader per search. get(src, url) -> Promise<{ status, text, links, tables }>
function createLoader({ onPage = () => {}, maxPages = 1500 } = {}) {
  const sp = speedConfig();
  const fixDir = process.env.FV_FIXTURE_DIR || '';
  const fixDelay = envInt('FV_FIXTURE_DELAY_MS', 0);
  const cache = new Map();                 // url -> Promise(page)
  const counts = { flightview: 0, united: 0, flightaware: 0, fr24: 0, jetblue: 0, airnav: 0, adsb: 0 };
  const active = {}, waiters = {}, nextStart = {};
  let total = 0, blocked = null, loaded = 0;
  const loadedUrls = new Set();
  const siteBlocked = {};                  // united / flightaware: refused or challenged -> skip for the rest of the search
  let browser = null, context = null, launching = null;

  async function acquire(src) {
    active[src] = active[src] || 0; waiters[src] = waiters[src] || [];
    while (active[src] >= sp.concurrency) await new Promise(r => waiters[src].push(r));
    active[src]++;
    const gap = src === 'adsb' ? envInt('FV_ADSB_GAP_MS', 2000) : sp.gapMs;
    if (sourceMode(src) === 'live' && gap) {                 // space page starts on each site
      const now = Date.now(), start = Math.max(now, nextStart[src] || 0);
      nextStart[src] = start + gap;
      if (start > now) await sleep(start - now);
    }
  }
  function release(src) { active[src]--; const w = waiters[src].shift(); if (w) w(); }

  async function ensureBrowser() {
    if (context) return context;
    if (!launching) launching = (async () => {
      let pw;
      try { pw = require('playwright'); } catch { throw new Error('Live retrieval needs the "playwright" package'); }
      const opts = { headless: true, args: ['--disable-dev-shm-usage'] };
      if (process.env.FV_CHROMIUM_PATH) opts.executablePath = process.env.FV_CHROMIUM_PATH;
      browser = await pw.chromium.launch(opts);
      context = await browser.newContext();
      if (sp.lightPages) {
        // Skip pictures, video and fonts - the text and tables load the same.
        await context.route('**/*', r => ['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue());
      }
      return context;
    })();
    return launching;
  }

  // adsb.lol is an open JSON API: plain HTTPS request, no browser needed
  async function liveJson(url) {
    for (let attempt = 0; ; attempt++) {
      const r = await liveJsonOnce(url);
      if (r.status !== 429 || attempt >= envInt('FV_ADSB_RETRIES', 3)) return r;
      const wait = (parseInt(r.retryAfter, 10) || 0) * 1000 || envInt('FV_ADSB_RETRY_MS', 15000) * (attempt + 1);
      await sleep(Math.min(wait, 60000));                    // "too many requests": slow down, then try again
    }
  }
  async function liveJsonOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'united-delay-tracker (personal, on-demand)', Accept: 'application/json' } });
      return { status: r.status, retryAfter: r.headers.get('retry-after'), text: await r.text(), links: [], tables: [] };
    } catch (e) {
      const err = new Error(`connection refused (${e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message})`);
      err.refused = e.name !== 'AbortError'; throw err;
    } finally { clearTimeout(timer); }
  }

  async function live(url) {
    const ctx = await ensureBrowser();
    const page = await ctx.newPage();
    try {
      let resp;
      try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
      catch (e) {
        const code = (String(e.message).match(/net::ERR_[A-Z0-9_]+/) || [])[0];
        if (code && !/TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED/.test(code)) {
          const err = new Error(`connection refused (${code})`); err.refused = true; throw err;
        }
        throw new Error(String(e.message).split('\n')[0]);
      }
      const status = resp ? resp.status() : 0;
      if (status < 400) {
        // JetBlue's results load slowly; give them longer and wait specifically for them
        const kind = /jetblue\.com/.test(url) || (process.env.JB_TEST_BASE_URL && url.startsWith(process.env.JB_TEST_BASE_URL)) ? 'jb'
          : /airnavradar\.com/.test(url) || (process.env.AN_TEST_BASE_URL && url.startsWith(process.env.AN_TEST_BASE_URL)) ? 'an' : '';
        await page.waitForFunction(k => {
          const t = document.body ? document.body.innerText : '';
          if (/captcha|verify you are human|verifying your browser|access denied/i.test(t)) return true;
          if (k === 'jb') return /Options from|no flights|not available/i.test(t);
          if (k === 'an') return /\bUAL\d+\b|Not found|No flights/i.test(t);
          return document.querySelector('table tr td') || /FLIGHT STATUS|Aircraft details/i.test(t);
        }, kind, { timeout: kind === 'jb' ? 30000 : 15000 }).catch(() => {});
      }
      return await page.evaluate(st => ({
        status: st,
        text: document.body ? document.body.innerText : '',
        links: [...document.querySelectorAll('a[href]')].slice(0, 400).map(a => ({ text: a.innerText.trim(), href: a.href })),
        tables: [...document.querySelectorAll('table')].slice(0, 10).map(t => [...t.rows].slice(0, 1500).map(r => [...r.cells].map(c => c.innerText.trim())))
      }), status);
    } finally { await page.close().catch(() => {}); }
  }

  function fixture(src, url) {
    const tryFiles = [fixtureKey(src, url)];
    const all = path.join(fixDir, `${SOURCES[src].short}__ALL.json`);            // testing: one page for every URL of a site
    if (fs.existsSync(all)) tryFiles.unshift(`${SOURCES[src].short}__ALL.json`);
    if (src === 'flightview') {                       // simple names used by tests
      const m = url.match(/\/flight-tracker\/([A-Z0-9]{2})\/(\d+)/);
      if (m) tryFiles.push(`${m[1]}${m[2]}.json`);
    }
    for (const f of tryFiles) {
      const p = path.join(fixDir, f);
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (d.netError) { const err = new Error(`connection refused (${d.netError})`); err.refused = true; throw err; }   // testing
        return { tables: [], links: [], ...d };
      }
    }
    return { status: 404, text: '', links: [], tables: [] };
  }

  return {
    counts,
    get total() { return loaded; },                       // pages actually loaded
    get uniqueUrls() { return loadedUrls.size; },
    get blocked() { return blocked; },
    get siteBlocked() { return { ...siteBlocked }; },
    get(src, url) {
      if (blocked) return Promise.reject(new BlockedError(blocked));
      if (siteBlocked[src]) return Promise.reject(new SiteBlockedError(siteBlocked[src]));
      if (cache.has(url)) return cache.get(url);              // never download the same page twice
      const mode = sourceMode(src);
      if (mode === 'disabled') return Promise.reject(new DisabledError(`${src} live retrieval is off`));
      if (total >= maxPages) return Promise.reject(new LimitError(`page limit (${maxPages}) reached`));
      total++;                                               // reserve a slot under the page limit
      const p = (async () => {
        await acquire(src);
        try {
          if (blocked) { total--; throw new BlockedError(blocked); }
          if (siteBlocked[src]) { total--; throw new SiteBlockedError(siteBlocked[src]); }
          loaded++; counts[src]++; loadedUrls.add(url);
          onPage(src, url, loaded);
          if (mode === 'fixtures' && fixDelay) await sleep(fixDelay);
          let page;
          try {
            page = mode === 'fixtures' ? fixture(src, url) : src === 'adsb' ? await liveJson(url) : await live(url);
            checkBlocked(src, page);
          } catch (e) {
            if (!(e instanceof BlockedError) && !e.refused) throw e;           // ordinary error (e.g. timeout): just this page
            const msg = e.refused ? `${src}: ${e.message} - stopped using ${src}` : e.message;
            if (src === 'flightview') { blocked = blocked || msg; throw new BlockedError(msg); }   // FlightView: stop the search
            siteBlocked[src] = siteBlocked[src] || msg;                                          // United / FlightAware: stop that site
            throw new SiteBlockedError(msg);
          }
          return page;
        } finally { release(src); }
      })();
      cache.set(url, p);
      return p;
    },
    async close() { if (browser) await browser.close().catch(() => {}); browser = null; context = null; }
  };
}

module.exports = { createLoader, sourceMode, speedConfig, fixtureKey, base, BlockedError, DisabledError, LimitError, SiteBlockedError, SOURCES };
