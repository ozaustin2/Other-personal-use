const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadAppsScript } = require('./harness');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const G = loadAppsScript();

test('settings parser falls back to defaults when the tab is empty', () => {
  const cfg = G.parseSettingsValues_([]);
  assert.equal(cfg.kv.HOME_ZIP, '84054');
  assert.equal(cfg.keywords.length, 12);
  assert.equal(cfg.keywords.find((k) => k.keyword === 'not working').maxPrice, null);
  assert.equal(cfg.kslSearches.length, 16);
  assert.equal(cfg.kslSearches[0].maxPrice, 0);
});

test('settings parser reads edited sections', () => {
  const cfg = G.parseSettingsValues_([
    ['## SETTINGS'], ['Key', 'Value'], ['FB_FREE_RESULTS', 12], ['QUIET_START', '21'],
    ['## KEYWORDS'], ['Keyword', 'Radius', 'Max', 'Enabled'], ['welder', 30, '', 'FALSE'], ['generator', 50, '$700', true],
    ['## CATEGORY WEIGHTS'], ['Category', 'Weight'], ['Appliances', 1.3],
  ]);
  assert.equal(cfg.kv.FB_FREE_RESULTS, 12);
  assert.equal(cfg.keywords[0].enabled, false);
  assert.equal(cfg.keywords[0].maxPrice, null);
  assert.equal(cfg.keywords[1].maxPrice, 700);
  assert.equal(cfg.weights.appliances, 1.3);
  assert.equal(cfg.kv.HOME_ZIP, '84054'); // untouched defaults survive
});

test('distance tiers cap scores unless profit is high enough', () => {
  const tiers = { t1: 25, t2: 50, t3: 100, t2MinProfit: 250, t3MinProfit: 750 };
  const hours = { pickup: 0.75, listing: 0.5, mph: 40 };
  const val = { est_resale_low: 200, est_resale_high: 300, est_parts_cost: 20, est_repair_hours: 1, opportunity_score: 9, category: 'appliances' };
  const near = G.computeScore_({ price: 0, distance_miles: 10 }, val, tiers, hours, {});
  assert.equal(near.opportunity_score, 9);
  assert.equal(near.est_profit, 230);
  assert.equal(near.below_market, true);
  const mid = G.computeScore_({ price: 0, distance_miles: 40 }, val, tiers, hours, {});
  assert.equal(mid.opportunity_score, 6); // profit 230 < 250
  const midRich = G.computeScore_({ price: 0, distance_miles: 40 }, { ...val, est_resale_low: 400, est_resale_high: 500 }, tiers, hours, {});
  assert.equal(midRich.opportunity_score, 9);
  const far = G.computeScore_({ price: 0, distance_miles: 80 }, { ...val, est_resale_low: 400, est_resale_high: 500 }, tiers, hours, {});
  assert.equal(far.opportunity_score, 6); // 430 < 750
  const tooFar = G.computeScore_({ price: 0, distance_miles: 140 }, val, tiers, hours, {});
  assert.equal(tooFar.opportunity_score, 1);
  const loss = G.computeScore_({ price: 400, distance_miles: 5 }, val, tiers, hours, {});
  assert.ok(loss.opportunity_score <= 3);
  const weighted = G.computeScore_({ price: 0, distance_miles: 5 }, { ...val, opportunity_score: 7 }, tiers, hours, { appliances: 1.25 });
  assert.equal(weighted.opportunity_score, 9);
});

test('rule filter drops furniture/junk but keeps repairable gear', () => {
  const drop = ['Free couch', 'Queen mattress and box spring', 'Firewood', 'Pallets free', 'Curb alert', 'Baby stroller', 'Puppies for rehoming', '9mm pistol'];
  const keep = ['Lift chair recliner with power motor', 'Champion generator', 'Whirlpool dryer not working', 'Harvest Right freeze dryer', 'Cat 6 cable spool', 'Office desk lamp'];
  drop.forEach((t) => assert.ok(G.ruleFilter_({ title: t }), `should drop: ${t}`));
  keep.forEach((t) => assert.equal(G.ruleFilter_({ title: t }), '', `should keep: ${t}`));
});

test('facebook URLs: price filter and "no max" handling', () => {
  const free = G.fbUrl_(G.DEFAULT_SETTINGS.find((r) => r[0] === 'FB_URL_FREE')[1], { miles: 50 });
  assert.equal(free, 'https://www.facebook.com/marketplace/saltlakecity/free?radius=80&sortBy=creation_time_descend');
  const tpl = G.DEFAULT_SETTINGS.find((r) => r[0] === 'FB_URL_SEARCH')[1];
  assert.equal(G.fbUrl_(tpl, { q: 'freeze dryer', max: 3000, miles: 100 }),
    'https://www.facebook.com/marketplace/saltlakecity/search?query=freeze+dryer&maxPrice=3000&radius=161&sortBy=creation_time_descend&exact=false');
  assert.equal(G.fbUrl_(tpl, { q: 'not working', max: null, miles: 25 }),
    'https://www.facebook.com/marketplace/saltlakecity/search?query=not+working&radius=40&sortBy=creation_time_descend&exact=false');
  const cat = G.DEFAULT_SETTINGS.find((r) => r[0] === 'FB_URL_CATEGORY')[1];
  assert.equal(G.fbUrl_(cat, { slug: 'electronics', max: 75, miles: 50 }),
    'https://www.facebook.com/marketplace/saltlakecity/electronics?maxPrice=75&radius=80&sortBy=creation_time_descend&exact=false');
});

