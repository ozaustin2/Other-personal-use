/**
 * KslParser.js: pure parsing for KSL Classifieds. No Apps Script services, so the same file runs in
 * Apps Script, in the Apify actor (copied to ksl-collector/src/kslParser.cjs) and in Node tests.
 *
 * If KSL changes its pages or alert emails, this is the file to update.
 */

var KSL_BASE = 'https://classifieds.ksl.com';

// ---------------------------------------------------------------------------
// Search-URL building (same patterns as the saved searches)

/** search: {type: 'category'|'keyword', category, subcategory, keyword, radius, maxPrice (null = none, 0 = free)} */
function kslSearchUrl_(search, zip) {
  var enc = function (s) { return encodeURIComponent(String(s).trim()).replace(/%20/g, '+'); };
  var path;
  if (search.type === 'keyword') {
    path = '/search/keyword/' + enc(search.keyword);
  } else {
    path = '/search/cat/' + enc(search.category);
    if (search.subcategory) path += '/sub/' + enc(search.subcategory);
  }
  path += '/zip/' + (zip || '84054') + '/miles/' + (search.radius || 25);
  if (search.maxPrice !== null && search.maxPrice !== undefined && search.maxPrice !== '' && Number(search.maxPrice) > 0) {
    path += '/priceFrom/0/priceTo/' + Math.round(Number(search.maxPrice));
  }
  return KSL_BASE + path;
}

// ---------------------------------------------------------------------------
// Next.js flight-data helpers

/** Concatenate the decoded strings pushed via self.__next_f.push([1,"..."]). Falls back to the raw HTML. */
function kslFlightText_(html) {
  var out = [];
  var rx = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\[\s\S])*")\]\)/g;
  var m;
  while ((m = rx.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch (e) { /* skip malformed chunk */ }
  }
  return out.length ? out.join('') : html;
}

