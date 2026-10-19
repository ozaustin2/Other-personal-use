/**
 * KslCollector.js: Apps Script side of the KSL backup collector.
 *  - one-time baseline sweep and backup polling via the Apify actor (ksl-collector/)
 *  - single public listing-page fetches for descriptions/photos (direct, same politeness rules)
 *  - daily page cap, robots.txt, 24-hour back-off on blocks
 */

var KSL_USER_AGENT = 'DealFinder-personal/1.0 (personal low-volume deal alerts; one request at a time)';

function kslBlocked_() {
  var until = settingStr_('KSL_BLOCKED_UNTIL');
  return until && new Date(until).getTime() > nowMs_();
}

function kslRecordBlock_(reason) {
  var until = new Date(nowMs_() + 24 * 3600000);
  writeSetting_('KSL_BLOCKED_UNTIL', until.toISOString());
  alert_('KSL blocked us, backing off 24 h', reason + '. All KSL page requests are paused until ' + fmtTime_(until) +
    '. Email alerts keep working. Nothing will try to get around the block.');
}

function kslPagesLeft_() {
  return settingNum_('KSL_DAILY_PAGE_CAP') - dailyCount_('kslPages');
}

function kslRobotsTxt_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('kslRobots');
  if (hit !== null) return hit;
  // Unreadable robots.txt (network error / 5xx / 403 / 429) = treat as disallowed; 404 = no rules.
  var r;
  try { r = UrlFetchApp.fetch(KSL_BASE + '/robots.txt', { muteHttpExceptions: true, headers: { 'User-Agent': KSL_USER_AGENT } }); } catch (e) { return null; }
  var code = r.getResponseCode();
  if (code !== 200 && code !== 404) return null;
  var txt = code === 200 ? r.getContentText() : '';
  cache.put('kslRobots', txt.slice(0, 90000), 21600);
  return txt;
}

/** Sleep so consecutive KSL requests are 3–8 s apart (randomized), across executions. */
function kslPoliteWait_() {
  var minS = settingNum_('KSL_MIN_DELAY_S') || 3, maxS = Math.max(minS, settingNum_('KSL_MAX_DELAY_S') || 8);
  var gap = randInt_(minS * 1000, maxS * 1000);
  var since = nowMs_() - Number(prop_('kslLastRequestAt') || 0);
  if (since < gap) Utilities.sleep(gap - since);
  setProp_('kslLastRequestAt', nowMs_());
}

/**
 * Fetch one public listing page and merge description/photos/coordinates into `it`.
 * Always sets it.detail_fetched so we never retry the same listing.
 */
