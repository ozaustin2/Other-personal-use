/**
 * Setup.js: Sheet menu, one-click setup (tabs, formatting, Settings, tokens, Drive folder, home location),
 * trigger installation and a setup self-check.
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Deal Finder')
    .addItem('1. Set up / repair Sheet', 'setup')
    .addItem('2. Check setup', 'checkSetup')
    .addItem('3. Install schedules (triggers)', 'installTriggers')
    .addSeparator()
    .addItem('Run tick now', 'tick')
    .addItem('Run Facebook free sweep now', 'menuFacebookFree')
    .addItem('Run Facebook paid sweep now', 'menuFacebookPaid')
    .addItem('Read KSL alert emails now', 'menuKslEmail')
    .addItem('Run KSL baseline', 'runKslBaseline')
    .addItem('Capture KSL email samples', 'captureKslEmailSamples')
    .addSeparator()
    .addItem('Send test push', 'sendTestPush')
    .addItem('Send digest now', 'menuDigest')
    .addItem('Recalibrate category weights from Sales log', 'recalibrateWeights')
    .addItem('Show dashboard link', 'showDashboardLink')
    .addSeparator()
    .addItem('Pause everything (remove triggers)', 'removeTriggers')
    .addToUi();
}

/** UI alert when run from the Sheet, log otherwise (triggers/web app have no UI). */
function safeAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

function menuFacebookFree() { resetConfigCache_(); facebookFreeSweep_(); safeAlert_('Started. Results arrive within ~5–10 minutes (next tick).'); }
function menuFacebookPaid() { resetConfigCache_(); facebookPaidSweep_(); safeAlert_('Started. Results arrive within ~5–10 minutes.'); }
function menuKslEmail() { resetConfigCache_(); var n = kslEmailIntake_(); processQueue_(nowMs_()); safeAlert_('Queued ' + n + ' new KSL listings and processed the queue.'); }
function menuDigest() { resetConfigCache_(); sendDigest_(true); }

// ---------------------------------------------------------------------------

