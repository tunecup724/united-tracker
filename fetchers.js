// fetchers.js - loads pages for the discovery search (FlightView, United, FlightAware website).
//
// Each site has its own switch; all are OFF unless set to "true" in Railway:
//   FLIGHTVIEW_LIVE, UNITED_LIVE, FLIGHTAWARE_WEB_LIVE
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

const envInt = (n, d) => { const v = parseInt(process.env[n], 10); return Number.isFinite(v) && v >= 0 ? v : d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SOURCES = {
  flightview:  { flag: 'FLIGHTVIEW_LIVE',      short: 'fv' },
  united:      { flag: 'UNITED_LIVE',          short: 'ua' },
  flightaware: { flag: 'FLIGHTAWARE_WEB_LIVE', short: 'fa' }
};
const REAL_BASE = { flightview: 'https://www.flightview.com', united: 'https://www.united.com', flightaware: 'https://www.flightaware.com' };
// Test-only base URL overrides (point a source at a local test server).
const TEST_ENV = { flightview: 'FV_TEST_BASE_URL', united: 'UA_TEST_BASE_URL', flightaware: 'FA_TEST_BASE_URL' };
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

const BLOCK_PATTERNS = /captcha|verify (that )?you are (a )?human|are you a robot|unusual traffic|access denied|request (has been )?blocked|press (and|&) hold|checking your browser|pardon our interruption/i;

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
  const counts = { flightview: 0, united: 0, flightaware: 0 };
  const active = {}, waiters = {}, nextStart = {};
  let total = 0, blocked = null;
  let browser = null, context = null, launching = null;

  async function acquire(src) {
    active[src] = active[src] || 0; waiters[src] = waiters[src] || [];
    while (active[src] >= sp.concurrency) await new Promise(r => waiters[src].push(r));
    active[src]++;
    if (sourceMode(src) === 'live' && sp.gapMs) {           // space page starts on each site
      const now = Date.now(), start = Math.max(now, nextStart[src] || 0);
      nextStart[src] = start + sp.gapMs;
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

  async function live(url) {
    const ctx = await ensureBrowser();
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const status = resp ? resp.status() : 0;
      if (status < 400) {
        await page.waitForFunction(() => {
          const t = document.body ? document.body.innerText : '';
          return document.querySelector('table tr td') || /FLIGHT STATUS|Aircraft details|captcha|verify you are human|access denied/i.test(t);
        }, null, { timeout: 15000 }).catch(() => {});
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
    if (src === 'flightview') {                       // simple names used by tests
      const m = url.match(/\/flight-tracker\/([A-Z0-9]{2})\/(\d+)/);
      if (m) tryFiles.push(`${m[1]}${m[2]}.json`);
    }
    for (const f of tryFiles) {
      const p = path.join(fixDir, f);
      if (fs.existsSync(p)) return { tables: [], links: [], ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
    return { status: 404, text: '', links: [], tables: [] };
  }

  return {
    counts,
    get total() { return total; },
    get uniqueUrls() { return cache.size; },
    get blocked() { return blocked; },
    get(src, url) {
      if (blocked) return Promise.reject(new BlockedError(blocked));
      if (cache.has(url)) return cache.get(url);              // never download the same page twice
      const mode = sourceMode(src);
      if (mode === 'disabled') return Promise.reject(new DisabledError(`${src} live retrieval is off`));
      if (total >= maxPages) return Promise.reject(new LimitError(`page limit (${maxPages}) reached`));
      total++; counts[src]++;
      const p = (async () => {
        await acquire(src);
        try {
          if (blocked) throw new BlockedError(blocked);
          onPage(src, url, total);
          if (mode === 'fixtures' && fixDelay) await sleep(fixDelay);
          const page = mode === 'fixtures' ? fixture(src, url) : await live(url);
          try { checkBlocked(src, page); } catch (e) { blocked = blocked || e.message; throw e; }
          return page;
        } finally { release(src); }
      })();
      cache.set(url, p);
      return p;
    },
    async close() { if (browser) await browser.close().catch(() => {}); browser = null; context = null; }
  };
}

module.exports = { createLoader, sourceMode, speedConfig, fixtureKey, base, BlockedError, DisabledError, LimitError, SOURCES };
