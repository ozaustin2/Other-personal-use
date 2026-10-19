/**
 * Sheets.js: sheet access, Deals/Filtered rows, the Seen index, the Queue and pending Apify runs.
 */

var STATUSES = ['New', 'Contacted', 'Picked Up', 'Repairing', 'Listed', 'Sold', 'Passed'];

/** Deals tab columns: [header, key]. The first 18 match the spec order; the rest are detail columns. */
var DEAL_COLS = [
  ['Score', 'opportunity_score'],
  ['Thumbnail', 'thumbnail_formula'],
  ['Title', 'title'],
  ['Source', 'source'],
  ['Free/Paid', 'free_paid'],
  ['Asking Price', 'price'],
  ['Est Resale', 'resale_range'],
  ['Est Profit', 'est_profit'],
  ['Profit/Hr', 'profit_per_hour'],
  ['Difficulty', 'repair_difficulty'],
  ['Pickup Effort', 'pickup_effort'],
  ['Distance', 'distance_miles'],
  ['Category', 'category'],
  ['Reasoning', 'reasoning'],
  ['Listing Link', 'url'],
  ['Photo Folder Link', 'folder_url'],
  ['Status', 'status'],
  ['Date Found', 'date_found'],
  ['Matched Search', 'matched_search'],
  ['Below Market', 'below_market'],
  ['Item Type', 'item_type'],
  ['Brand/Model', 'brand_model_guess'],
  ['Condition', 'condition_guess'],
  ['Likely Fault', 'likely_fault'],
  ['Resale Low', 'est_resale_low'],
  ['Resale High', 'est_resale_high'],
  ['Parts Cost', 'est_parts_cost'],
  ['Repair Hrs', 'est_repair_hours'],
  ['City', 'city'],
  ['Posted', 'posted_at'],
  ['Image URL', 'image_url'],
  ['Draft Listing', 'draft_url'],
  ['Notified', 'notified'],
  ['Deal ID', 'deal_id'],
  ['Data', 'data_json']
];

var FILTERED_COLS = ['Date', 'Source', 'Title', 'Price', 'City', 'Reason', 'Listing Link', 'Deal ID'];
var SALES_COLS = ['Deal ID', 'Title', 'Category', 'Bought Price', 'Parts Cost', 'Hours Spent', 'Sale Price', 'Date Sold', 'Est Profit', 'Actual Profit', 'Notes'];
var LOG_COLS = ['Time', 'Level', 'Job', 'Message', 'Cost USD', 'Details'];
var SEEN_COLS = ['Deal ID', 'First Seen', 'Source'];
var QUEUE_COLS = ['Deal ID', 'Added', 'Stage', 'Item JSON'];
var RUNS_COLS = ['Run ID', 'Kind', 'Started', 'Meta JSON'];

var ss_ = null;

function getSpreadsheet_() {
  if (ss_) return ss_;
  var id = prop_(PROP.SHEET_ID);
  ss_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return ss_;
}

function getSheet_(name) {
  var ss = getSpreadsheet_();
  return ss ? ss.getSheetByName(name) : null;
}

function dealColIndex_(key) {
  for (var i = 0; i < DEAL_COLS.length; i++) if (DEAL_COLS[i][1] === key) return i + 1;
  throw new Error('Unknown deal column ' + key);
}

/** Stable ID used for dedupe across runs: "fb:123", "ksl:82343709", "share:<hash>". */
function dealId_(source, listingId) {
  return String(source).toLowerCase() + ':' + String(listingId);
}

// ---------------------------------------------------------------------------
// Seen index (dedupe)

var seenSet_ = null;

function loadSeen_() {
  if (seenSet_) return seenSet_;
  seenSet_ = {};
  var sh = getSheet_(SHEETS.SEEN);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { seenSet_[r[0]] = true; });
  }
  return seenSet_;
}

function isSeen_(id) { return !!loadSeen_()[id]; }

function markSeen_(ids, source) {
  if (!ids.length) return;
  var seen = loadSeen_();
  var now = new Date();
  var rows = [];
  ids.forEach(function (id) {
    if (!seen[id]) { seen[id] = true; rows.push([id, now, source]); }
  });
  if (rows.length) {
    var sh = getSheet_(SHEETS.SEEN);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
}

/** Drop Seen rows older than SEEN_EXPIRY_DAYS (but keep anything still on the Deals tab). */
function expireSeen_() {
  var sh = getSheet_(SHEETS.SEEN);
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = nowMs_() - settingNum_('SEEN_EXPIRY_DAYS') * 86400000;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  var keep = data.filter(function (r) { return r[1] instanceof Date && r[1].getTime() >= cutoff; });
  if (keep.length === data.length) return;
  sh.getRange(2, 1, data.length, 3).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, 3).setValues(keep);
  seenSet_ = null;
  logEvent_('info', 'housekeeping', 'Expired ' + (data.length - keep.length) + ' seen IDs');
}

// ---------------------------------------------------------------------------
// Queue

/**
 * Add normalized items to the Queue if they haven't been seen. Marks them seen immediately so
 * overlapping runs never queue the same listing twice. Returns the number queued.
 */
