/**
 * Ebay.js: price comps from eBay Browse API active listings (client-credentials OAuth).
 */

function ebayToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('ebayToken');
  if (t) return t;
  var appId = prop_(PROP.EBAY_APP_ID), cert = prop_(PROP.EBAY_CERT_ID);
  if (!appId || !cert) return null;
  var resp = http_('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'post',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(appId + ':' + cert) },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  }, 1);
  if (resp.code !== 200 || !resp.json) {
    logEvent_('error', 'ebay', 'Token failed HTTP ' + resp.code + ': ' + truncate_(resp.text, 200));
    return null;
  }
  t = resp.json.access_token;
  cache.put('ebayToken', t, Math.min(21600, (resp.json.expires_in || 7200) - 300));
  return t;
}

/** Turn a listing title into a search query: drop filler words that hurt matching. */
function ebayQuery_(title) {
  return String(title || '')
    .replace(/\b(free|curb|alert|obo|firm|must go|asap|pickup|pick up|today|only|great|deal|works?|working|not working|for parts|needs? repair|broken|used|like new)\b/gi, ' ')
    .replace(/[^\w\s\-\/.]/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
}

/**
 * Comps for a title. Returns {query, count, median_local, low_local, high_local, examples:[{title, price}]} or null.
 * Prices are multiplied by EBAY_DISCOUNT to approximate a local sale price.
 */
function ebayComps_(title) {
  if (!settingBool_('EBAY_ENABLED')) return null;
  var q = ebayQuery_(title);
  if (q.length < 3) return null;
  var cacheKey = 'ebay:' + q.toLowerCase();
  var cache = CacheService.getScriptCache();
  var hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  var token = ebayToken_();
  if (!token) return null;
  var url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?limit=25&q=' + encodeURIComponent(q) +
    '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE},itemLocationCountry:US,priceCurrency:USD');
  var resp = http_(url, { headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } }, 1);
  if (resp.code !== 200 || !resp.json) {
    logEvent_('warn', 'ebay', 'Search failed HTTP ' + resp.code + ' for "' + q + '"');
    return null;
  }
  var items = (resp.json.itemSummaries || []).filter(function (s) { return s.price && s.price.value; });
  if (!items.length) { cache.put(cacheKey, 'null', 21600); return null; }
  var disc = settingNum_('EBAY_DISCOUNT') || 0.75;
  var prices = items.map(function (s) { return Number(s.price.value); }).sort(function (a, b) { return a - b; });
  var pct = function (p) { return prices[Math.min(prices.length - 1, Math.floor(p * prices.length))]; };
  var out = {
    query: q,
    count: prices.length,
    median_local: Math.round(pct(0.5) * disc),
    low_local: Math.round(pct(0.2) * disc),
    high_local: Math.round(pct(0.8) * disc),
    examples: items.slice(0, 6).map(function (s) { return { title: truncate_(s.title, 80), price: Number(s.price.value), condition: s.condition || '' }; })
  };
  cache.put(cacheKey, JSON.stringify(out), 21600);
  return out;
}
