/**
 * Notify.js: phone push notifications. ntfy.sh today; add more channels to NOTIFIERS later
 * (e.g. Telegram) without touching the rest of the code.
 *
 * message = {title, body, url, clickUrl, imageUrl, priority (1–5), tags: [], critical: bool}
 */

var NOTIFIERS = {
  ntfy: function (msg) {
    var topic = prop_(PROP.NTFY_TOPIC);
    if (!topic) throw new Error('NTFY_TOPIC Script Property is not set');
    var server = (prop_(PROP.NTFY_SERVER) || 'https://ntfy.sh').replace(/\/+$/, '');
    // JSON publishing (https://docs.ntfy.sh/publish/#publish-as-json) keeps emoji/UTF-8 titles intact.
    var body = {
      topic: topic,
      title: msg.title || 'Deal Finder',
      message: msg.body || '',
      priority: msg.priority || 3,
      markdown: true
    };
    if (msg.tags && msg.tags.length) body.tags = msg.tags;
    if (msg.clickUrl) body.click = msg.clickUrl;
    if (msg.imageUrl) body.attach = msg.imageUrl;
    var actions = [];
    if (msg.url) actions.push({ action: 'view', label: 'Listing', url: msg.url });
    if (msg.dashboardUrl) actions.push({ action: 'view', label: 'Dashboard', url: msg.dashboardUrl });
    if (actions.length) body.actions = actions;
    var headers = {};
    var token = prop_(PROP.NTFY_TOKEN);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var resp = http_(server, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body), headers: headers
    }, 1);
    if (resp.code >= 300) throw new Error('ntfy HTTP ' + resp.code + ': ' + truncate_(resp.text, 200));
  }
};

/**
 * Send a push. Non-critical messages during quiet hours are held and released after quiet hours.
 * Returns 'sent' | 'held' | 'failed'.
 */
function notify_(msg) {
  if (!msg.critical && isQuietHours_()) {
    holdNotification_(msg);
    return 'held';
  }
  var ok = false;
  Object.keys(NOTIFIERS).forEach(function (name) {
    try { NOTIFIERS[name](msg); ok = true; } catch (e) { logEvent_('error', 'notify:' + name, e.message); }
  });
  return ok ? 'sent' : 'failed';
}

function holdNotification_(msg) {
  var held = JSON.parse(prop_('heldNotifications') || '[]');
  held.push(msg);
  setProp_('heldNotifications', JSON.stringify(held.slice(-20)));
}

/** Called from the tick: after quiet hours, send held pushes as one summary. */
function releaseHeldNotifications_() {
  if (isQuietHours_()) return;
  var held = JSON.parse(prop_('heldNotifications') || '[]');
  if (!held.length) return;
  setProp_('heldNotifications', '[]');
  if (held.length === 1) { notify_(held[0]); return; }
  var body = held.map(function (m) { return '• ' + m.title; }).join('\n');
  notify_({ title: held.length + ' deals from overnight', body: body, clickUrl: dashboardUrl_(), tags: ['moon'], priority: 3 });
}

/** Push for a scored deal. */
function notifyDeal_(item) {
  var free = item.price === 0;
  var parts = [
    'Score ' + item.opportunity_score + '/10 · ' + (free ? 'FREE' : '$' + item.price),
    'Est profit $' + Math.round(item.est_profit || 0) + (item.distance_miles !== null && item.distance_miles !== undefined ? ' · ' + item.distance_miles + ' mi' : ''),
    item.reasoning || ''
  ];
  return notify_({
    title: (free ? '🆓 ' : '💰 ') + truncate_(item.title, 80),
    body: parts.join('\n'),
    url: item.url,
    clickUrl: dashboardUrl_(item.deal_id) || item.url,
    dashboardUrl: dashboardUrl_(item.deal_id),
    imageUrl: item.image_url,
    priority: item.opportunity_score >= 9 ? 5 : 4,
    tags: [free ? 'free' : 'moneybag', item.source === 'Facebook' ? 'fb' : 'ksl']
  });
}

/** Push an operational alert (blocks, parser failures, budget). Always critical. */
function alert_(title, body) {
  logEvent_('warn', 'alert', title + ': ' + body);
  return notify_({ title: '⚠️ ' + title, body: body, priority: 4, tags: ['warning'], critical: true, clickUrl: getSpreadsheet_().getUrl() });
}

function dashboardUrl_(dealId) {
  var base = prop_(PROP.WEBAPP_URL);
  if (!base) return '';
  var url = base + '?k=' + encodeURIComponent(prop_(PROP.DASHBOARD_KEY));
  if (dealId) url += '&id=' + encodeURIComponent(dealId);
  return url;
}

/** Menu item: send a test push. */
function sendTestPush() {
  var r = notify_({ title: 'Deal Finder test', body: 'If you can read this, phone alerts work. 👍', critical: true, tags: ['white_check_mark'], clickUrl: dashboardUrl_() });
  safeAlert_('Test push: ' + r);
}