/** Return the balanced JSON object starting at text[start] === '{', or null. */
function kslBalancedObject_(text, start) {
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < text.length; i++) {
    var c = text.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function kslIsoFromEpoch_(sec) {
  return sec ? new Date(Number(sec) * 1000).toISOString() : '';
}

function kslFullImage_(url) {
  return url ? String(url).replace(/\?filter=.*$/, '') : '';
}

/** Map one listing object from KSL page data to the normalized item shape. */
function kslListingToItem_(o) {
  var loc = o.location || {};
  var coords = loc.coordinates || {};
  var img = o.primaryImage && o.primaryImage.url ? o.primaryImage.url : '';
  var photos = (o.photos || []).map(function (p) { return p && p.url; }).filter(Boolean);
  return {
    deal_id: 'ksl:' + o.id,
    source: 'KSL',
    listing_id: String(o.id),
    title: o.title || '',
    price: o.price === null || o.price === undefined ? null : Number(o.price),
    city: loc.city || '',
    state: loc.state || '',
    zip: loc.zip || '',
    lat: coords.latitude || null,
    lng: coords.longitude || null,
    url: KSL_BASE + '/listing/' + o.id,
    image_url: img,
    image_urls: photos.length ? photos.slice(0, 4) : (img ? [kslFullImage_(img)] : []),
    description: o.description || '',
    posted_at: kslIsoFromEpoch_(o.displayAt || o.createdAt),
    category_hint: [o.category, o.subCategory].filter(Boolean).join(' / '),
    condition: o.condition || o.newUsed || '',
    seller_type: o.sellerType || ''
  };
}

// ---------------------------------------------------------------------------
// Search result page

/**
 * Parse a KSL search page. Returns {listings: [item], pageInfo: {hasNextPage, endCursor, total} | null, blocked: bool}.
 */
function parseKslSearchHtml_(html) {
  var result = { listings: [], pageInfo: null, blocked: kslLooksBlocked_(html) };
  var text = kslFlightText_(html);
  var rx = /\{"id":(\d{5,}),"contact"/g;
  var seen = {}, m;
  while ((m = rx.exec(text)) !== null) {
    if (seen[m[1]]) continue;
    var raw = kslBalancedObject_(text, m.index);
    if (!raw) continue;
    try {
      var o = JSON.parse(raw);
      if (o.listingType && o.listingType !== 'CLASSIFIED') continue;
      seen[m[1]] = true;
      result.listings.push(kslListingToItem_(o));
    } catch (e) { /* not a listing object */ }
  }
  var pi = /"pageInfo":\[\{"hasNextPage":(true|false),"endCursor":"([^"]*)","total":(\d+)/.exec(text);
  if (pi) result.pageInfo = { hasNextPage: pi[1] === 'true', endCursor: pi[2], total: Number(pi[3]) };
  // Fallback: plain HTML cards (if the flight data format changes).
  if (!result.listings.length) {
    var cardRx = /data-item-id="(\d+)"[^>]*href="([^"]+)"[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?aria-label="Price ([^"]*)"/g;
    while ((m = cardRx.exec(html)) !== null) {
      var label = /aria-label="([^"]*)" data-item-id="/.exec(html.slice(Math.max(0, m.index - 300), m.index + 40));
      result.listings.push({
        deal_id: 'ksl:' + m[1], source: 'KSL', listing_id: m[1], title: label ? kslDecodeEntities_(label[1]) : '',
        price: kslPrice_(m[4]), city: '', url: KSL_BASE + '/listing/' + m[1], image_url: m[3], image_urls: [m[3]], description: '', posted_at: ''
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Listing detail page

/** Returns the normalized item (with description, photos, coordinates) or null. */
function parseKslDetailHtml_(html) {
  var text = kslFlightText_(html);
  var idx = text.indexOf('"listing":{"id":');
  if (idx >= 0) {
    var raw = kslBalancedObject_(text, idx + '"listing":'.length);
    if (raw) {
      try { return kslListingToItem_(JSON.parse(raw)); } catch (e) { /* fall through */ }
    }
  }
  // Fallback: schema.org Product JSON-LD
  var ld = /<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"Product"[\s\S]*?)<\/script>/.exec(html);
  if (ld) {
    try {
      var p = JSON.parse(ld[1]);
      return {
        deal_id: 'ksl:' + p.sku, source: 'KSL', listing_id: String(p.sku), title: p.name, price: p.offers ? Number(p.offers.price) : null,
        url: p.url, image_url: p.image && p.image.url, image_urls: p.image && p.image.url ? [p.image.url] : [], description: '', city: '', posted_at: ''
      };
    } catch (e) { /* ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block / CAPTCHA detection (shared by Apps Script and the actor)

function kslLooksBlocked_(html) {
  var s = String(html || '').slice(0, 20000).toLowerCase();
  return /captcha|cf-chl|challenge-platform|px-captcha|access denied|request unsuccessful|are you a robot|unusual traffic|perimeterx|datadome/.test(s) &&
    s.indexOf('search-result') < 0 && s.indexOf('"listing":{') < 0;
}

// ---------------------------------------------------------------------------
// robots.txt

/**
 * Minimal robots.txt check. Uses the group for our user-agent token, else '*'. No group = allowed.
 * Longest matching rule wins; Allow wins ties.
 */
function kslRobotsAllows_(robotsTxt, userAgent, path) {
  var groups = [], cur = null, lastWasUa = false;
  String(robotsTxt || '').split(/\r?\n/).forEach(function (line) {
    line = line.replace(/#.*$/, '').trim();
    var m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    var field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasUa || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasUa = true;
    } else {
      lastWasUa = false;
      if (cur && (field === 'allow' || field === 'disallow')) cur.rules.push({ allow: field === 'allow', path: value });
    }
  });
  var token = String(userAgent || '').split(/[\/\s]/)[0].toLowerCase();
  var group = null;
  groups.forEach(function (g) { if (!group && g.agents.some(function (a) { return a !== '*' && token.indexOf(a) === 0; })) group = g; });
  if (!group) groups.forEach(function (g) { if (!group && g.agents.indexOf('*') >= 0) group = g; });
  if (!group) return true;
  var best = null;
  group.rules.forEach(function (r) {
    if (!r.path) return; // "Disallow:" with empty value allows everything
    var rx = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (rx.test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  });
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// Alert email parsing

function kslDecodeEntities_(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); });
}

function kslStripTags_(html) {
  return kslDecodeEntities_(String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|td|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
}

function kslPrice_(s) {
  s = String(s || '');
  if (/\bfree\b/i.test(s)) return 0;
  var m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Find a KSL listing ID inside a (possibly tracking-wrapped, URL-encoded) link. */
function kslListingIdFromUrl_(url) {
  var u = kslDecodeEntities_(url);
  for (var i = 0; i < 3; i++) {
    var m = /classifieds\.ksl\.com(?:\/|%2F)+listing(?:\/|%2F)+(\d{5,})/i.exec(u) || /\/listing\/(\d{5,})\b/.exec(u) ||
      /[?&](?:listingId|listing_id|adId|ad_id|id)=(\d{6,})\b/i.exec(u);
    if (m) return m[1];
    try { var d = decodeURIComponent(u); if (d === u) break; u = d; } catch (e) { break; }
  }
  return null;
}

/** "DF - Tools <$100" from subject or body; '' if not found. */
function kslSearchName_(subject, text) {
  var hay = kslDecodeEntities_(String(subject || '') + '\n' + String(text || ''));
  var m = /DF\s*[-–]\s*([^\n"|]{2,60}?)(?=\s*(?:\n|"|$|\||has |have |new |matches|listing|alert|saved search))/i.exec(hay) ||
    /DF\s*[-–]\s*([^\n"]{2,60})/i.exec(hay);
  return m ? ('DF - ' + m[1].trim()).replace(/[.:,;!]+$/, '') : '';
}

var KSL_IMG_SKIP_RX = /logo|icon|spacer|pixel|blank|tracking|open\?|beacon|facebook|twitter|instagram|youtube|app-?store|google-?play|badge|\.gif(\?|$)/i;

/**
 * Parse one KSL alert email. Returns {searchName, listings: [item], unresolvedLinks: [url]}.
 * unresolvedLinks: tracking links with no visible listing ID (the caller may resolve redirects).
 */
function parseKslAlertEmail_(html, subject, plainText) {
  html = String(html || '');
  var out = { searchName: kslSearchName_(subject, kslStripTags_(html) + '\n' + (plainText || '')), listings: [], unresolvedLinks: [] };
  var anchors = [];
  var aRx = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = aRx.exec(html)) !== null) anchors.push({ href: m[1], inner: m[2], start: m.index, end: m.index + m[0].length });

  // First anchor position per listing ID, in document order.
  var order = [], firstPos = {}, anchorText = {};
  anchors.forEach(function (a) {
    var id = kslListingIdFromUrl_(a.href);
    if (!id) {
      if (/^https?:/i.test(a.href) && !/unsubscribe|mailto:|preferences|privacy|terms|help|\/myaccount|\/saved-searches|ksl\.com\/?$/i.test(a.href)) {
        out.unresolvedLinks.push(kslDecodeEntities_(a.href));
      }
      return;
    }
    if (firstPos[id] === undefined) { firstPos[id] = a.start; order.push(id); }
    var t = kslStripTags_(a.inner).replace(/\s+/g, ' ').trim();
    if (t && !/^(view|see|open)( listing| details| it| now)?$|^\$|^free$/i.test(t) && (!anchorText[id] || t.length > anchorText[id].length)) anchorText[id] = t;
  });

  order.forEach(function (id, idx) {
    var start = firstPos[id];
    var end = idx + 1 < order.length ? firstPos[order[idx + 1]] : html.length;
    // Images often sit just before the first link of a card: look back a little, but not past the previous card.
    var prevEnd = idx > 0 ? firstPos[order[idx - 1]] : 0;
    var lookback = Math.max(prevEnd, start - 600);
    var block = html.slice(start, Math.min(end, start + 8000));
    var pre = html.slice(lookback, start);
    var text = kslStripTags_(block);
    var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    var img = '';
    var imgRx = /<img\b[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, im;
    var candidates = [];
    while ((im = imgRx.exec(block)) !== null) candidates.push(im);
    var preImgs = [];
    while ((im = imgRx.exec(pre)) !== null) preImgs.push(im);
    candidates = candidates.concat(preImgs.reverse());
    for (var c = 0; c < candidates.length; c++) {
      var tag = candidates[c][0], src = kslDecodeEntities_(candidates[c][1]);
      if (KSL_IMG_SKIP_RX.test(src) || /width=["']?1["']?\b|height=["']?1["']?\b/i.test(tag)) continue;
      img = src; break;
    }

    var title = anchorText[id] || '';
    if (!title) {
      for (var li = 0; li < lines.length; li++) {
        var l = lines[li];
        if (kslPrice_(l) !== null && l.length < 20) continue;
        if (/^(view|see|open)\b/i.test(l)) continue;
        title = l; break;
      }
    }
    var priceLine = lines.filter(function (l) { return /\$\s?\d|\bfree\b/i.test(l) && l.length < 40; })[0];
    var price = priceLine ? kslPrice_(priceLine) : null;
    var cityM = /\b([A-Z][A-Za-z.'\- ]{1,30}),\s*(UT|Utah|ID|Idaho|NV|WY)\b/.exec(text);
    var timeM = /\b(\d+\s+(?:minute|min|hour|hr|day)s?\s+ago|just now|today|yesterday)\b/i.exec(text);
    out.listings.push({
      deal_id: 'ksl:' + id,
      source: 'KSL',
      listing_id: id,
      title: title,
      price: price,
      city: cityM ? cityM[1].trim() : '',
      state: cityM ? (cityM[2].length === 2 ? cityM[2] : '') : '',
      url: KSL_BASE + '/listing/' + id,
      image_url: img,
      image_urls: img ? [img] : [],
      description: '',
      posted_text: timeM ? timeM[1] : '',
      matched_search: out.searchName
    });
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    kslSearchUrl_: kslSearchUrl_, parseKslSearchHtml_: parseKslSearchHtml_, parseKslDetailHtml_: parseKslDetailHtml_,
    parseKslAlertEmail_: parseKslAlertEmail_, kslRobotsAllows_: kslRobotsAllows_, kslLooksBlocked_: kslLooksBlocked_,
    kslListingIdFromUrl_: kslListingIdFromUrl_, kslSearchName_: kslSearchName_, kslPrice_: kslPrice_
  };
}