function enrichFromKslDetail_(it) {
  it.detail_fetched = true;
  if (kslBlocked_()) return;
  if (dailyCount_('kslDetail') >= settingNum_('KSL_DETAIL_DAILY_CAP') || kslPagesLeft_() <= 0) return;
  var path = '/listing/' + it.listing_id;
  var robots = kslRobotsTxt_();
  if (robots === null || !kslRobotsAllows_(robots, KSL_USER_AGENT, path)) {
    logEvent_('warn', 'ksl-detail', (robots === null ? 'robots.txt unavailable' : 'robots.txt disallows ' + path) + ', skipped');
    return;
  }
  kslPoliteWait_();
  var resp = UrlFetchApp.fetch(KSL_BASE + path, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': KSL_USER_AGENT } });
  bumpDaily_('kslDetail');
  bumpDaily_('kslPages');
  var code = resp.getResponseCode();
  var html = resp.getContentText();
  if (code === 403 || code === 429 || kslLooksBlocked_(html)) { kslRecordBlock_('HTTP ' + code + ' on ' + path); return; }
  if (code === 404 || code === 410) { it.listing_gone = true; return; }
  if (code !== 200) { logEvent_('warn', 'ksl-detail', 'HTTP ' + code + ' for ' + path); return; }
  var d = parseKslDetailHtml_(html);
  if (!d) { logEvent_('warn', 'ksl-detail', 'KSL layout changed? Could not parse ' + path); return; }
  ['description', 'lat', 'lng', 'condition', 'zip', 'state'].forEach(function (k) { if (d[k]) it[k] = d[k]; });
  if (d.image_urls && d.image_urls.length) it.image_urls = d.image_urls;
  if (!it.image_url && d.image_url) it.image_url = d.image_url;
  if (!it.city && d.city) it.city = d.city;
  if ((it.price === null || it.price === undefined) && d.price !== null) it.price = d.price;
  if (!it.title && d.title) it.title = d.title;
  if (d.posted_at) it.posted_at = d.posted_at;
}

// ---------------------------------------------------------------------------
// Actor runs (baseline + backup mode)

function kslActorInput_(searches, opts) {
  return {
    mode: opts.mode || 'search',
    zip: settingStr_('HOME_ZIP'),
    searches: searches.map(function (s) {
      return {
        name: s.name, type: s.type, category: s.category, subcategory: s.subcategory, keyword: s.keyword,
        radius: s.radius, maxPrice: s.maxPrice, maxPages: s.pages, stopAtIds: s.stopAtIds || []
      };
    }),
    maxPageLoads: opts.maxPageLoads,
    maxDetailPages: opts.maxDetailPages || 0,
    sinceDays: opts.sinceDays || 0,
    minDelaySecs: settingNum_('KSL_MIN_DELAY_S') || 3,
    maxDelaySecs: settingNum_('KSL_MAX_DELAY_S') || 8,
    userAgent: KSL_USER_AGENT
  };
}

function startKslActor_(kind, searches, opts) {
  var actor = settingStr_('KSL_ACTOR_ID');
  if (!actor) throw new Error('KSL_ACTOR_ID is empty in Settings. Push the actor (SETUP_CHECKLIST Phase 3) first.');
  if (kslBlocked_()) { logEvent_('warn', 'ksl-actor', 'Skipped ' + kind + ': KSL back-off active until ' + settingStr_('KSL_BLOCKED_UNTIL')); return null; }
  if (apifyBudgetState_() === 'over') return null;
  var needsBrowser = searches.some(function (s) { return s.pages > 1; });
  var run = apifyStartRun_(actor, kslActorInput_(searches, opts), { memoryMb: needsBrowser ? 2048 : 256, timeoutSecs: 3600 });
  addPendingRun_(run.id, kind, { searches: searches.map(function (s) { return s.name; }), baseline: !!opts.baseline });
  logEvent_('info', 'ksl-actor', 'Started ' + kind + ' run ' + run.id + ' for ' + searches.length + ' searches (max ' + opts.maxPageLoads + ' page loads)');
  return run.id;
}

/** Menu item: one-time baseline across all saved searches (spreads over 2 days if the daily cap requires). */
function runKslBaseline() {
  var all = getConfig_().kslSearches.map(function (s) {
    var o = JSON.parse(JSON.stringify(s));
    o.pages = s.baselinePages || 3;
    return o;
  });
  setProp_('kslBaselineRemaining', JSON.stringify(all.map(function (s) { return s.name; })));
  var started = continueKslBaseline_();
  safeAlert_(started ? 'KSL baseline sweep started. Results appear on the Deals tab and dashboard over the next ~30 minutes; you\'ll get a "Baseline results" push when done.'
    : 'Could not start the baseline. Check the Logs tab.');
}

/** Start (or continue tomorrow) the baseline with as many searches as today's page budget allows. */
function continueKslBaseline_() {
  var remaining = JSON.parse(prop_('kslBaselineRemaining') || '[]');
  if (!remaining.length) return null;
  var budget = kslPagesLeft_() - settingNum_('KSL_DETAIL_DAILY_CAP'); // keep room for detail fetches
  var searches = getConfig_().kslSearches.filter(function (s) { return remaining.indexOf(s.name) >= 0; });
  var take = [], used = 0;
  searches.forEach(function (s) {
    var pages = s.baselinePages || 3;
    if (used + pages <= budget) { take.push({ name: s.name, type: s.type, category: s.category, subcategory: s.subcategory, keyword: s.keyword, radius: s.radius, maxPrice: s.maxPrice, pages: pages }); used += pages; }
  });
  if (!take.length) { logEvent_('info', 'ksl-baseline', 'No page budget left today; continuing tomorrow'); return null; }
  setProp_('kslBaselineRemaining', JSON.stringify(remaining.filter(function (n) { return !take.some(function (t) { return t.name === n; }); })));
  return startKslActor_('ksl-baseline', take, {
    maxPageLoads: used, baseline: true, sinceDays: settingNum_('KSL_BASELINE_MAX_AGE_DAYS'), maxDetailPages: 0
  });
}

/** Backup mode polling: Free every N minutes, paid searches at set times; 1 page each, stop at last-seen IDs. */
function kslBackupPoll_(which) {
  var lastIds = JSON.parse(prop_('kslLastIds') || '{}');
  var searches = getConfig_().kslSearches.filter(function (s) {
    var isFree = s.type === 'category' && s.category.toUpperCase() === 'FREE';
    return which === 'free' ? isFree : !isFree;
  }).map(function (s) {
    return { name: s.name, type: s.type, category: s.category, subcategory: s.subcategory, keyword: s.keyword, radius: s.radius, maxPrice: s.maxPrice, pages: 1, stopAtIds: lastIds[s.name] || [] };
  });
  var budget = Math.min(searches.length, kslPagesLeft_() - settingNum_('KSL_DETAIL_DAILY_CAP'));
  if (budget <= 0) { logEvent_('warn', 'ksl-backup', 'Daily KSL page cap reached; skipping ' + which + ' poll'); return; }
  startKslActor_('ksl-backup-' + which, searches.slice(0, budget), { maxPageLoads: budget });
}

/** Handler called by pollApifyRuns_ when a KSL actor run finishes. */
function handleKslCollectorResults_(items, output, meta, status) {
  output = output || {};
  if (output.pageLoads) bumpDaily_('kslPages', output.pageLoads);
  if (output.blocked) kslRecordBlock_(output.blockedReason || 'Blocked during collector run');
  if (output.layoutChanged && output.layoutChanged.length) {
    logEvent_('error', 'ksl-actor', 'KSL layout changed: no listings parsed for ' + output.layoutChanged.join(', '));
    alert_('KSL layout changed', 'The collector loaded pages but found no listings for: ' + output.layoutChanged.join(', ') + '. Update ksl-collector/src/config.js / KslParser.js.');
  }
  if (output.robotsSkipped && output.robotsSkipped.length) logEvent_('warn', 'ksl-actor', 'robots.txt disallowed: ' + output.robotsSkipped.join(', '));
  if (output.newestIds) {
    var lastIds = JSON.parse(prop_('kslLastIds') || '{}');
    Object.keys(output.newestIds).forEach(function (k) { lastIds[k] = output.newestIds[k]; });
    setProp_('kslLastIds', JSON.stringify(lastIds));
  }
  var norm = items.filter(function (d) { return d && d.listing_id; }).map(function (d) {
    d.deal_id = 'ksl:' + d.listing_id;
    if (meta.baseline) { d.source = 'KSL (baseline)'; d.baseline = true; } else { d.source = 'KSL'; }
    return d;
  });
  var n = enqueueItems_(norm, 'KSL');
  logEvent_('info', 'ksl-actor', status + ': ' + items.length + ' listings, ' + n + ' new, ' + (output.pageLoads || 0) + ' page loads');

  if (meta.baseline) {
    var remaining = JSON.parse(prop_('kslBaselineRemaining') || '[]');
    if (!remaining.length) {
      writeSetting_('KSL_BASELINE_DATE', todayKey_());
      setProp_('baselineDigestPending', '1');
      logEvent_('info', 'ksl-baseline', 'Baseline complete; KSL is now email-only');
    }
  }
}
