// KSL Classifieds collector for Deal Finder.
// Used only for the one-time baseline sweep, single listing detail fetches and backup mode when the
// KSL alert emails stop. Logged-out public pages only. Politeness rules (all enforced here):
//   - robots.txt read at start; disallowed paths are skipped
//   - one request at a time, randomized 3–8 s delays, descriptive user agent
//   - hard page-load cap per run (Apps Script also enforces ~200/day)
//   - on 403/429/CAPTCHA/block page: stop immediately and report `blocked` (Apps Script backs off 24 h)
//   - no proxies, no stealth/fingerprint tricks, no retries against a block
import { Actor, log } from 'apify';
import { createRequire } from 'node:module';
import { KSL_BASE, SELECTORS, NO_RESULTS_RX, BLOCKED_RESOURCE_TYPES } from './config.js';

const require = createRequire(import.meta.url);
const P = require('./kslParser.cjs');

await Actor.init();
const input = (await Actor.getInput()) || {};
const {
  mode = 'search',
  zip = '84054',
  searches = [],
  detailIds = [],
  maxPageLoads = 20,
  maxDetailPages = 0,
  sinceDays = 0,
  userAgent = 'DealFinder-personal/1.0 (personal low-volume deal alerts; one request at a time)',
} = input;
const minDelay = Math.max(3, input.minDelaySecs || 3);
const maxDelay = Math.max(minDelay, input.maxDelaySecs || 8);

const out = {
  pageLoads: 0, blocked: false, blockedReason: '', layoutChanged: [], robotsSkipped: [],
  newestIds: {}, completedSearches: [], itemsPushed: 0,
};

class BlockedError extends Error {}

let lastRequestAt = 0;
async function politeWait() {
  const gap = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function budgetLeft() { return maxPageLoads - out.pageLoads; }

async function fetchPage(url) {
  if (budgetLeft() <= 0) return null;
  await politeWait();
  out.pageLoads++;
  const res = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'text/html' }, redirect: 'follow' });
  const html = await res.text();
  if (res.status === 403 || res.status === 429 || P.kslLooksBlocked_(html)) {
    throw new BlockedError(`HTTP ${res.status} / block page on ${url}`);
  }
  return { status: res.status, html };
}

// ---------------------------------------------------------------------------
// robots.txt
// If robots.txt can't be read (network error / 5xx), treat the whole site as disallowed and stop.
let robotsTxt = null;
try {
  lastRequestAt = Date.now();
  const r = await fetch(`${KSL_BASE}/robots.txt`, { headers: { 'User-Agent': userAgent } });
  out.pageLoads++;
  if (r.status === 403 || r.status === 429) throw new BlockedError(`HTTP ${r.status} on robots.txt`);
  if (r.status >= 500) throw new Error(`robots.txt HTTP ${r.status}`);
  robotsTxt = r.ok ? await r.text() : ''; // 404 = no rules
} catch (e) {
  out.blocked = e instanceof BlockedError;
  out.blockedReason = out.blocked ? e.message : '';
  out.error = `robots.txt unavailable (${e.message}); nothing fetched`;
  log.error(out.error);
  await Actor.setValue('OUTPUT', out);
  await Actor.exit();
}
const allowed = (path) => P.kslRobotsAllows_(robotsTxt, userAgent, path);

// ---------------------------------------------------------------------------
// Browser (only for pages 2+)
let browser = null;
async function getBrowserPage() {
  if (!browser) {
    const { chromium } = await import('playwright');
    // PLAYWRIGHT_PROXY is only for local testing behind a corporate/sandbox proxy; on Apify no proxy is used.
    const proxy = process.env.PLAYWRIGHT_PROXY ? { server: process.env.PLAYWRIGHT_PROXY } : undefined;
    browser = await chromium.launch({ headless: true, proxy, executablePath: process.env.CHROMIUM_PATH || undefined });
  }
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const req = route.request();
    if (BLOCKED_RESOURCE_TYPES.includes(req.resourceType())) return route.abort();
    // Count every document / data request to KSL itself toward the page budget.
    if (/\.ksl\.com$/.test(new URL(req.url()).hostname) && ['document', 'fetch', 'xhr'].includes(req.resourceType())) {
      if (budgetLeft() <= 0) return route.abort();
      out.pageLoads++;
    }
    return route.continue();
  });
  return page;
}

async function domCards(page) {
  return page.$$eval(SELECTORS.card, (cards, sel) => cards.map((a) => {
    const priceEl = a.querySelector(sel.cardPrice);
    const img = a.querySelector(sel.cardImage);
    const city = a.querySelector(sel.cardCity);
    return {
      id: a.getAttribute('data-item-id'),
      title: a.getAttribute('aria-label') || '',
      priceText: priceEl ? priceEl.getAttribute('aria-label').replace(/^Price\s*/, '') : '',
      image: img ? img.getAttribute('src') : '',
      city: city ? city.textContent.trim() : '',
    };
  }), SELECTORS);
}