/** Create/repair every tab, write default Settings (keeps your edits), generate tokens, create Drive folder. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet() || getSpreadsheet_();
  setProp_(PROP.SHEET_ID, ss.getId());
  ss_ = ss;
  ss.setSpreadsheetTimeZone(TZ);

  ensureTab_(ss, SHEETS.DEALS, DEAL_COLS.map(function (c) { return c[0]; }));
  ensureTab_(ss, SHEETS.FILTERED, FILTERED_COLS);
  ensureTab_(ss, SHEETS.SALES, SALES_COLS);
  ensureTab_(ss, SHEETS.LOGS, LOG_COLS);
  ensureTab_(ss, SHEETS.SEEN, SEEN_COLS).hideSheet();
  ensureTab_(ss, SHEETS.QUEUE, QUEUE_COLS).hideSheet();
  ensureTab_(ss, SHEETS.RUNS, RUNS_COLS).hideSheet();
  writeSettingsTab_(ss);
  formatDeals_(ss.getSheetByName(SHEETS.DEALS));
  var sales = ss.getSheetByName(SHEETS.SALES);
  // Actual Profit = Sale Price − Bought Price − Parts Cost
  sales.getRange(2, SALES_COLS.indexOf('Actual Profit') + 1, 999, 1).setFormulaR1C1('=IF(RC[-3]="","",RC[-3]-RC[-6]-RC[-5])');

  var def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  if (!prop_(PROP.SHARE_TOKEN)) setProp_(PROP.SHARE_TOKEN, Utilities.getUuid().replace(/-/g, ''));
  if (!prop_(PROP.DASHBOARD_KEY)) setProp_(PROP.DASHBOARD_KEY, Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  if (!prop_(PROP.DRIVE_FOLDER_ID)) {
    var folder = DriveApp.createFolder('Deal Finder Photos');
    setProp_(PROP.DRIVE_FOLDER_ID, folder.getId());
  }
  resetConfigCache_();
  var home = homeLatLng_();
  ss.setActiveSheet(ss.getSheetByName(SHEETS.DEALS));
  safeAlert_('Setup done.\nHome ' + settingStr_('HOME_ZIP') + ': ' + (home ? home.lat.toFixed(4) + ', ' + home.lng.toFixed(4) : 'not geocoded yet') +
    '\nPhotos folder: ' + DriveApp.getFolderById(prop_(PROP.DRIVE_FOLDER_ID)).getUrl() +
    '\n\nNext: Deal Finder → Check setup.');
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
  } else {
    var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join('|') !== headers.join('|')) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

function formatDeals_(sh) {
  var n = Math.max(sh.getMaxRows() - 1, 1);
  var scoreCol = dealColIndex_('opportunity_score');
  var scoreRange = sh.getRange(2, scoreCol, n, 1);
  var all = sh.getRange(2, 1, n, DEAL_COLS.length);
  var rules = [
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($A2),$A2>=8)').setBackground('#c8e6c9').setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($A2),$A2>=5,$A2<=7)').setBackground('#fff9c4').setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND(ISNUMBER($A2),$A2<=4)').setBackground('#eeeeee').setFontColor('#757575').setRanges([all]).build()
  ];
  sh.setConditionalFormatRules(rules);
  scoreRange.setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange(2, dealColIndex_('status'), n, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  sh.setRowHeightsForced(2, n, 64);
  sh.setColumnWidth(dealColIndex_('thumbnail_formula'), 90);
  sh.setColumnWidth(dealColIndex_('title'), 260);
  sh.setColumnWidth(dealColIndex_('reasoning'), 380);
  sh.getRange(2, dealColIndex_('reasoning'), n, 1).setWrap(true);
  ['price', 'est_profit', 'profit_per_hour', 'est_resale_low', 'est_resale_high', 'est_parts_cost'].forEach(function (k) {
    sh.getRange(2, dealColIndex_(k), n, 1).setNumberFormat('$#,##0');
  });
  sh.getRange(2, dealColIndex_('date_found'), n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.hideColumns(dealColIndex_('data_json'));
}

/** Write Settings sections. Existing values are preserved; missing keys/sections are added. */
function writeSettingsTab_(ss) {
  var sh = ss.getSheetByName(SHEETS.SETTINGS) || ss.insertSheet(SHEETS.SETTINGS, 1);
  var existing = sh.getLastRow() ? parseSettingsValues_(sh.getDataRange().getValues()) : null;
  var hadSections = existing && sh.getLastRow() > 5;
  var rows = [];
  var pad = function (r) { while (r.length < 8) r.push(''); return r; };

  rows.push(pad([SECTION.SETTINGS, 'Edit column B. Secrets (API keys) are NOT here: they live in Script Properties.']));
  rows.push(pad(['Key', 'Value', 'Description']));
  DEFAULT_SETTINGS.forEach(function (r) {
    var v = existing && existing.kv.hasOwnProperty(r[0]) && hadSections ? existing.kv[r[0]] : r[1];
    rows.push(pad([r[0], v, r[2]]));
  });
  rows.push(pad(['']));
  rows.push(pad([SECTION.KEYWORDS, 'Applies to Facebook paid sweeps (KSL uses your saved searches below). Blank max = no max.']));
  rows.push(pad(['Keyword', 'Radius (mi)', 'Max price', 'Enabled']));
  (hadSections && existing.keywords.length ? existing.keywords.map(function (k) { return [k.keyword, k.radius, k.maxPrice === null ? '' : k.maxPrice, k.enabled]; }) : DEFAULT_KEYWORDS)
    .forEach(function (r) { rows.push(pad(r.slice())); });
  rows.push(pad(['']));
  rows.push(pad([SECTION.FB_CATEGORIES, 'Facebook paid category sweeps. Slug = the part after facebook.com/marketplace/<city>/']));
  rows.push(pad(['Name', 'Facebook slug', 'Max price', 'Enabled']));
  (hadSections && existing.fbCategories.length ? existing.fbCategories.map(function (c) { return [c.name, c.slug, c.maxPrice === null ? '' : c.maxPrice, c.enabled]; }) : DEFAULT_FB_CATEGORIES)
    .forEach(function (r) { rows.push(pad(r.slice())); });
  rows.push(pad(['']));
  rows.push(pad([SECTION.KSL_SEARCHES, 'Mirror of your KSL saved searches (do not recreate them on KSL). Used by the baseline/backup collector.']));
  rows.push(pad(['Name', 'Type', 'Category', 'Subcategory', 'Keyword', 'Radius (mi)', 'Max price (0 = free, blank = none)', 'Baseline pages']));
  (hadSections && existing.kslSearches.length ? existing.kslSearches.map(function (s) {
    return [s.name, s.type, s.category, s.subcategory, s.keyword, s.radius, s.maxPrice === null ? '' : s.maxPrice, s.baselinePages];
  }) : DEFAULT_KSL_SEARCHES).forEach(function (r) { rows.push(pad(r.slice())); });
  rows.push(pad(['']));
  rows.push(pad([SECTION.WEIGHTS, 'Score multiplier per category. "Recalibrate category weights" adjusts these from the Sales log.']));
  rows.push(pad(['Category', 'Weight']));
  var weights = hadSections && Object.keys(existing.weights).length ? Object.keys(existing.weights).map(function (k) { return [k, existing.weights[k]]; }) : DEFAULT_WEIGHTS;
  weights.forEach(function (r) { rows.push(pad(r.slice())); });

  sh.clear();
  sh.getRange(1, 1, rows.length, 8).setValues(rows);
  rows.forEach(function (r, i) {
    if (String(r[0]).indexOf('## ') === 0) sh.getRange(i + 1, 1, 1, 8).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    else if (['Key', 'Keyword', 'Name', 'Category'].indexOf(r[0]) >= 0) sh.getRange(i + 1, 1, 1, 8).setFontWeight('bold').setBackground('#e8eaed');
  });
  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 200); sh.setColumnWidth(3, 420);
  sh.setFrozenRows(0);
  resetConfigCache_();
}

