/**
 * KslEmail.js: primary KSL source. Reads KSL saved-search alert emails from the Gmail label,
 * parses every listing (KslParser.js), queues them, and watches feed health.
 */

/**
 * Gmail groups alerts with the same subject into one thread, and labels are per thread, so we track
 * processed MESSAGE ids in the Seen index ("gmail:<id>") and use the label only as a visual marker.
 */
function kslEmailIntake_() {
  var label = settingStr_('KSL_EMAIL_LABEL');
  var threads = GmailApp.search('label:"' + label + '" newer_than:3d', 0, 30);
  if (!threads.length) return 0;
  var processedLabel = GmailApp.getUserLabelByName(settingStr_('KSL_PROCESSED_LABEL')) || GmailApp.createLabel(settingStr_('KSL_PROCESSED_LABEL'));
  var queued = 0, newest = Number(prop_('kslLastEmailAt') || 0);
  threads.forEach(function (thread) {
    var touched = false;
    thread.getMessages().forEach(function (msg) {
      var mid = 'gmail:' + msg.getId();
      var when = msg.getDate().getTime();
      if (when > newest) newest = when;
      if (isSeen_(mid)) return;
      var items = parseAlertMessage_(msg);
      if (items === null) { markSeen_([mid], 'gmail'); return; } // not an alert (e.g. KSL account email)
      if (!items.length) {
        reportParserFailure_(msg);
      } else {
        queued += enqueueItems_(items, 'KSL');
      }
      markSeen_([mid], 'gmail');
      touched = true;
    });
    if (touched) thread.addLabel(processedLabel);
  });
  setProp_('kslLastEmailAt', newest);
  if (queued) logEvent_('info', 'ksl-email', 'Queued ' + queued + ' new KSL listings');
  maybeEndAutoBackup_(newest);
  return queued;
}

/** Returns normalized items, [] if it looked like an alert but nothing parsed, or null if not an alert. */
function parseAlertMessage_(msg) {
  var html = msg.getBody(), subject = msg.getSubject(), plain = msg.getPlainBody();
  var parsed = parseKslAlertEmail_(html, subject, plain);
  if (!parsed.listings.length && parsed.unresolvedLinks.length) {
    // Click-tracking links: resolve redirects (Location header only; we never load the KSL page here).
    var replaced = html, resolved = 0;
    parsed.unresolvedLinks.slice(0, 15).forEach(function (u) {
      var target = resolveRedirect_(u);
      if (target && kslListingIdFromUrl_(target)) {
        replaced = replaced.split(u).join(target).split(u.replace(/&/g, '&amp;')).join(target);
        resolved++;
      }
    });
    if (resolved) parsed = parseKslAlertEmail_(replaced, subject, plain);
  }
  var looksLikeAlert = /DF\s*[-–]/i.test(subject + ' ' + plain) || /saved search|new listing|alert/i.test(subject);
  if (!parsed.listings.length && !looksLikeAlert) return null;
  var searchName = parsed.searchName || matchSearchName_(subject);
  var isFreeSearch = /free/i.test(searchName);
  var posted = msg.getDate().toISOString();
  return parsed.listings.map(function (it) {
    it.matched_search = searchName;
    if (it.price === null && isFreeSearch) it.price = 0;
    it.posted_at = it.posted_at || posted;
    it.email_date = posted;
    return it;
  });
}

function matchSearchName_(subject) {
  var s = String(subject || '').toLowerCase();
  var hit = getConfig_().kslSearches.filter(function (k) {
    var core = k.name.replace(/^DF\s*-\s*/i, '').toLowerCase();
    return s.indexOf(core) >= 0 || (k.keyword && s.indexOf(k.keyword.toLowerCase()) >= 0);
  })[0];
  return hit ? hit.name : '';
}

/** Follow one redirect hop and return the Location URL (or ''). */
function resolveRedirect_(url) {
  try {
    var r = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
    var h = r.getAllHeaders();
    return h.Location || h.location || '';
  } catch (e) { return ''; }
}

function reportParserFailure_(msg) {
  logEvent_('error', 'ksl-email', 'KSL email format changed: 0 listings parsed from "' + msg.getSubject() + '"', '', { messageId: msg.getId() });
  if (prop_('kslParseAlertDay') !== todayKey_()) {
    setProp_('kslParseAlertDay', todayKey_());
    alert_('KSL email format changed', 'An alert email arrived ("' + truncate_(msg.getSubject(), 80) +
      '") but no listings could be read from it. Run Deal Finder → Capture KSL email samples so the parser can be updated.');
  }
}

