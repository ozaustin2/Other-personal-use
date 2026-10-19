/**
 * Facebook.js: Facebook Marketplace via the Apify actor (default apify~facebook-marketplace-scraper).
 * Actor input: {startUrls: [{url}], resultsLimit, includeListingDetails}. Billed per listing returned,
 * so every run is capped with resultsLimit + maxItems + maxTotalChargeUsd.
 */

var FB_PRICE_PER_LISTING = 0.0062; // worst-case (free Apify plan) price, used for charge caps and projections

/** Fill a URL template. A null max price removes the maxPrice parameter entirely ("no max"). */
function fbUrl_(template, vals) {
  var url = template
    .replace('{city}', encodeURIComponent(settingStr_('FB_LOCATION_SLUG')))
    .replace('{km}', String(Math.round((vals.miles || 50) * 1.609)))
    .replace('{slug}', encodeURIComponent(vals.slug || ''))
    .replace('{q}', encodeURIComponent(vals.q || '').replace(/%20/g, '+'));
  if (vals.max === null || vals.max === undefined || vals.max === '') {
    url = url.replace(/([?&])maxPrice=\{max\}&?/, '$1').replace(/[?&]$/, '');
  } else {
    url = url.replace('{max}', String(Math.round(vals.max)));
  }
  return url;
}

function startFacebookRun_(kind, url, limit, meta) {
  var input = { startUrls: [{ url: url }], resultsLimit: limit, includeListingDetails: false };
  var run = apifyStartRun_(settingStr_('FB_ACTOR_ID'), input, {
    maxItems: limit, maxChargeUsd: limit * FB_PRICE_PER_LISTING + 0.02, timeoutSecs: 900
  });
  meta = meta || {};
  meta.url = url;
  addPendingRun_(run.id, kind, meta);
  logEvent_('info', 'fb', 'Started ' + kind + ' run ' + run.id + ' (' + limit + ' max) ' + url);
  return run.id;
}

/** Free sweep: newest free items within FB_FREE_RADIUS_MI. */
function facebookFreeSweep_() {
  if (!settingBool_('FB_ENABLED')) return;
  if (apifyBudgetState_() === 'over') return;
  var url = fbUrl_(settingStr_('FB_URL_FREE'), { miles: settingNum_('FB_FREE_RADIUS_MI') });
  startFacebookRun_('fb-free', url, settingNum_('FB_FREE_RESULTS') || 8, { search: 'FB - Free', free: true });
}

/** Paid sweep: category ceilings + keyword table. One run per URL so each gets its own result cap. */
function facebookPaidSweep_() {
  if (!settingBool_('FB_ENABLED')) return;
  var state = apifyBudgetState_();
  if (state !== 'ok') {
    logEvent_('warn', 'fb', 'Paid sweep skipped: Apify spend ' + (state === 'over' ? 'is over budget' : 'is on pace to exceed budget') +
      ' (projected $' + projectedMonthCost_('apify') + ' vs $' + settingNum_('APIFY_MONTHLY_BUDGET') + ').');
    return;
  }
  var cfg = getConfig_();
  var started = 0;
  cfg.fbCategories.filter(function (c) { return c.enabled; }).forEach(function (c) {
    var url = fbUrl_(settingStr_('FB_URL_CATEGORY'), { slug: c.slug, max: c.maxPrice, miles: settingNum_('FB_CATEGORY_RADIUS_MI') });
    try { startFacebookRun_('fb-paid', url, settingNum_('FB_PAID_RESULTS') || 5, { search: 'FB - ' + c.name, maxPrice: c.maxPrice }); started++; }
    catch (e) { logEvent_('error', 'fb', e.message); }
  });
  cfg.keywords.filter(function (k) { return k.enabled; }).forEach(function (k) {
    var url = fbUrl_(settingStr_('FB_URL_SEARCH'), { q: k.keyword, max: k.maxPrice, miles: k.radius });
    var limit = k.maxPrice === null ? (settingNum_('FB_NOMAX_RESULTS') || 10) : (settingNum_('FB_PAID_RESULTS') || 5);
    try { startFacebookRun_('fb-paid', url, limit, { search: 'FB - ' + k.keyword, maxPrice: k.maxPrice, radius: k.radius }); started++; }
    catch (e) { logEvent_('error', 'fb', e.message); }
  });
  logEvent_('info', 'fb', 'Paid sweep started ' + started + ' runs');
}

/** Normalize one dataset item from the actor. Returns null for sold/hidden/error items. */
function normalizeFacebookItem_(d, meta) {
  if (!d || d.error || !d.id) return null;
  if (d.is_sold || d.isSold || d.is_hidden || d.isHidden || d.is_pending || d.isPending) return null;
  var priceObj = d.listing_price || d.listingPrice || {};
  var amountRaw = priceObj.amount !== undefined ? priceObj.amount : null;
  var formatted = String(priceObj.formatted_amount || '');
  var price = /free/i.test(formatted) ? 0 : (amountRaw !== null && amountRaw !== '' ? Number(amountRaw) : null);
  if (meta && meta.free && (price === null || isNaN(price))) price = 0;
  var geo = (d.location && (d.location.reverse_geocode || d.location)) || {};
  var photo = d.primary_listing_photo || d.primaryListingPhoto || {};
  var img = (photo.image && photo.image.uri) || photo.photo_image_url || '';
  var photos = (d.listingPhotos || []).map(function (p) { return (p.image && p.image.uri) || p.photo_image_url; }).filter(Boolean);
  var title = d.marketplace_listing_title || d.listingTitle || d.custom_title || d.customTitle || '';
  return {
    deal_id: dealId_('fb', d.id),
    source: 'Facebook',
    listing_id: String(d.id),
    title: title,
    price: price,
    city: geo.city || '',
    state: geo.state || '',
    lat: d.location && d.location.latitude ? Number(d.location.latitude) : null,
    lng: d.location && d.location.longitude ? Number(d.location.longitude) : null,
    url: d.listingUrl || d.itemUrl || ('https://www.facebook.com/marketplace/item/' + d.id + '/'),
    image_url: img || photos[0] || '',
    image_urls: photos.length ? photos.slice(0, 4) : (img ? [img] : []),
    description: (d.description && d.description.text) || '',
    condition: d.condition || '',
    posted_at: d.timestamp || '',
    seller_name: (d.marketplace_listing_seller && d.marketplace_listing_seller.name) || '',
    matched_search: (meta && meta.search) || '',
    category_hint: d.marketplace_listing_category_id || ''
  };
}

/** Handler called by pollApifyRuns_ when a Facebook run finishes. */
function handleFacebookResults_(items, meta, status) {
  var norm = items.map(function (d) { return normalizeFacebookItem_(d, meta); }).filter(Boolean);
  // Respect the search's own price ceiling (Facebook sometimes returns slightly-over items).
  if (meta && meta.maxPrice !== null && meta.maxPrice !== undefined) {
    norm = norm.filter(function (it) { return it.price === null || it.price <= meta.maxPrice; });
  }
  var errors = items.filter(function (d) { return d && d.error; });
  if (errors.length) logEvent_('warn', 'fb', errors.length + ' error items, e.g. ' + truncate_(errors[0].error + ' ' + (errors[0].errorDescription || ''), 200));
  if (status !== 'SUCCEEDED' && !norm.length) logEvent_('warn', 'fb', 'Run ended ' + status + ' with no usable items (' + (meta && meta.url) + ')');
  var n = enqueueItems_(norm, 'Facebook');
  logEvent_('info', 'fb', (meta && meta.search) + ': ' + items.length + ' items, ' + n + ' new');
}
