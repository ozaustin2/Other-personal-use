/**
 * WebApp.js: doGet (mobile dashboard) and doPost (iPhone Shortcut share endpoint).
 *
 * The web app is deployed "Execute as: Me, Who has access: Anyone" so the iPhone Shortcut can post to it;
 * every request is therefore checked against a secret: DASHBOARD_KEY for the dashboard, SHARE_TOKEN for shares.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.k || p.k !== prop_(PROP.DASHBOARD_KEY)) {
    return HtmlService.createHtmlOutput('<p style="font:16px sans-serif;padding:2em">Not authorized. Open the dashboard link from Deal Finder → Show dashboard link.</p>');
  }
  var url = ScriptApp.getService().getUrl();
  if (url && url !== prop_(PROP.WEBAPP_URL)) setProp_(PROP.WEBAPP_URL, url);
  var t = HtmlService.createTemplateFromFile('Dashboard');
  t.key = p.k;
  t.focusId = p.id || '';
  return t.evaluate()
    .setTitle('Deal Finder')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function showDashboardLink() {
  var url = dashboardUrl_();
  safeAlert_(url ? 'Dashboard (bookmark this on your phone; it contains your private key):\n\n' + url
    : 'Not deployed yet. Deploy → New deployment → Web app (Execute as: Me, Access: Anyone), then open the deployment URL once with ?k=' + prop_(PROP.DASHBOARD_KEY));
}

function checkKey_(key) {
  if (!key || key !== prop_(PROP.DASHBOARD_KEY)) throw new Error('Not authorized');
}

// ---------------------------------------------------------------------------
// Dashboard server functions (called with google.script.run)

/** Recent deals as plain objects for the card grid (newest 600 rows). */
function dashGetDeals(key) {
  checkKey_(key);
  var sh = getSheet_(SHEETS.DEALS);
  var last = sh.getLastRow();
  if (last < 2) return { deals: [], statuses: STATUSES };
  var start = Math.max(2, last - 599);
  var values = sh.getRange(start, 1, last - start + 1, DEAL_COLS.length).getValues();
  var deals = values.map(function (v) {
    var o = dealRowToObject_(v);
    return {
      id: o.deal_id, score: o.opportunity_score, title: o.title, source: o.source, free: o.price === 0, price: o.price,
      profit: o.est_profit, pph: o.profit_per_hour, low: o.est_resale_low, high: o.est_resale_high, dist: o.distance_miles,
      tier: o.distance_tier, category: o.category, reasoning: o.reasoning, url: o.url, image: o.image_url, status: o.status || 'New',
      found: o.date_found, posted: o.posted_at, city: o.city, difficulty: o.repair_difficulty, pickup: o.pickup_effort,
      fault: o.likely_fault, model: o.brand_model_guess, folder: o.folder_url, draft: o.draft_url, search: o.matched_search,
      below: o.below_market === 'Yes' || o.below_market === true
    };
  }).filter(function (d) { return d.id; });
  return { deals: deals, statuses: STATUSES };
}

function dashSetStatus(key, dealId, status) {
  checkKey_(key);
  if (STATUSES.indexOf(status) < 0) throw new Error('Bad status');
  var f = findDealRow_(dealId);
  if (!f) throw new Error('Deal not found');
  setDealField_(f.row, 'status', status);
  var folderUrl = '';
  if (['Picked Up', 'Repairing', 'Listed'].indexOf(status) >= 0) folderUrl = ensureDealFolder_(f.row).getUrl();
  return { ok: true, folder: folderUrl };
}

function dashDraftListing(key, dealId, notes) {
  checkKey_(key);
  return draftListingFor_(dealId, notes);
}

/** Record a sale in the Sales log and mark the deal Sold. */
function dashLogSale(key, dealId, salePrice, hours, partsCost) {
  checkKey_(key);
  var f = findDealRow_(dealId);
  if (!f) throw new Error('Deal not found');
  var d = dealRowToObject_(f.values);
  var sales = getSheet_(SHEETS.SALES);
  var row = sales.getLastRow() + 1;
  sales.getRange(row, 1, 1, 9).setValues([[dealId, d.title, d.category || '', Number(d.price) || 0, Number(partsCost) || 0, Number(hours) || 0,
    Number(salePrice) || 0, new Date(), Number(d.est_profit) || 0]]);
  setDealField_(f.row, 'status', 'Sold');
  CacheService.getScriptCache().remove('calibNotes');
  return { ok: true, profit: (Number(salePrice) || 0) - (Number(d.price) || 0) - (Number(partsCost) || 0) };
}

