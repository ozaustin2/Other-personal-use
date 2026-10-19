/**
 * Config.js: defaults, Settings-tab parsing and Script Properties access.
 *
 * Secrets (API keys, tokens) live ONLY in Script Properties.
 * Everything else lives in the "Settings" tab so it can be edited without code.
 */

var SHEETS = {
  DEALS: 'Deals',
  FILTERED: 'Filtered',
  SETTINGS: 'Settings',
  SALES: 'Sales log',
  LOGS: 'Logs',
  SEEN: 'Seen',     // hidden: dedupe index
  QUEUE: 'Queue',   // hidden: candidates waiting for filter/scoring
  RUNS: 'Runs'      // hidden: pending Apify runs
};

/** Script Properties keys (secrets + machine state). */
var PROP = {
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  APIFY_TOKEN: 'APIFY_TOKEN',
  EBAY_APP_ID: 'EBAY_APP_ID',
  EBAY_CERT_ID: 'EBAY_CERT_ID',
  NTFY_TOPIC: 'NTFY_TOPIC',
  NTFY_SERVER: 'NTFY_SERVER',          // optional, default https://ntfy.sh
  NTFY_TOKEN: 'NTFY_TOKEN',            // optional access token for a protected topic
  SHARE_TOKEN: 'SHARE_TOKEN',
  DASHBOARD_KEY: 'DASHBOARD_KEY',
  SHEET_ID: 'SHEET_ID',
  DRIVE_FOLDER_ID: 'DRIVE_FOLDER_ID',
  HOME_LAT: 'HOME_LAT',
  HOME_LNG: 'HOME_LNG',
  WEBAPP_URL: 'WEBAPP_URL'
};

/**
 * Default key/value settings. Written to the Settings tab on setup; the tab wins afterwards.
 * [key, defaultValue, description]
 */