test('facebook dataset items normalize (actor README format)', () => {
  const items = JSON.parse(fx('fb-dataset-sample.json')).map((d) => G.normalizeFacebookItem_(d, { search: 'FB - generator' }));
  assert.equal(items[0].deal_id, 'fb:1189200412268517');
  assert.equal(items[0].price, 65);
  assert.equal(items[0].city, 'Bountiful');
  assert.equal(items[0].image_url, 'https://scontent.example/photo1.jpg');
  assert.equal(items[0].matched_search, 'FB - generator');
  assert.equal(items[1].price, 0);
  assert.equal(items[1].image_url, 'https://scontent.example/photo2.jpg');
  assert.equal(items[2], null); // sold
  assert.equal(items[3], null); // error item
});

test('KSL search page parser (real page)', () => {
  const r = G.parseKslSearchHtml_(fx('ksl-search-free.html'));
  assert.equal(r.blocked, false);
  assert.equal(r.listings.length, 11);
  assert.equal(r.pageInfo.hasNextPage, true);
  r.listings.forEach((l) => {
    assert.match(l.listing_id, /^\d{8}$/);
    assert.equal(l.price, 0);
    assert.ok(l.title && l.city && l.image_url && l.posted_at);
  });
});

test('KSL listing detail parser (real page)', () => {
  const d = G.parseKslDetailHtml_(fx('ksl-listing-detail.html'));
  assert.equal(d.listing_id, '82343709');
  assert.equal(d.description, 'No holds, FCFS.');
  assert.equal(d.image_urls.length, 3);
  assert.equal(d.lat, 40.5353);
});

test('KSL search URLs match the saved-search patterns', () => {
  const cfg = G.parseSettingsValues_([]);
  const urls = cfg.kslSearches.map((s) => G.kslSearchUrl_(s, '84054'));
  assert.equal(urls[0], 'https://classifieds.ksl.com/search/cat/FREE/zip/84054/miles/25');
  assert.equal(urls[3], 'https://classifieds.ksl.com/search/cat/Industrial/sub/Power+and+Hand+Tools/zip/84054/miles/25/priceFrom/0/priceTo/100');
  assert.equal(urls[6], 'https://classifieds.ksl.com/search/keyword/freeze+dryer/zip/84054/miles/100/priceFrom/0/priceTo/3000');
  assert.equal(urls[14], 'https://classifieds.ksl.com/search/keyword/not+working/zip/84054/miles/25');
});

test('robots.txt matching', () => {
  const robots = 'User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /account\nAllow: /account/public\n';
  assert.equal(G.kslRobotsAllows_(robots, 'DealFinder-personal/1.0', '/search/cat/FREE'), true);
  assert.equal(G.kslRobotsAllows_(robots, 'DealFinder-personal/1.0', '/account/settings'), false);
  assert.equal(G.kslRobotsAllows_(robots, 'DealFinder-personal/1.0', '/account/public/x'), true);
  assert.equal(G.kslRobotsAllows_(robots, 'ClaudeBot/1.0', '/search'), false);
  assert.equal(G.kslRobotsAllows_('', 'x', '/anything'), true);
});

test('block page detection', () => {
  assert.equal(G.kslLooksBlocked_('<html><title>Access Denied</title>captcha</html>'), true);
  assert.equal(G.kslLooksBlocked_(fx('ksl-search-free.html')), false);
});

test('KSL alert email parser (SYNTHETIC fixture until real samples are captured)', () => {
  const r = G.parseKslAlertEmail_(fx('ksl-alert-email-SYNTHETIC.html'), 'New listings: DF - Tools <$100', '');
  assert.equal(r.searchName, 'DF - Tools <$100');
  assert.equal(r.listings.length, 2);
  const [a, b] = r.listings;
  assert.equal(a.listing_id, '82340001');
  assert.equal(a.title, 'DeWalt 20V drill + 2 batteries');
  assert.equal(a.price, 60);
  assert.equal(a.city, 'Bountiful');
  assert.equal(a.image_url, 'https://image.ksldigital.com/aaa.jpg?filter=marketplace/400x300_cropped');
  assert.equal(b.title, 'Milwaukee M18 impact, needs repair');
  assert.equal(b.city, 'North Salt Lake');
  assert.equal(b.image_url, 'https://image.ksldigital.com/bbb.jpg');
});

test('listing id extraction from tracking links', () => {
  assert.equal(G.kslListingIdFromUrl_('https://click.ksl.com/x?u=https%3A%2F%2Fclassifieds.ksl.com%2Flisting%2F82340001'), '82340001');
  assert.equal(G.kslListingIdFromUrl_('https://classifieds.ksl.com/listing/82340002?utm=1'), '82340002');
  assert.equal(G.kslListingIdFromUrl_('https://classifieds.ksl.com/search/cat/FREE'), null);
});

test('hour ranges wrap midnight (quiet hours)', () => {
  assert.equal(G.hourInRange_(23, 22, 6), true);
  assert.equal(G.hourInRange_(3, 22, 6), true);
  assert.equal(G.hourInRange_(12, 22, 6), false);
  assert.equal(G.hourInRange_(7, 7, 22), true);
  assert.equal(G.hourInRange_(22, 7, 22), false);
});

test('actor parser copy is in sync with apps-script/KslParser.js', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'KslParser.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', 'ksl-collector', 'src', 'kslParser.cjs'), 'utf8');
  assert.equal(a, b, 'run: cd ksl-collector && npm run sync-parser');
});