function enqueueItems_(items, source) {
  var fresh = [];
  var batchIds = {};
  items.forEach(function (it) {
    if (!it || !it.deal_id || batchIds[it.deal_id] || isSeen_(it.deal_id)) return;
    batchIds[it.deal_id] = true;
    fresh.push(it);
  });
  if (!fresh.length) return 0;
  var sh = getSheet_(SHEETS.QUEUE);
  var now = new Date();
  var rows = fresh.map(function (it) { return [it.deal_id, now, 'new', JSON.stringify(it)]; });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  markSeen_(fresh.map(function (it) { return it.deal_id; }), source);
  return fresh.length;
}

/** Read up to `limit` queue entries (oldest first, free items first). Returns [{row, item, stage}]. */
function readQueue_(limit) {
  var sh = getSheet_(SHEETS.QUEUE);
  if (!sh || sh.getLastRow() < 2) return [];
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var entries = [];
  data.forEach(function (r, i) {
    if (!r[0]) return;
    try { entries.push({ row: i + 2, stage: r[2], item: JSON.parse(r[3]) }); } catch (e) { entries.push({ row: i + 2, stage: 'bad', item: null }); }
  });
  entries.sort(function (a, b) {
    var fa = a.item && a.item.price === 0 ? 0 : 1, fb = b.item && b.item.price === 0 ? 0 : 1;
    return fa - fb || a.row - b.row;
  });
  return entries.slice(0, limit);
}

function updateQueueEntry_(row, stage, item) {
  getSheet_(SHEETS.QUEUE).getRange(row, 3, 1, 2).setValues([[stage, JSON.stringify(item)]]);
}

/** Delete queue rows (bottom-up so row numbers stay valid). */
function removeQueueRows_(rows) {
  var sh = getSheet_(SHEETS.QUEUE);
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}

function queueLength_() {
  var sh = getSheet_(SHEETS.QUEUE);
  return sh ? Math.max(0, sh.getLastRow() - 1) : 0;
}

// ---------------------------------------------------------------------------
// Deals / Filtered rows

function appendDeal_(item) {
  var sh = getSheet_(SHEETS.DEALS);
  item.thumbnail_formula = item.image_url ? '=IMAGE("' + String(item.image_url).replace(/"/g, '%22') + '")' : '';
  item.resale_range = (item.est_resale_low !== undefined && item.est_resale_high !== undefined)
    ? '$' + Math.round(item.est_resale_low) + '–$' + Math.round(item.est_resale_high) : '';
  item.free_paid = item.price === 0 ? 'Free' : 'Paid';
  item.status = item.status || 'New';
  item.date_found = item.date_found ? new Date(item.date_found) : new Date();
  var slim = JSON.parse(JSON.stringify(item));
  delete slim.thumbnail_formula; delete slim.description_full;
  item.data_json = truncate_(JSON.stringify(slim), 45000);
  var row = DEAL_COLS.map(function (c) {
    var v = item[c[1]];
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return v;
  });
  sh.appendRow(row);
  return sh.getLastRow();
}

function appendFiltered_(item, reason) {
  var sh = getSheet_(SHEETS.FILTERED);
  sh.appendRow([new Date(), item.source || '', item.title || '', item.price === null || item.price === undefined ? '' : item.price,
    item.city || '', reason, item.url || '', item.deal_id || '']);
}

/** Find a deal row by Deal ID. Returns {row, values} or null. */
function findDealRow_(dealId) {
  var sh = getSheet_(SHEETS.DEALS);
  if (sh.getLastRow() < 2) return null;
  var col = dealColIndex_('deal_id');
  var ids = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === dealId) {
      return { row: i + 2, values: sh.getRange(i + 2, 1, 1, DEAL_COLS.length).getValues()[0] };
    }
  }
  return null;
}

/** Row values -> object keyed by DEAL_COLS keys, merged with the Data JSON. */
function dealRowToObject_(values) {
  var o = {};
  try { o = JSON.parse(values[dealColIndex_('data_json') - 1] || '{}'); } catch (e) { o = {}; }
  DEAL_COLS.forEach(function (c, i) {
    if (c[1] === 'data_json' || c[1] === 'thumbnail_formula') return;
    var v = values[i];
    if (v instanceof Date) v = v.toISOString();
    if (v !== '' && v !== null && v !== undefined) o[c[1]] = v;
  });
  return o;
}

function setDealField_(row, key, value) {
  getSheet_(SHEETS.DEALS).getRange(row, dealColIndex_(key)).setValue(value);
}

// ---------------------------------------------------------------------------
// Pending Apify runs

function addPendingRun_(runId, kind, meta) {
  getSheet_(SHEETS.RUNS).appendRow([runId, kind, new Date(), JSON.stringify(meta || {})]);
}

function listPendingRuns_() {
  var sh = getSheet_(SHEETS.RUNS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().map(function (r, i) {
    var meta = {};
    try { meta = JSON.parse(r[3] || '{}'); } catch (e) { /* ignore */ }
    return { row: i + 2, runId: r[0], kind: r[1], started: r[2], meta: meta };
  }).filter(function (r) { return r.runId; });
}

function removePendingRun_(row) { getSheet_(SHEETS.RUNS).deleteRow(row); }