var DEFAULT_SETTINGS = [
  ['HOME_ZIP', '84054', 'Home ZIP code (North Salt Lake).'],

  // Facebook (Apify)
  ['FB_ENABLED', true, 'Run Facebook sweeps at all.'],
  ['FB_ACTOR_ID', 'apify~facebook-marketplace-scraper', 'Apify actor used for Facebook Marketplace.'],
  ['FB_LOCATION_SLUG', 'saltlakecity', 'Facebook Marketplace city slug (from facebook.com/marketplace/<slug>/).'],
  ['FB_FREE_INTERVAL_MIN', 30, 'Minutes between Facebook free sweeps (15–60).'],
  ['FB_FREE_ACTIVE_START', 7, 'Hour (0–23) free sweeps start each day.'],
  ['FB_FREE_ACTIVE_END', 22, 'Hour (0–23) free sweeps stop each day.'],
  ['FB_FREE_RADIUS_MI', 50, 'Free sweep radius in miles.'],
  ['FB_FREE_RESULTS', 8, 'Max listings per free sweep (each listing costs ~$0.005–0.006).'],
  ['FB_PAID_TIMES', '10:00,18:00', 'Times for paid Facebook sweeps (24h, comma separated).'],
  ['FB_PAID_RESULTS', 5, 'Max listings per paid search URL per sweep.'],
  ['FB_NOMAX_RESULTS', 10, 'Max listings per "no max price" keyword search (about 2 result pages is ~40, which is costly).'],
  ['FB_CATEGORY_RADIUS_MI', 50, 'Radius for paid category sweeps.'],
  ['FB_URL_FREE', 'https://www.facebook.com/marketplace/{city}/free?radius={km}&sortBy=creation_time_descend', 'Facebook free-items URL template ({city}, {km}).'],
  ['FB_URL_CATEGORY', 'https://www.facebook.com/marketplace/{city}/{slug}?maxPrice={max}&radius={km}&sortBy=creation_time_descend&exact=false', 'Facebook category URL template ({city}, {slug}, {max}, {km}).'],
  ['FB_URL_SEARCH', 'https://www.facebook.com/marketplace/{city}/search?query={q}&maxPrice={max}&radius={km}&sortBy=creation_time_descend&exact=false', 'Facebook keyword search URL template ({city}, {q}, {max}, {km}).'],

  // KSL
  ['KSL_EMAIL_LABEL', 'KSL Alerts', 'Gmail label that holds KSL saved-search alert emails.'],
  ['KSL_PROCESSED_LABEL', 'deal-processed', 'Gmail label added after an email is processed.'],
  ['KSL_HEALTH_HOURS', 6, 'Alert if no KSL email has arrived for this many hours (during active hours).'],
  ['KSL_HEALTH_ACTIVE_START', 7, 'Feed health check active from this hour.'],
  ['KSL_HEALTH_ACTIVE_END', 22, 'Feed health check active until this hour.'],
  ['KSL_HEALTH_INTERVAL_MIN', 120, 'Minutes between KSL feed health checks.'],
  ['KSL_BACKUP_MODE', false, 'TRUE = poll KSL with the backup collector (normally only when emails stop).'],
  ['KSL_AUTO_BACKUP', false, 'TRUE = automatically turn on backup mode when the email feed looks broken.'],
  ['KSL_BACKUP_FREE_INTERVAL_MIN', 20, 'Backup mode: minutes between Free polls.'],
  ['KSL_BACKUP_PAID_TIMES', '10:00,18:00', 'Backup mode: times for paid searches.'],
  ['KSL_DETAIL_FETCH', true, 'Fetch the public listing page for description/photos of items passing the pre-filter.'],
  ['KSL_DETAIL_DAILY_CAP', 30, 'Max KSL listing detail pages per day.'],
  ['KSL_DAILY_PAGE_CAP', 200, 'Max KSL page loads per day in total (search + detail).'],
  ['KSL_MIN_DELAY_S', 3, 'Minimum seconds between KSL requests.'],
  ['KSL_MAX_DELAY_S', 8, 'Maximum seconds between KSL requests.'],
  ['KSL_ACTOR_ID', '', 'Your Apify actor ID for the KSL collector, e.g. yourname~ksl-classifieds-collector.'],
  ['KSL_BASELINE_DATE', '', 'Set automatically when the one-time baseline sweep finishes.'],
  ['KSL_BASELINE_MAX_AGE_DAYS', 14, 'Baseline sweep ignores listings older than this.'],
  ['KSL_BLOCKED_UNTIL', '', 'Set automatically after a 403/429/CAPTCHA. KSL requests pause until then.'],

  // Alerts
  ['DIGEST_TIMES', '10:15,18:15', 'Digest push times (24h).'],
  ['TOP10_DIGEST_TIME', '18:15', 'Which digest also includes the top 10 deals of the day and re-sorts the Sheet.'],
  ['FREE_PUSH_MIN_SCORE', 8, 'Free items at or above this score push instantly.'],
  ['PAID_PUSH_MIN_SCORE', 9, 'Paid items at or above this score push instantly (others wait for the digest).'],
  ['QUIET_START', 22, 'Quiet hours start (hour). Non-critical pushes are held.'],
  ['QUIET_END', 6, 'Quiet hours end (hour).'],

  // Distance tiers
  ['TIER1_MI', 25, 'Tier 1 radius: any deal can score high.'],
  ['TIER2_MI', 50, 'Tier 2 radius.'],
  ['TIER2_MIN_PROFIT', 250, 'Tier 2 items need at least this est. profit to score 7+.'],
  ['TIER3_MI', 100, 'Tier 3 radius (beyond this is ignored).'],
  ['TIER3_MIN_PROFIT', 750, 'Tier 3 items need at least this est. profit to score 7+.'],

  // Valuation
  ['EBAY_ENABLED', true, 'Use eBay active listings as price comps.'],
  ['EBAY_DISCOUNT', 0.75, 'Multiply eBay asking prices by this to approximate a local sale price.'],
  ['PICKUP_HOURS', 0.75, 'Base hours for pickup (driving + loading), added to repair hours for profit/hr.'],
  ['LISTING_HOURS', 0.5, 'Hours to photograph, list and sell an item.'],
  ['DRIVE_MPH', 40, 'Average driving speed used to add travel time by distance.'],

  // AI
  ['MODEL_FILTER', 'claude-haiku-5-5', 'Cheap model for filtering and quick estimates.'],
  ['MODEL_VALUE', 'claude-haiku-5-5', 'Model for valuation/scoring and manual shares. claude-haiku-5-5 ≈ 0.1¢ per item; claude-sonnet-5-5 is more accurate but ~20× the cost.'],
  ['MODEL_DRAFT', 'claude-sonnet-5-5', 'Model for on-demand resale listing drafts (only when you tap Draft listing, ≈ 5¢ each).'],
  ['VALUE_EFFORT', 'low', 'Effort for the valuation model (low / medium / high). Higher = better reasoning, more cost.'],
  ['VALUE_DAILY_CAP', 60, 'Max full valuations per day (cost control). Extra items get a quick estimate instead.'],
  ['VALUE_MIN_QUICK_PROFIT', 40, 'Items (free or paid) need at least this quick profit guess (resale minus price, from the cheap model) to get a full valuation.'],
  ['CLAUDE_MONTHLY_BUDGET', 3, 'Use quick estimates only if month-to-date Claude cost exceeds this (USD). Expected ≈ $1–3/month with Haiku.'],

  // Budget
  ['APIFY_MONTHLY_BUDGET', 30, 'Pause Apify runs if month-to-date Apify cost exceeds this (USD). Paid sweeps pause first when the pace is over budget.'],

  // Housekeeping
  ['SEEN_EXPIRY_DAYS', 90, 'Forget seen listing IDs after this many days.'],
  ['QUEUE_BATCH', 15, 'Max items scored per 5-minute tick.']
];

