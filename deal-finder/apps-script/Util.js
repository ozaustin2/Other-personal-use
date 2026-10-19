/**
 * Util.js: time, distance, geocoding, HTTP and logging helpers.
 */

var TZ = 'America/Denver';

function nowMs_() { return Date.now(); }

/** Hour/minute in the script time zone. */
function localParts_(date) {
  var d = date || new Date();
  var s = Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH mm');
  var p = s.split(' ');
  return { day: p[0], hour: Number(p[1]), minute: Number(p[2]) };
}

function todayKey_() { return localParts_().day; }

function monthKey_(date) { return Utilities.formatDate(date || new Date(), TZ, 'yyyy-MM'); }

function fmtTime_(date) { return Utilities.formatDate(date || new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

/** True when `hour` is in [start, end) handling ranges that wrap midnight. */
function hourInRange_(hour, start, end) {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function isQuietHours_() {
  var h = localParts_().hour;
  return hourInRange_(h, settingNum_('QUIET_START'), settingNum_('QUIET_END'));
}

/**
 * Which "HH:MM" times from `times` are due now and not yet done today.
 * `doneKeyPrefix` is stored in Script Properties per time so each slot fires once per day.
 * A slot counts as due from its time until 3 hours later (missed ticks catch up).
 */
function dueSlots_(times, doneKeyPrefix) {
  var p = localParts_();
  var nowMin = p.hour * 60 + p.minute;
  var props = PropertiesService.getScriptProperties();
  var due = [];
  times.forEach(function (t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return;
    var slotMin = Number(m[1]) * 60 + Number(m[2]);
    if (nowMin < slotMin || nowMin > slotMin + 180) return;
    var key = doneKeyPrefix + t;
    if (props.getProperty(key) === p.day) return;
    due.push({ time: t, markDone: function () { props.setProperty(key, p.day); } });
  });
  return due;
}

/** True if at least `minutes` have passed since the timestamp stored under `key`; does NOT update. */
function intervalDue_(key, minutes) {
  var last = Number(prop_(key) || 0);
  return nowMs_() - last >= minutes * 60 * 1000 - 30 * 1000; // 30s slack for trigger jitter
}

function markInterval_(key) { setProp_(key, nowMs_()); }

// ---------------------------------------------------------------------------
// Distance & geocoding

function haversineMiles_(lat1, lng1, lat2, lng2) {
  var R = 3958.8;
  var toRad = function (x) { return x * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Geocode a free-text place ("Bluffdale, UT" or "84065"). Cached for 30 days in CacheService + properties. */
function geocode_(query) {
  if (!query) return null;
  var key = 'geo:' + String(query).toLowerCase().replace(/\s+/g, ' ').trim();
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return hit === 'null' ? null : JSON.parse(hit);
  var docProps = PropertiesService.getDocumentProperties() || PropertiesService.getScriptProperties();
  var stored = docProps.getProperty(key);
  if (stored) { cache.put(key, stored, 21600); return stored === 'null' ? null : JSON.parse(stored); }
  var result = null;
  try {
    var resp = Maps.newGeocoder().setRegion('us').geocode(query);
    if (resp && resp.status === 'OK' && resp.results && resp.results.length) {
      var loc = resp.results[0].geometry.location;
      result = { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    logEvent_('warn', 'geocode', 'Geocode failed for ' + query + ': ' + e.message);
    return null; // don't cache failures caused by quota
  }
  var json = result ? JSON.stringify(result) : 'null';
  cache.put(key, json, 21600);
  try { docProps.setProperty(key, json); } catch (e) { /* property store full: cache only */ }
  return result;
}

function homeLatLng_() {
  var lat = Number(prop_(PROP.HOME_LAT)), lng = Number(prop_(PROP.HOME_LNG));
  if (lat && lng) return { lat: lat, lng: lng };
  var g = geocode_(settingStr_('HOME_ZIP') + ', USA');
  if (g) { setProp_(PROP.HOME_LAT, g.lat); setProp_(PROP.HOME_LNG, g.lng); }
  return g;
}

/** Distance in miles from home for an item with lat/lng or a place string. null if unknown. */
function distanceFromHome_(item) {
  var home = homeLatLng_();
  if (!home) return null;
  var lat = item.lat, lng = item.lng;
  if (!(lat && lng)) {
    var q = item.zip ? item.zip + ', USA' : (item.city ? item.city + (item.state ? ', ' + item.state : ', UT') : '');
    var g = geocode_(q);
    if (!g) return null;
    lat = g.lat; lng = g.lng;
    item.lat = lat; item.lng = lng;
  }
  return Math.round(haversineMiles_(home.lat, home.lng, lat, lng) * 10) / 10;
}

// ---------------------------------------------------------------------------
// HTTP

/**
 * UrlFetchApp wrapper: returns {code, text, json, headers}. Retries 429/5xx up to `retries` times.
 */
function http_(url, options, retries) {
  options = options || {};
  options.muteHttpExceptions = true;
  retries = retries === undefined ? 2 : retries;
  var attempt = 0, resp, code;
  while (true) {
    resp = UrlFetchApp.fetch(url, options);
    code = resp.getResponseCode();
    if ((code === 429 || code >= 500) && attempt < retries) {
      attempt++;
      Utilities.sleep(1500 * Math.pow(2, attempt));
      continue;
    }
    break;
  }
  var text = resp.getContentText();
  var json = null;
  try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { code: code, text: text, json: json, headers: resp.getAllHeaders() };
}

// ---------------------------------------------------------------------------
// Logging (Logs tab)

/**
 * Append to the Logs tab. level: info|warn|error|cost. `cost` (USD) and `source` feed budget tracking.
 */
function logEvent_(level, job, message, cost, extra) {
  try {
    var sh = getSheet_(SHEETS.LOGS);
    if (!sh) { console.log(level, job, message); return; }
    sh.appendRow([new Date(), level, job, String(message).slice(0, 2000), cost || '', extra ? JSON.stringify(extra).slice(0, 2000) : '']);
  } catch (e) {
    console.log('logEvent_ failed', e, level, job, message);
  }
  if (level === 'error') console.error(job + ': ' + message); else console.log(job + ': ' + message);
}

/** Sum costs in Logs for this month where job starts with `prefix` (e.g. 'apify', 'claude'). */
var monthCostMemo_ = {};

function monthCost_(prefix) {
  var memo = monthCostMemo_[prefix];
  if (memo && nowMs_() - memo.at < 60000) return memo.value;
  var value = monthCostUncached_(prefix);
  monthCostMemo_[prefix] = { at: nowMs_(), value: value };
  return value;
}

function monthCostUncached_(prefix) {
  var sh = getSheet_(SHEETS.LOGS);
  if (!sh || sh.getLastRow() < 2) return 0;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var mk = monthKey_();
  var total = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    var d = rows[i][0];
    if (!(d instanceof Date)) continue;
    var k = monthKey_(d);
    if (k < mk) break; // logs are chronological
    if (k === mk && String(rows[i][2]).indexOf(prefix) === 0 && rows[i][4] !== '') total += Number(rows[i][4]) || 0;
  }
  return Math.round(total * 10000) / 10000;
}

/** Projected full-month cost from month-to-date pace. */
function projectedMonthCost_(prefix) {
  var mtd = monthCost_(prefix);
  var now = new Date();
  var day = Number(Utilities.formatDate(now, TZ, 'd'));
  var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  var hourFrac = localParts_().hour / 24;
  var elapsed = Math.max(0.25, day - 1 + hourFrac);
  return Math.round(mtd / elapsed * daysInMonth * 100) / 100;
}

/** Daily counter stored in Script Properties: key resets each day. */
function dailyCount_(name) {
  var raw = prop_('count:' + name);
  if (!raw) return 0;
  var p = raw.split('|');
  return p[0] === todayKey_() ? Number(p[1]) : 0;
}

function bumpDaily_(name, by) {
  var n = dailyCount_(name) + (by || 1);
  setProp_('count:' + name, todayKey_() + '|' + n);
  return n;
}

function truncate_(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function randInt_(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
