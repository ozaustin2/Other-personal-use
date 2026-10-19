/**
 * Main.js: the scheduler. A single time trigger calls tick() every 5 minutes; tick decides what is due
 * using the Settings tab, so schedules change without recreating triggers.
 */

function tick() {
  var started = nowMs_();
  // Free Google accounts get 90 min/day of trigger runtime: overnight (quiet hours) run every 15 min only.
  if (isQuietHours_() && nowMs_() - Number(prop_('lastTickAt') || 0) < 14 * 60000 && queueLength_() === 0) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('tick: previous tick still running'); return; }
  setProp_('lastTickAt', started);
  resetConfigCache_();
  try {
    runJob_('notify', releaseHeldNotifications_);
    runJob_('apify-poll', pollApifyRuns_);
    runJob_('ksl-email', kslEmailIntake_);
    runJob_('queue', function () { processQueue_(started); }); // free KSL items get scored right away
    runScheduledJobs_();
    if (nowMs_() - started < TICK_BUDGET_MS) runJob_('queue', function () { processQueue_(started); });
  } finally {
    lock.releaseLock();
    var prev = (prop_('count:runtimeSec') || '').split('|');
    if (prev[0] && prev[0] !== todayKey_()) setProp_('runtimeYesterday', prev[1]); // first tick of a new day
    var secs = bumpDaily_('runtimeSec', Math.round((nowMs_() - started) / 1000));
    if (secs > 75 * 60 && prop_('runtimeAlertDay') !== todayKey_()) {
      setProp_('runtimeAlertDay', todayKey_());
      alert_('Apps Script runtime high', 'Triggers ran ' + Math.round(secs / 60) + ' min today (free Google accounts allow 90). Consider raising FB_FREE_INTERVAL_MIN or lowering SONNET_DAILY_CAP.');
    }
  }
}

function runJob_(name, fn) {
  try { fn(); } catch (e) { logEvent_('error', name, e.message + (e.stack ? ' | ' + truncate_(e.stack, 500) : '')); }
}

function runScheduledJobs_() {
  var h = localParts_().hour;

  // Facebook free sweep: every N minutes during active hours.
  if (hourInRange_(h, settingNum_('FB_FREE_ACTIVE_START'), settingNum_('FB_FREE_ACTIVE_END')) &&
      intervalDue_('lastFbFree', Math.max(15, settingNum_('FB_FREE_INTERVAL_MIN')))) {
    markInterval_('lastFbFree');
    runJob_('fb-free', facebookFreeSweep_);
  }

  // Facebook paid sweeps at set times.
  dueSlots_(settingTimes_('FB_PAID_TIMES'), 'slotFbPaid:').forEach(function (slot) {
    slot.markDone();
    runJob_('fb-paid', facebookPaidSweep_);
  });

  // KSL feed health check.
  if (intervalDue_('lastKslHealth', settingNum_('KSL_HEALTH_INTERVAL_MIN') || 120)) {
    markInterval_('lastKslHealth');
    runJob_('ksl-health', kslFeedHealthCheck_);
  }

  // KSL backup mode (only when the email feed is broken or the toggle is on).
  if (settingBool_('KSL_BACKUP_MODE')) {
    if (intervalDue_('lastKslBackupFree', settingNum_('KSL_BACKUP_FREE_INTERVAL_MIN') || 20)) {
      markInterval_('lastKslBackupFree');
      runJob_('ksl-backup', function () { kslBackupPoll_('free'); });
    }
    dueSlots_(settingTimes_('KSL_BACKUP_PAID_TIMES'), 'slotKslPaid:').forEach(function (slot) {
      slot.markDone();
      runJob_('ksl-backup', function () { kslBackupPoll_('paid'); });
    });
  }

  // Baseline that didn't fit in one day's page cap continues the next morning.
  if (prop_('kslBaselineRemaining') && prop_('kslBaselineRemaining') !== '[]' && h >= 6 && prop_('kslBaselineContinued') !== todayKey_()) {
    setProp_('kslBaselineContinued', todayKey_());
    runJob_('ksl-baseline', continueKslBaseline_);
  }

  // Digests.
  dueSlots_(settingTimes_('DIGEST_TIMES'), 'slotDigest:').forEach(function (slot) {
    slot.markDone();
    runJob_('digest', function () { sendDigest_(slot.time === settingStr_('TOP10_DIGEST_TIME')); });
  });
  if (prop_('baselineDigestPending') === '1') runJob_('digest', sendBaselineDigestIfReady_);

  // Daily housekeeping.
  dueSlots_(['03:00'], 'slotHousekeeping:').forEach(function (slot) {
    slot.markDone();
    runJob_('housekeeping', housekeeping_);
  });
}

// ---------------------------------------------------------------------------
// Digests