// ---------------------------------------------------------------------------
// Triggers

function installTriggers() {
  removeTriggers(true);
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onDealsEdit').forSpreadsheet(getSpreadsheet_()).onEdit().create();
  logEvent_('info', 'setup', 'Triggers installed: tick every 5 min, onEdit');
  safeAlert_('Schedules installed: one 5-minute "tick" runs every job when its time comes (times are in the Settings tab), plus a Status-change watcher.');
}

function removeTriggers(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (silent !== true) safeAlert_('All triggers removed. Nothing runs until you choose "Install schedules" again.');
}

/** Installable onEdit: create the photo folder when Status moves to Picked Up / Repairing / Listed. */
function onDealsEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== SHEETS.DEALS || e.range.getColumn() !== dealColIndex_('status') || e.range.getRow() < 2) return;
    if (['Picked Up', 'Repairing', 'Listed'].indexOf(String(e.value)) >= 0) ensureDealFolder_(e.range.getRow());
  } catch (err) {
    logEvent_('error', 'onEdit', err.message);
  }
}

// ---------------------------------------------------------------------------
// Self-check

function checkSetup() {
  resetConfigCache_();
  var lines = [];
  var ok = function (cond, label, fix) { lines.push((cond ? '✅ ' : '❌ ') + label + (cond || !fix ? '' : ' (' + fix + ')')); return cond; };
  ok(!!getSheet_(SHEETS.DEALS) && !!getSheet_(SHEETS.SETTINGS), 'Sheet tabs', 'run Set up');
  ok(!!prop_(PROP.DRIVE_FOLDER_ID), 'Drive photo folder', 'run Set up');
  ok(!!(prop_(PROP.HOME_LAT) && prop_(PROP.HOME_LNG)), 'Home location geocoded', 'run Set up');
  [PROP.ANTHROPIC_API_KEY, PROP.APIFY_TOKEN, PROP.EBAY_APP_ID, PROP.EBAY_CERT_ID, PROP.NTFY_TOPIC].forEach(function (k) {
    ok(!!prop_(k), k + ' in Script Properties', 'Project Settings → Script Properties');
  });
  if (prop_(PROP.ANTHROPIC_API_KEY)) {
    try {
      var r = http_('https://api.anthropic.com/v1/models/' + settingStr_('MODEL_FILTER'), { headers: { 'x-api-key': prop_(PROP.ANTHROPIC_API_KEY), 'anthropic-version': '2023-06-01' } }, 0);
      ok(r.code === 200, 'Anthropic key works (' + settingStr_('MODEL_FILTER') + ')', 'HTTP ' + r.code);
    } catch (e) { ok(false, 'Anthropic key', e.message); }
  }
  if (prop_(PROP.APIFY_TOKEN)) {
    var a = http_(APIFY_API + '/users/me', { headers: apifyHeaders_() }, 0);
    ok(a.code === 200, 'Apify token works' + (a.json && a.json.data ? ' (' + a.json.data.username + ')' : ''), 'HTTP ' + a.code);
  }
  if (prop_(PROP.EBAY_APP_ID)) ok(!!ebayToken_(), 'eBay keys work', 'check App ID / Cert ID (Production keys)');
  var label = GmailApp.getUserLabelByName(settingStr_('KSL_EMAIL_LABEL'));
  ok(!!label, 'Gmail label "' + settingStr_('KSL_EMAIL_LABEL') + '" exists');
  if (label) ok(label.getThreads(0, 1).length > 0, 'KSL Alerts label has emails');
  ok(!!settingStr_('KSL_ACTOR_ID'), 'KSL_ACTOR_ID set in Settings', 'after apify push');
  ok(!!prop_(PROP.WEBAPP_URL), 'Dashboard deployed (WEBAPP_URL)', 'Deploy → New deployment, then open the dashboard once');
  var trig = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ok(trig.indexOf('tick') >= 0, 'Schedules installed', 'menu 3');
  lines.push('');
  lines.push('Apify month-to-date $' + monthCost_('apify') + ', projected $' + projectedMonthCost_('apify') + ' / budget $' + settingNum_('APIFY_MONTHLY_BUDGET'));
  lines.push('Claude month-to-date $' + monthCost_('claude') + ', projected $' + projectedMonthCost_('claude') + ' / budget $' + settingNum_('CLAUDE_MONTHLY_BUDGET'));
  logEvent_('info', 'check', lines.join(' | '));
  safeAlert_(lines.join('\n'));
  return lines;
}
