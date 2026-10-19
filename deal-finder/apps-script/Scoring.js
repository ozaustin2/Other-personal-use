/**
 * Scoring.js: derived numbers, distance-tier caps, category weights and Sales-log calibration.
 * Pure functions take config explicitly so they can be unit-tested.
 */

/**
 * Combine the AI valuation with deterministic math.
 * tiers = {t1, t2, t3, t2MinProfit, t3MinProfit}; hours = {pickup, listing, mph}; weights = {category: multiplier}
 */
function computeScore_(item, val, tiers, hours, weights) {
  var out = {};
  var low = Math.max(0, Number(val.est_resale_low) || 0);
  var high = Math.max(low, Number(val.est_resale_high) || 0);
  var mid = (low + high) / 2;
  var price = Math.max(0, Number(item.price) || 0);
  var parts = Math.max(0, Number(val.est_parts_cost) || 0);
  var repairHrs = Math.max(0, Number(val.est_repair_hours) || 0);
  var dist = item.distance_miles;

  out.est_profit = Math.round(mid - price - parts);
  var travelHrs = dist ? (2 * dist) / (hours.mph || 40) : 0;
  var totalHrs = repairHrs + (hours.pickup || 0) + (hours.listing || 0) + travelHrs;
  out.profit_per_hour = totalHrs > 0 ? Math.round(out.est_profit / totalHrs) : out.est_profit;
  out.below_market = low > 0 && price < 0.5 * low;

  var score = Number(val.opportunity_score) || 1;
  var w = weights[String(val.category || '').toLowerCase()];
  if (w) score = score * w;
  if (out.est_profit <= 0) score = Math.min(score, 3);

  // Distance tiers
  out.distance_tier = dist === null || dist === undefined ? 1 : dist <= tiers.t1 ? 1 : dist <= tiers.t2 ? 2 : dist <= tiers.t3 ? 3 : 4;
  if (out.distance_tier === 2 && out.est_profit < tiers.t2MinProfit) score = Math.min(score, 6);
  if (out.distance_tier === 3 && out.est_profit < tiers.t3MinProfit) score = Math.min(score, 6);
  if (out.distance_tier === 4) score = 1;

  out.opportunity_score = Math.max(1, Math.min(10, Math.round(score)));
  return out;
}

function tiersFromSettings_() {
  return {
    t1: settingNum_('TIER1_MI'), t2: settingNum_('TIER2_MI'), t3: settingNum_('TIER3_MI'),
    t2MinProfit: settingNum_('TIER2_MIN_PROFIT'), t3MinProfit: settingNum_('TIER3_MIN_PROFIT')
  };
}

function hoursFromSettings_() {
  return { pickup: settingNum_('PICKUP_HOURS'), listing: settingNum_('LISTING_HOURS'), mph: settingNum_('DRIVE_MPH') };
}

// ---------------------------------------------------------------------------
// Sales-log calibration

/** Summarize Sales log rows: per category, actual vs estimated profit and hours. */
function salesCalibration_(rows) {
  var by = {};
  rows.forEach(function (r) {
    var cat = String(r[2] || 'other').toLowerCase();
    var est = Number(r[8]), sale = Number(r[6]), bought = Number(r[3]) || 0, parts = Number(r[4]) || 0;
    if (!sale) return;
    var actual = sale - bought - parts;
    var b = by[cat] || (by[cat] = { n: 0, est: 0, actual: 0, hours: 0 });
    b.n++; b.est += est || 0; b.actual += actual; b.hours += Number(r[5]) || 0;
  });
  return by;
}

function readSalesRows_() {
  var sh = getSheet_(SHEETS.SALES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, SALES_COLS.length).getValues().filter(function (r) { return r[0] || r[1]; });
}

/** Text appended to the valuation prompt so estimates learn from real sales. */
function calibrationNotes_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('calibNotes');
  if (hit !== null) return hit;
  var by = salesCalibration_(readSalesRows_());
  var lines = Object.keys(by).filter(function (k) { return by[k].n >= 2; }).map(function (k) {
    var b = by[k];
    return '- ' + k + ': ' + b.n + ' sold, avg actual profit $' + Math.round(b.actual / b.n) +
      ' vs estimated $' + Math.round(b.est / b.n) + ', avg ' + (Math.round(b.hours / b.n * 10) / 10) + ' h each';
  });
  var notes = lines.length ? '\n\nCalibration from this buyer\'s actual sales (adjust your estimates accordingly):\n' + lines.join('\n') : '';
  cache.put('calibNotes', notes, 3600);
  return notes;
}

/**
 * Menu item: nudge category weights toward categories that actually made money per hour.
 * New weight = old weight × clamp(actual/est profit, 0.8, 1.2), bounded to [0.5, 1.6]. Needs ≥ 3 sales per category.
 */
function recalibrateWeights() {
  var by = salesCalibration_(readSalesRows_());
  var sh = getSheet_(SHEETS.SETTINGS);
  var values = sh.getDataRange().getValues();
  var inW = false, changes = [];
  for (var i = 0; i < values.length; i++) {
    var first = String(values[i][0]).trim();
    if (first.indexOf('## ') === 0) { inW = first === SECTION.WEIGHTS; continue; }
    if (!inW || !first || first === 'Category') continue;
    var b = by[first.toLowerCase()];
    if (!b || b.n < 3 || b.est <= 0) continue;
    var ratio = Math.max(0.8, Math.min(1.2, b.actual / b.est));
    var nw = Math.max(0.5, Math.min(1.6, Math.round(Number(values[i][1]) * ratio * 100) / 100));
    if (nw !== Number(values[i][1])) { sh.getRange(i + 1, 2).setValue(nw); changes.push(first + ' ' + values[i][1] + '→' + nw); }
  }
  CacheService.getScriptCache().remove('calibNotes');
  var msg = changes.length ? 'Updated weights: ' + changes.join(', ') : 'No changes (need at least 3 sales in a category).';
  logEvent_('info', 'recalibrate', msg);
  safeAlert_(msg);
}
