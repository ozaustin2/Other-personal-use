/**
 * Apify.js: start actor runs, poll them from the 5-minute tick, fetch datasets, log cost, enforce the budget.
 * Runs are async: start → recorded in the hidden "Runs" tab → a later tick fetches results when finished.
 */

var APIFY_API = 'https://api.apify.com/v2';

function apifyHeaders_() {
  return { Authorization: 'Bearer ' + requireProp_(PROP.APIFY_TOKEN) };
}

/**
 * Start a run. opts: {maxItems, maxChargeUsd, memoryMb, timeoutSecs}. Returns the run object.
 * maxItems / maxTotalChargeUsd make Apify itself stop charging past the cap.
 */
function apifyStartRun_(actorId, input, opts) {
  opts = opts || {};
  var q = [];
  if (opts.maxItems) q.push('maxItems=' + opts.maxItems);
  if (opts.maxChargeUsd) q.push('maxTotalChargeUsd=' + opts.maxChargeUsd.toFixed(3));
  if (opts.memoryMb) q.push('memory=' + opts.memoryMb);
  if (opts.timeoutSecs) q.push('timeout=' + opts.timeoutSecs);
  var url = APIFY_API + '/acts/' + encodeURIComponent(actorId).replace('%7E', '~') + '/runs' + (q.length ? '?' + q.join('&') : '');
  var resp = http_(url, { method: 'post', contentType: 'application/json', headers: apifyHeaders_(), payload: JSON.stringify(input) }, 2);
  if (resp.code >= 300 || !resp.json) throw new Error('Apify start ' + actorId + ' HTTP ' + resp.code + ': ' + truncate_(resp.text, 300));
  return resp.json.data;
}

function apifyGetRun_(runId) {
  var resp = http_(APIFY_API + '/actor-runs/' + runId, { headers: apifyHeaders_() }, 2);
  if (resp.code >= 300 || !resp.json) throw new Error('Apify run ' + runId + ' HTTP ' + resp.code);
  return resp.json.data;
}

function apifyAbortRun_(runId) {
  http_(APIFY_API + '/actor-runs/' + runId + '/abort', { method: 'post', headers: apifyHeaders_() }, 1);
}

function apifyDatasetItems_(datasetId, limit) {
  var url = APIFY_API + '/datasets/' + datasetId + '/items?clean=true&format=json&limit=' + (limit || 1000);
  var resp = http_(url, { headers: apifyHeaders_() }, 2);
  if (resp.code >= 300) throw new Error('Apify dataset ' + datasetId + ' HTTP ' + resp.code);
  return resp.json || [];
}

function apifyKvRecord_(storeId, key) {
  var resp = http_(APIFY_API + '/key-value-stores/' + storeId + '/records/' + key, { headers: apifyHeaders_() }, 1);
  return resp.code === 200 ? resp.json : null;
}

/** 'ok' | 'pace' (projected over budget: skip optional runs) | 'over' (month-to-date over budget: stop). */
function apifyBudgetState_() {
  var budget = settingNum_('APIFY_MONTHLY_BUDGET');
  if (!budget) return 'ok';
  var mtd = monthCost_('apify');
  if (mtd >= budget) {
    if (!prop_('apifyBudgetAlert:' + monthKey_())) {
      setProp_('apifyBudgetAlert:' + monthKey_(), '1');
      alert_('Apify budget reached', 'Month-to-date Apify cost $' + mtd.toFixed(2) + ' ≥ $' + budget + '. Facebook sweeps and the KSL collector are paused until next month (or raise APIFY_MONTHLY_BUDGET).');
    }
    return 'over';
  }
  return projectedMonthCost_('apify') > budget ? 'pace' : 'ok';
}

/**
 * Called from the tick: finalize finished runs and hand their items to the right handler.
 */
function pollApifyRuns_() {
  var pending = listPendingRuns_();
  var finishedRows = [];
  pending.forEach(function (p) {
    var run;
    try { run = apifyGetRun_(p.runId); } catch (e) { logEvent_('warn', 'apify', e.message); return; }
    var status = run.status;
    var ageMin = (nowMs_() - new Date(p.started).getTime()) / 60000;
    if (status === 'READY' || status === 'RUNNING') {
      if (ageMin > 45) {
        apifyAbortRun_(p.runId);
        logEvent_('warn', 'apify', 'Aborted run ' + p.runId + ' (' + p.kind + ') after ' + Math.round(ageMin) + ' min');
      }
      return;
    }
    var cost = 0;
    var items = [];
    try { items = run.defaultDatasetId ? apifyDatasetItems_(run.defaultDatasetId) : []; } catch (e) { logEvent_('error', 'apify', e.message); }
    var output = null;
    if (p.kind.indexOf('ksl') === 0 && run.defaultKeyValueStoreId) output = apifyKvRecord_(run.defaultKeyValueStoreId, 'OUTPUT');
    cost = apifyRunCost_(run, items.length);
    logEvent_('cost', 'apify:' + p.kind, status + ' run ' + p.runId + ', ' + items.length + ' items', Math.round(cost * 10000) / 10000,
      { projectedMonth: projectedMonthCost_('apify') });
    try {
      if (p.kind.indexOf('fb') === 0) handleFacebookResults_(items, p.meta, status);
      else if (p.kind.indexOf('ksl') === 0) handleKslCollectorResults_(items, output, p.meta, status);
    } catch (e) {
      logEvent_('error', 'apify:' + p.kind, 'Handler failed: ' + e.message);
    }
    finishedRows.push(p.row);
  });
  finishedRows.sort(function (a, b) { return b - a; }).forEach(removePendingRun_);
}

/**
 * Total cost of a run: platform usage + actor charges. Pay-per-event / pay-per-result charges are not always
 * part of usageTotalUsd, so they are added from the run's pricing info (worst-case tier when unknown).
 */
function apifyRunCost_(run, itemCount) {
  var cost = Number(run.usageTotalUsd || 0);
  var pricing = run.pricingInfo || {};
  var tierPrice = function (obj, flat, tiered) {
    if (!obj) return null;
    if (obj[flat] !== undefined) return Number(obj[flat]);
    var t = obj[tiered];
    if (t) { var vals = Object.keys(t).map(function (k) { var v = t[k]; return Number(typeof v === 'object' ? (v.tieredEventPriceUsd || v.tieredPricePerUnitUsd) : v); }); return Math.max.apply(null, vals); }
    return null;
  };
  if (run.chargedEventCounts) {
    var events = (pricing.pricingPerEvent && pricing.pricingPerEvent.actorChargeEvents) || {};
    Object.keys(run.chargedEventCounts).forEach(function (ev) {
      var n = Number(run.chargedEventCounts[ev]) || 0;
      var price = tierPrice(events[ev], 'eventPriceUsd', 'eventTieredPricingUsd');
      if (price === null) price = /listing/.test(ev) ? FB_PRICE_PER_LISTING : 0;
      cost += n * price;
    });
  } else if (pricing.pricingModel === 'PRICE_PER_DATASET_ITEM') {
    var unit = tierPrice(pricing, 'pricePerUnitUsd', 'tieredPricing');
    cost += itemCount * (unit === null ? FB_PRICE_PER_LISTING : unit);
  }
  return cost;
}