/** Load a search in the browser and scroll to load (pages - 1) more batches. Returns extra items (DOM-only data). */
async function browserMorePages(url, pages, knownIds, stopAtIds) {
  const page = await getBrowserPage();
  try {
    await politeWait();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = resp ? resp.status() : 0;
    if (status === 403 || status === 429 || P.kslLooksBlocked_(await page.content())) throw new BlockedError(`HTTP ${status} / block page (browser) on ${url}`);
    await page.waitForSelector(SELECTORS.card, { timeout: 20000 }).catch(() => {});
    let cards = await domCards(page);
    for (let i = 1; i < pages && budgetLeft() > 0; i++) {
      if (cards.some((c) => stopAtIds.includes(c.id))) break;
      const before = cards.length;
      await politeWait();
      const btn = page.locator(SELECTORS.loadMoreButton).first();
      if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
      else await page.mouse.wheel(0, 20000);
      await page.waitForFunction((args) => document.querySelectorAll(args.sel).length > args.n,
        { sel: SELECTORS.card, n: before }, { timeout: 15000 }).catch(() => {});
      cards = await domCards(page);
      if (P.kslLooksBlocked_(await page.content())) throw new BlockedError(`Block page after scrolling on ${url}`);
      if (cards.length === before) break; // no more results
    }
    return cards.filter((c) => c.id && !knownIds.has(c.id)).map((c) => ({
      deal_id: `ksl:${c.id}`, source: 'KSL', listing_id: c.id, title: c.title, price: P.kslPrice_(c.priceText),
      city: c.city.replace(/,\s*[A-Z]{2}$/, ''), state: (/,\s*([A-Z]{2})$/.exec(c.city) || [])[1] || '',
      url: `${KSL_BASE}/listing/${c.id}`, image_url: c.image, image_urls: c.image ? [c.image] : [], description: '', posted_at: '',
    }));
  } finally {
    await page.context().close();
  }
}

// ---------------------------------------------------------------------------
async function runSearch(s) {
  const url = P.kslSearchUrl_(s, zip);
  const path = new URL(url).pathname;
  if (!allowed(path)) { out.robotsSkipped.push(s.name); return; }
  const res = await fetchPage(url);
  if (!res) return;
  if (res.status !== 200) { log.warning(`${s.name}: HTTP ${res.status}`); return; }
  const parsed = P.parseKslSearchHtml_(res.html);
  const total = parsed.pageInfo ? parsed.pageInfo.total : null;
  if (!parsed.listings.length && total !== 0 && !NO_RESULTS_RX.test(res.html)) {
    out.layoutChanged.push(s.name);
    return;
  }
  const stopAt = new Set((s.stopAtIds || []).map(String));
  let items = [];
  let hitSeen = false;
  for (const it of parsed.listings) {
    if (stopAt.has(it.listing_id)) { hitSeen = true; break; }
    items.push(it);
  }
  out.newestIds[s.name] = parsed.listings.slice(0, 5).map((l) => l.listing_id);

  const pages = Math.max(1, s.maxPages || 1);
  if (pages > 1 && !hitSeen && parsed.pageInfo && parsed.pageInfo.hasNextPage && budgetLeft() > 0) {
    const known = new Set(items.map((i) => i.listing_id));
    const more = await browserMorePages(url, Math.min(pages, budgetLeft() + 1), known, [...stopAt]);
    for (const it of more) { if (stopAt.has(it.listing_id)) break; items.push(it); }
  }
  if (sinceDays > 0) {
    const cutoff = Date.now() - sinceDays * 86400000;
    items = items.filter((i) => !i.posted_at || new Date(i.posted_at).getTime() >= cutoff);
  }
  items.forEach((i) => { i.matched_search = s.name; });
  if (items.length) await Actor.pushData(items);
  out.itemsPushed += items.length;
  out.completedSearches.push(s.name);
  log.info(`${s.name}: ${items.length} new listings (page loads so far ${out.pageLoads})`);
}

async function runDetail(id) {
  const path = `/listing/${id}`;
  if (!allowed(path)) { out.robotsSkipped.push(path); return; }
  const res = await fetchPage(KSL_BASE + path);
  if (!res || res.status !== 200) return;
  const d = P.parseKslDetailHtml_(res.html);
  if (!d) { out.layoutChanged.push(path); return; }
  await Actor.pushData(d);
  out.itemsPushed++;
}

try {
  if (mode === 'details') {
    for (const id of detailIds.slice(0, Math.min(maxDetailPages || detailIds.length, 30))) {
      if (budgetLeft() <= 0) break;
      await runDetail(String(id));
    }
  } else {
    for (const s of searches) {
      if (budgetLeft() <= 0) { log.info('Page budget used up; remaining searches skipped'); break; }
      await runSearch(s);
    }
  }
} catch (e) {
  if (e instanceof BlockedError) {
    out.blocked = true;
    out.blockedReason = e.message;
    log.error(`Stopped: ${e.message}. Not retrying.`);
  } else {
    log.exception(e, 'Collector failed');
    out.error = e.message;
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await Actor.setValue('OUTPUT', out);
  log.info(`Done: ${JSON.stringify(out)}`);
  await Actor.exit();
}