/** Push held paid deals (and on the evening slot, the top 10 of the day) as one summary. */
function sendDigest_(includeTop10) {
  var sh = getSheet_(SHEETS.DEALS);
  if (sh.getLastRow() < 2) return;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, DEAL_COLS.length).getValues();
  var col = function (k) { return dealColIndex_(k) - 1; };
  var pending = [], today = [];
  var todayStr = todayKey_();
  data.forEach(function (r, i) {
    if (r[col('notified')] === 'digest') pending.push({ row: i + 2, r: r });
    var d = r[col('date_found')];
    if (d instanceof Date && Utilities.formatDate(d, TZ, 'yyyy-MM-dd') === todayStr && r[col('notified')] !== 'baseline') today.push(r);
  });
  var byScore = function (a, b) { return (b.r || b)[col('opportunity_score')] - (a.r || a)[col('opportunity_score')]; };
  pending.sort(byScore);
  var line = function (r) {
    return '• ' + r[col('opportunity_score')] + '/10 ' + truncate_(r[col('title')], 50) + ' · ' + (r[col('price')] === 0 ? 'FREE' : '$' + r[col('price')]) +
      ' · +$' + Math.round(r[col('est_profit')] || 0) + (r[col('distance_miles')] !== '' ? ' · ' + r[col('distance_miles')] + 'mi' : '');
  };
  var parts = [];
  var worth = pending.filter(function (p) { return p.r[col('opportunity_score')] >= 5; });
  if (worth.length) parts.push('**New since last digest (' + worth.length + ')**\n' + worth.slice(0, 8).map(function (p) { return line(p.r); }).join('\n'));
  if (includeTop10 && today.length) {
    today.sort(byScore);
    parts.push('**Top ' + Math.min(10, today.length) + ' today**\n' + today.slice(0, 10).map(line).join('\n'));
  }
  pending.forEach(function (p) { sh.getRange(p.row, dealColIndex_('notified')).setValue('digest-sent'); });
  if (includeTop10) sortDeals_();
  if (!parts.length) return;
  notify_({ title: includeTop10 ? '📋 Evening deal digest' : '📋 Deal digest', body: parts.join('\n\n'), clickUrl: dashboardUrl_(), priority: 3, tags: ['clipboard'] });
}

function sortDeals_() {
  var sh = getSheet_(SHEETS.DEALS);
  if (sh.getLastRow() < 3) return;
  sh.getRange(2, 1, sh.getLastRow() - 1, DEAL_COLS.length)
    .sort([{ column: dealColIndex_('opportunity_score'), ascending: false }, { column: dealColIndex_('date_found'), ascending: false }]);
}

/** One-time "Baseline results" digest, sent once every baseline item has been scored. */
function sendBaselineDigestIfReady_() {
  var q = getSheet_(SHEETS.QUEUE);
  if (q.getLastRow() > 1) {
    var stillQueued = q.getRange(2, 4, q.getLastRow() - 1, 1).getValues().some(function (r) { return String(r[0]).indexOf('"baseline":true') >= 0; });
    if (stillQueued) return;
  }
  setProp_('baselineDigestPending', '');
  var sh = getSheet_(SHEETS.DEALS);
  var data = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, DEAL_COLS.length).getValues() : [];
  var col = function (k) { return dealColIndex_(k) - 1; };
  var base = data.filter(function (r) { return r[col('notified')] === 'baseline'; })
    .sort(function (a, b) { return b[col('opportunity_score')] - a[col('opportunity_score')]; });
  var body = base.length
    ? base.slice(0, 12).map(function (r) {
        return '• ' + r[col('opportunity_score')] + '/10 ' + truncate_(r[col('title')], 50) + ' · ' + (r[col('price')] === 0 ? 'FREE' : '$' + r[col('price')]) + ' · +$' + Math.round(r[col('est_profit')] || 0);
      }).join('\n') + '\n\nAll ' + base.length + ' are on the dashboard (filter Source = KSL (baseline)).'
    : 'No keepers in the existing KSL listings.';
  notify_({ title: '📦 KSL baseline results', body: body, clickUrl: dashboardUrl_(), priority: 3, tags: ['package'] });
}

// ---------------------------------------------------------------------------
// Housekeeping

function housekeeping_() {
  expireSeen_();
  var logs = getSheet_(SHEETS.LOGS);
  var max = 8000;
  if (logs.getLastRow() > max + 1000) {
    // Keep cost rows for this month (budget math) by only trimming entries older than 40 days.
    var n = logs.getLastRow() - 1;
    var dates = logs.getRange(2, 1, n, 1).getValues();
    var cutoff = nowMs_() - 40 * 86400000, del = 0;
    while (del < n - max && dates[del][0] instanceof Date && dates[del][0].getTime() < cutoff) del++;
    if (del) logs.deleteRows(2, del);
  }
  var proj = projectedMonthCost_('apify'), projC = projectedMonthCost_('claude');
  logEvent_('info', 'housekeeping', 'Yesterday\'s trigger runtime ≈ ' + Math.round(Number(prop_('runtimeYesterday') || 0) / 60) + ' min. Projected month: Apify $' + proj + ' (budget $' + settingNum_('APIFY_MONTHLY_BUDGET') + '), Claude $' + projC +
    ' (budget $' + settingNum_('CLAUDE_MONTHLY_BUDGET') + '); queue ' + queueLength_());
}