/** Keyword table defaults: keyword, radius miles, max price ('' = no max), enabled */
var DEFAULT_KEYWORDS = [
  ['freeze dryer', 100, 3000, true],
  ['Harvest Right', 100, 3000, true],
  ['generator', 50, 600, true],
  ['snowblower', 50, 500, true],
  ['e-bike', 50, 600, true],
  ['welder', 50, 500, true],
  ['compressor', 25, 300, true],
  ['for parts', 25, 400, true],
  ['not working', 25, '', true],
  ['needs repair', 25, '', true],
  ['commercial', 100, 1000, true],
  ['zero turn', 100, 1000, true]
];

/** Facebook paid category sweeps: name, facebook slug, max price, enabled */
var DEFAULT_FB_CATEGORIES = [
  ['Electronics', 'electronics', 75, true],
  ['Appliances', 'appliances', 150, true],
  ['Tools', 'tools', 100, true],
  ['Garden & outdoor (outdoor power)', 'garden', 200, true],
  ['Sporting / e-mobility', 'sports', 200, true]
];

/**
 * KSL saved searches (already exist in the KSL account; used for the baseline/backup collector and docs).
 * name, type (category|keyword), category, subcategory, keyword, radius, max price ('' none, 0 = free), baseline pages
 */
var DEFAULT_KSL_SEARCHES = [
  ['DF - Free 25mi', 'category', 'FREE', '', '', 25, 0, 5],
  ['DF - Appliances <$150', 'category', 'Appliances', '', '', 25, 150, 3],
  ['DF - Electronics <$75', 'category', 'Electronics', '', '', 25, 75, 3],
  ['DF - Tools <$100', 'category', 'Industrial', 'Power and Hand Tools', '', 25, 100, 3],
  ['DF - Lawn Mowers <$200', 'category', 'Home and Garden', 'Lawn Mowers', '', 25, 200, 3],
  ['DF - Yard Equipment <$200', 'category', 'Home and Garden', 'Other Garden/Lawn/Yard Equipment', '', 25, 200, 3],
  ['DF - freeze dryer 100mi <$3000', 'keyword', '', '', 'freeze dryer', 100, 3000, 3],
  ['DF - Harvest Right 100mi <$3000', 'keyword', '', '', 'Harvest Right', 100, 3000, 3],
  ['DF - generator 50mi <$600', 'keyword', '', '', 'generator', 50, 600, 3],
  ['DF - snowblower 50mi <$500', 'keyword', '', '', 'snowblower', 50, 500, 3],
  ['DF - e-bike 50mi <$600', 'keyword', '', '', 'e-bike', 50, 600, 3],
  ['DF - welder 50mi <$500', 'keyword', '', '', 'welder', 50, 500, 3],
  ['DF - compressor <$300', 'keyword', '', '', 'compressor', 25, 300, 3],
  ['DF - for parts <$400', 'keyword', '', '', 'for parts', 25, 400, 3],
  ['DF - not working (no max)', 'keyword', '', '', 'not working', 25, '', 2],
  ['DF - needs repair (no max)', 'keyword', '', '', 'needs repair', 25, '', 2]
];

/** Category weights (multiplier on the opportunity score before clamping). */
var DEFAULT_WEIGHTS = [
  ['appliances', 1.15],
  ['freeze dryers', 1.25],
  ['small engines', 1.1],
  ['outdoor power', 1.1],
  ['power tools', 1.05],
  ['e-mobility', 1.05],
  ['electronics', 1.0],
  ['av', 1.0],
  ['computers', 0.95],
  ['gaming', 0.95],
  ['test equipment', 1.0],
  ['hvac', 1.0],
  ['other', 0.9]
];

var SECTION = {
  SETTINGS: '## SETTINGS',
  KEYWORDS: '## KEYWORDS',
  FB_CATEGORIES: '## FACEBOOK CATEGORIES',
  KSL_SEARCHES: '## KSL SAVED SEARCHES',
  WEIGHTS: '## CATEGORY WEIGHTS'
};

// ---------------------------------------------------------------------------
// Script Properties

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function requireProp_(key) {
  var v = prop_(key);
  if (!v) throw new Error('Missing Script Property ' + key + '. See SETUP_CHECKLIST.md.');
  return v;
}

// ---------------------------------------------------------------------------
// Settings tab

var settingsCache_ = null;