/** Create (once) the per-deal photo folder and store its link on the row. Returns the Folder. */
function ensureDealFolder_(row) {
  var sh = getSheet_(SHEETS.DEALS);
  var existing = sh.getRange(row, dealColIndex_('folder_url')).getValue();
  var m = /folders\/([\w-]+)/.exec(String(existing));
  if (m) { try { return DriveApp.getFolderById(m[1]); } catch (e) { /* recreate */ } }
  var title = sh.getRange(row, dealColIndex_('title')).getValue();
  var id = sh.getRange(row, dealColIndex_('deal_id')).getValue();
  var folder = DriveApp.getFolderById(requireProp_(PROP.DRIVE_FOLDER_ID)).createFolder(truncate_(title, 60) + ' [' + id + ']');
  sh.getRange(row, dealColIndex_('folder_url')).setValue(folder.getUrl());
  return folder;
}

// ---------------------------------------------------------------------------
// Manual share endpoint (iPhone Shortcut)

/**
 * POST JSON: {"token": SHARE_TOKEN, "url": "...", "text": "...", "image": "<base64>", "imageType": "image/jpeg"}
 * Returns JSON {ok, title, score, profit, dashboard}.
 */
function doPost(e) {
  var out;
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
    }
    var p = e.parameter || {};
    var token = body.token || p.token;
    if (!token || token !== prop_(PROP.SHARE_TOKEN)) return jsonOut_({ ok: false, error: 'bad token' });
    out = handleShare_(body.url || p.url || '', body.text || p.text || '', body.image || '', body.imageType || 'image/jpeg');
  } catch (err) {
    logEvent_('error', 'share', err.message);
    out = { ok: false, error: err.message };
  }
  return jsonOut_(out);
}

function jsonOut_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handleShare_(url, text, imageB64, imageType) {
  // No script lock here: a 5-minute tick can hold it for minutes and the Shortcut would time out.
  resetConfigCache_();
  var m = /https?:\/\/\S+/.exec(text || '');
  if (!url && m) url = m[0];
  var blob = imageB64 ? Utilities.newBlob(Utilities.base64Decode(String(imageB64).replace(/^data:[^,]+,/, '')), imageType, 'share') : null;
  var x = aiExtractShare_(text, url, blob);
  var fbId = /facebook\.com\/marketplace\/item\/(\d+)/.exec(url || '');
  var kslId = kslListingIdFromUrl_(url || '');
  var dealId = fbId ? dealId_('fb', fbId[1]) : kslId ? dealId_('ksl', kslId)
    : dealId_('share', Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (url || '') + x.title)).slice(0, 12));
  var existing = findDealRow_(dealId);
  if (existing) {
    var d = dealRowToObject_(existing.values);
    return { ok: true, duplicate: true, title: d.title, score: d.opportunity_score, profit: d.est_profit, dashboard: dashboardUrl_(dealId) };
  }
  var item = {
    deal_id: dealId, source: 'Share', listing_id: dealId.split(':')[1], title: x.title, price: x.price < 0 ? null : x.price,
    city: x.city, state: x.state, url: url, image_url: '', image_urls: [], description: x.description,
    matched_search: 'Manual share (' + (x.source || 'Other') + ')', posted_at: ''
  };
  if (blob) {
    var folder = DriveApp.getFolderById(requireProp_(PROP.DRIVE_FOLDER_ID));
    var sub = folder.getFoldersByName('Shared screenshots');
    var shotFolder = sub.hasNext() ? sub.next() : folder.createFolder('Shared screenshots');
    var file = shotFolder.createFile(blob.setName(dealId.replace(':', '-') + '.jpg'));
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { /* thumbnail then only shows when signed in */ }
    item.image_url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w600';
  }
  item.distance_miles = distanceFromHome_(item);
  markSeen_([dealId], 'Share');
  item.quick_resale_guess = 0;
  valuateAndRecord_(item);
  return { ok: true, title: item.title, score: item.opportunity_score, profit: item.est_profit, reasoning: item.reasoning, dashboard: dashboardUrl_(dealId) };
}
