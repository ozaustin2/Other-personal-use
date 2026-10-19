/**
 * Pipeline.js: Queue → rule filter → distance → AI filter → (KSL detail) → valuation → score → Deals → push.
 *
 * Normalized item shape (all sources):
 * {deal_id, source: 'Facebook'|'KSL'|'KSL (baseline)'|'Share', listing_id, title, price (0 = free, null = unknown),
 *  city, state, zip, lat, lng, url, image_url, image_urls[], description, posted_at (ISO), category_hint,
 *  matched_search, condition, baseline (bool)}
 *
 * Queue stages: new → filtered → (detail) → done (row removed).
 */

var TICK_BUDGET_MS = 4.5 * 60 * 1000;

/** Process queued items until the batch size or time budget runs out. */
function processQueue_(startedAt) {
  var batch = Math.max(1, settingNum_('QUEUE_BATCH') || 15);
  var entries = readQueue_(batch * 2);
  if (!entries.length) return 0;
  var done = [];
  var processed = 0;

  // Stage "new": rule filter, distance, then one AI filter call for the survivors.
  var fresh = entries.filter(function (e) { return e.stage === 'new' && e.item; });
  var bad = entries.filter(function (e) { return !e.item; });
  bad.forEach(function (e) { done.push(e.row); });
  var toAi = [];
  fresh.forEach(function (e) {
    var it = e.item;
    var reason = ruleFilter_(it);
    if (!reason) {
      it.distance_miles = distanceFromHome_(it);
      if (it.distance_miles !== null && it.distance_miles > settingNum_('TIER3_MI')) reason = 'too far (' + it.distance_miles + ' mi)';
    }
    if (!reason && it.baseline && it.posted_at) {
      var age = (nowMs_() - new Date(it.posted_at).getTime()) / 86400000;
      if (age > settingNum_('KSL_BASELINE_MAX_AGE_DAYS')) reason = 'baseline: older than ' + settingNum_('KSL_BASELINE_MAX_AGE_DAYS') + ' days';
    }
    if (reason) { appendFiltered_(it, reason); done.push(e.row); processed++; }
    else toAi.push(e);
  });

  for (var i = 0; i < toAi.length; i += 20) {
    var chunk = toAi.slice(i, i + 20);
    var verdicts;
    try {
      verdicts = aiFilterBatch_(chunk.map(function (e) { return e.item; }));
    } catch (err) {
      logEvent_('error', 'filter', err.message);
      break; // leave them queued; retry next tick
    }
    chunk.forEach(function (e, j) {
      var v = verdicts[j], it = e.item;
      if (!v.keep) { appendFiltered_(it, 'AI: ' + v.reason); done.push(e.row); processed++; return; }
      it.category = v.category;
      it.quick_resale_guess = v.quick_resale_guess;
      it.needs_detail = v.needs_detail;
      e.stage = 'filtered';
      updateQueueEntry_(e.row, 'filtered', it);
    });
  }

  // Stage "filtered": optional KSL detail fetch, then valuation.
  var ready = entries.filter(function (e) { return e.stage === 'filtered' && e.item && done.indexOf(e.row) < 0; });
  for (var k = 0; k < ready.length && processed < batch; k++) {
    if (nowMs_() - startedAt > TICK_BUDGET_MS) break;
    var e = ready[k], it = e.item;
    try {
      if (/^KSL/.test(it.source) && !it.detail_fetched && wantsKslDetail_(it)) {
        enrichFromKslDetail_(it); // polite fetch; sets detail_fetched even if it fails
      }
      valuateAndRecord_(it);
      done.push(e.row);
      processed++;
    } catch (err) {
      logEvent_('error', 'value', (it.title || it.deal_id) + ': ' + err.message);
      it.attempts = (it.attempts || 0) + 1;
      if (it.attempts >= 3) { appendFiltered_(it, 'error: ' + truncate_(err.message, 120)); done.push(e.row); }
      else updateQueueEntry_(e.row, 'filtered', it);
    }
  }
  removeQueueRows_(done);
  return processed;
}

function wantsKslDetail_(it) {
  if (!settingBool_('KSL_DETAIL_FETCH')) return false;
  if (it.description && it.description.length > 40) return false;
  return detailWorthy_(it) || it.needs_detail;
}

/** Value one item (full or quick), append it to Deals and push if it qualifies. */
function valuateAndRecord_(it) {
  var val = null;
  var quickProfit = (Number(it.quick_resale_guess) || 0) - (Number(it.price) || 0);
  var capOk = dailyCount_('valuations') < settingNum_('VALUE_DAILY_CAP');
  var budgetOk = monthCost_('claude') < settingNum_('CLAUDE_MONTHLY_BUDGET');
  var worthIt = quickProfit >= settingNum_('VALUE_MIN_QUICK_PROFIT') || it.source === 'Share';

  if (!worthIt) {
    appendFiltered_(it, 'low quick value (resale ~$' + Math.round(it.quick_resale_guess || 0) + ')');
    return;
  }
  if (capOk && budgetOk) {
    var comps = null;
    try { comps = ebayComps_(it.title); } catch (e) { logEvent_('warn', 'ebay', e.message); }
    val = aiValuate_(it, comps);
    bumpDaily_('valuations');
  } else {
    if (!budgetOk && !prop_('claudeBudgetAlert:' + monthKey_())) {
      setProp_('claudeBudgetAlert:' + monthKey_(), '1');
      alert_('Claude budget reached', 'Month-to-date Claude cost is over $' + settingNum_('CLAUDE_MONTHLY_BUDGET') + '. Using quick estimates only until next month (raise CLAUDE_MONTHLY_BUDGET in Settings to resume).');
    }
    val = quickValuation_(it, capOk ? 'monthly Claude budget reached' : 'daily valuation cap reached');
  }

  Object.keys(val).forEach(function (key) { it[key] = val[key]; });
  var scored = computeScore_(it, val, tiersFromSettings_(), hoursFromSettings_(), getConfig_().weights);
  Object.keys(scored).forEach(function (key) { it[key] = scored[key]; });
  it.ai_score = val.opportunity_score;
  it.opportunity_score = scored.opportunity_score;

  var decision = pushDecision_(it);
  it.notified = decision;
  var row = appendDeal_(it);
  if (decision === 'push') {
    var r = notifyDeal_(it);
    setDealField_(row, 'notified', r === 'sent' ? 'pushed' : r);
  }
}

/** Fallback valuation from the cheap model's quick guess (no extra AI call). */
function quickValuation_(it, why) {
  var guess = Number(it.quick_resale_guess) || 0;
  var profit = guess - (Number(it.price) || 0);
  return {
    item_type: it.category || 'unknown', category: it.category || 'other', brand_model_guess: '', condition_guess: 'unknown', likely_fault: '',
    est_resale_low: Math.round(guess * 0.7), est_resale_high: Math.round(guess), est_parts_cost: 0, est_repair_hours: 1,
    repair_difficulty: 3, pickup_effort: 3, demand: 3,
    opportunity_score: profit >= 300 ? 7 : profit >= 150 ? 6 : profit >= 60 ? 5 : 3,
    reasoning: 'Quick estimate only (' + why + '). Open the listing to judge.'
  };
}

/** 'push' | 'digest' | 'baseline' */
function pushDecision_(it) {
  if (it.baseline) return 'baseline';
  var free = it.price === 0;
  var min = free ? settingNum_('FREE_PUSH_MIN_SCORE') : settingNum_('PAID_PUSH_MIN_SCORE');
  return it.opportunity_score >= min ? 'push' : 'digest';
}