/** Returns the whole parsed Settings tab: {kv, keywords, fbCategories, kslSearches, weights}. */
function getConfig_() {
  if (settingsCache_) return settingsCache_;
  var sh = getSheet_(SHEETS.SETTINGS);
  var values = sh ? sh.getDataRange().getValues() : [];
  settingsCache_ = parseSettingsValues_(values);
  return settingsCache_;
}

function resetConfigCache_() {
  settingsCache_ = null;
}

/** Pure parser so it can be unit-tested outside Apps Script. */
function parseSettingsValues_(values) {
  var cfg = { kv: {}, keywords: [], fbCategories: [], kslSearches: [], weights: {} };
  DEFAULT_SETTINGS.forEach(function (r) { cfg.kv[r[0]] = r[1]; });
  var section = null;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var first = String(row[0] === undefined ? '' : row[0]).trim();
    if (first.indexOf('## ') === 0) { section = first; continue; }
    if (!first || first.charAt(0) === '#') continue;
    if (row[0] === 'Key' || row[0] === 'Keyword' || row[0] === 'Name' || row[0] === 'Category') continue; // headers
    if (section === SECTION.SETTINGS) {
      cfg.kv[first] = row[1];
    } else if (section === SECTION.KEYWORDS) {
      cfg.keywords.push({ keyword: first, radius: num_(row[1], 25), maxPrice: blankToNull_(row[2]), enabled: bool_(row[3], true) });
    } else if (section === SECTION.FB_CATEGORIES) {
      cfg.fbCategories.push({ name: first, slug: String(row[1]).trim(), maxPrice: blankToNull_(row[2]), enabled: bool_(row[3], true) });
    } else if (section === SECTION.KSL_SEARCHES) {
      cfg.kslSearches.push({
        name: first, type: String(row[1]).trim(), category: String(row[2] || '').trim(), subcategory: String(row[3] || '').trim(),
        keyword: String(row[4] || '').trim(), radius: num_(row[5], 25), maxPrice: blankToNull_(row[6]), baselinePages: num_(row[7], 3)
      });
    } else if (section === SECTION.WEIGHTS) {
      cfg.weights[first.toLowerCase()] = num_(row[1], 1);
    }
  }
  if (!values.length) {
    cfg.keywords = DEFAULT_KEYWORDS.map(function (r) { return { keyword: r[0], radius: r[1], maxPrice: blankToNull_(r[2]), enabled: r[3] }; });
    cfg.fbCategories = DEFAULT_FB_CATEGORIES.map(function (r) { return { name: r[0], slug: r[1], maxPrice: r[2], enabled: r[3] }; });
    cfg.kslSearches = DEFAULT_KSL_SEARCHES.map(function (r) {
      return { name: r[0], type: r[1], category: r[2], subcategory: r[3], keyword: r[4], radius: r[5], maxPrice: blankToNull_(r[6]), baselinePages: r[7] };
    });
    DEFAULT_WEIGHTS.forEach(function (r) { cfg.weights[r[0]] = r[1]; });
  }
  return cfg;
}

/** Typed getters for key/value settings. */
function setting_(key) {
  var cfg = getConfig_();
  return cfg.kv.hasOwnProperty(key) ? cfg.kv[key] : null;
}
function settingNum_(key) { return num_(setting_(key), 0); }
function settingBool_(key) { return bool_(setting_(key), false); }
function settingStr_(key) { var v = setting_(key); return v === null || v === undefined ? '' : String(v).trim(); }
function settingTimes_(key) {
  return settingStr_(key).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Write a single key/value setting back to the Settings tab (used for machine-set values). */
function writeSetting_(key, value) {
  var sh = getSheet_(SHEETS.SETTINGS);
  var values = sh.getDataRange().getValues();
  var inSettings = false;
  for (var i = 0; i < values.length; i++) {
    var first = String(values[i][0]).trim();
    if (first.indexOf('## ') === 0) { inSettings = first === SECTION.SETTINGS; continue; }
    if (inSettings && first === key) {
      sh.getRange(i + 1, 2).setValue(value);
      if (settingsCache_) settingsCache_.kv[key] = value;
      return;
    }
  }
  throw new Error('Setting not found: ' + key);
}

// ---------------------------------------------------------------------------
// small coercion helpers

function num_(v, dflt) {
  if (v === '' || v === null || v === undefined) return dflt;
  var n = Number(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? dflt : n;
}

function bool_(v, dflt) {
  if (v === true || v === false) return v;
  var s = String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === 'n' || s === '0' || s === 'off') return false;
  return dflt;
}

function blankToNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var s = String(v).trim().toLowerCase();
  if (s === 'no max' || s === 'none' || s === '-') return null;
  return num_(v, null);
}