// ---------------------------------------------------------------------------
// Feed health

/** If no alert email for KSL_HEALTH_HOURS during active hours: alert, and optionally switch on backup mode. */
function kslFeedHealthCheck_() {
  var h = localParts_().hour;
  if (!hourInRange_(h, settingNum_('KSL_HEALTH_ACTIVE_START'), settingNum_('KSL_HEALTH_ACTIVE_END'))) return;
  var last = Number(prop_('kslLastEmailAt') || 0);
  if (!last) {
    var t = GmailApp.search('label:"' + settingStr_('KSL_EMAIL_LABEL') + '"', 0, 1);
    if (t.length) { last = t[0].getLastMessageDate().getTime(); setProp_('kslLastEmailAt', last); }
  }
  var hours = (nowMs_() - last) / 3600000;
  if (last && hours < settingNum_('KSL_HEALTH_HOURS')) return;
  var msg = 'No KSL alert emails for ' + (last ? Math.round(hours) + ' hours' : 'a long time') + '. ';
  if (settingBool_('KSL_BACKUP_MODE')) {
    logEvent_('warn', 'ksl-health', msg + 'Backup collector already on.');
    return;
  }
  if (settingBool_('KSL_AUTO_BACKUP')) {
    writeSetting_('KSL_BACKUP_MODE', true);
    setProp_('kslBackupAuto', '1');
    alert_('KSL emails stopped', msg + 'Backup collector switched ON automatically. It turns itself off when emails resume.');
  } else if (prop_('kslHealthAlertAt') === '' || nowMs_() - Number(prop_('kslHealthAlertAt')) > 6 * 3600000) {
    setProp_('kslHealthAlertAt', nowMs_());
    alert_('KSL emails stopped', msg + 'Check the KSL saved searches / Gmail filter. To poll KSL directly meanwhile, set KSL_BACKUP_MODE to TRUE in Settings (or set KSL_AUTO_BACKUP to TRUE to do this automatically).');
  }
}

/** Turn backup mode off again if WE turned it on and emails are flowing again. */
function maybeEndAutoBackup_(newestEmailMs) {
  if (prop_('kslBackupAuto') !== '1' || !settingBool_('KSL_BACKUP_MODE')) return;
  if (nowMs_() - newestEmailMs < 60 * 60000) {
    writeSetting_('KSL_BACKUP_MODE', false);
    setProp_('kslBackupAuto', '');
    alert_('KSL emails resumed', 'Backup collector switched OFF again.');
  }
}

// ---------------------------------------------------------------------------
// Parser development helper (menu item)

/**
 * Save the 10 most recent KSL alert emails as .html files in a Drive folder and write what the
 * parser extracted from each into a "Parser test" tab. Use this to check or update the parser.
 */
function captureKslEmailSamples() {
  var threads = GmailApp.search('label:"' + settingStr_('KSL_EMAIL_LABEL') + '"', 0, 10);
  var root = DriveApp.getFolderById(requireProp_(PROP.DRIVE_FOLDER_ID));
  var it = root.getFoldersByName('KSL email samples');
  var folder = it.hasNext() ? it.next() : root.createFolder('KSL email samples');
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('Parser test') || ss.insertSheet('Parser test');
  sh.clear();
  sh.appendRow(['Email date', 'Subject', 'Search name', 'Listing ID', 'Title', 'Price', 'City', 'Image', 'Unresolved links']);
  var count = 0;
  threads.forEach(function (t) {
    var msg = t.getMessages().slice(-1)[0];
    var name = Utilities.formatDate(msg.getDate(), TZ, 'yyyyMMdd-HHmm') + '-' + msg.getId() + '.html';
    folder.createFile(name, msg.getBody(), MimeType.HTML);
    var parsed = parseKslAlertEmail_(msg.getBody(), msg.getSubject(), msg.getPlainBody());
    if (!parsed.listings.length) sh.appendRow([msg.getDate(), msg.getSubject(), parsed.searchName, '(none parsed)', '', '', '', '', parsed.unresolvedLinks.length]);
    parsed.listings.forEach(function (l) {
      sh.appendRow([msg.getDate(), msg.getSubject(), parsed.searchName, l.listing_id, l.title, l.price, l.city, l.image_url, parsed.unresolvedLinks.length]);
    });
    count++;
  });
  safeAlert_('Saved ' + count + ' emails to Drive folder "KSL email samples" and wrote parse results to the "Parser test" tab.\n' + folder.getUrl());
}
