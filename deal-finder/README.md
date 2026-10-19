# Deal Finder: KSL + Facebook Marketplace

Finds free and underpriced repairable items around **84054 (North Salt Lake)**, filters out furniture and junk, estimates resale value and repair effort, scores each one 1–10, logs everything to a Google Sheet, shows it on a phone dashboard, and pushes the best ones to your phone. It also writes resale listings from your own photos when you ask.

You never browse KSL or Facebook yourself, and the system never logs in to either with your accounts.

**Setting it up?** Follow [`SETUP_CHECKLIST.md`](SETUP_CHECKLIST.md) (Claude walks you through it).

---

## How it works

```
 KSL saved-search emails ─┐ (Gmail, every 5 min)
 KSL backup collector ────┤ (Apify actor: baseline once, then only if emails stop)
 Facebook (Apify actor) ──┤ (free every 30 min, paid at 10:00 and 18:00)
 iPhone share Shortcut ───┘ (whenever you share a listing)
            │
            ▼
      Queue (hidden tab, deduped by listing ID)
            │
   rule filter (free) → distance → cheap AI filter (Haiku, batches of 20)
            │
   [KSL only] fetch the public listing page for description + photos (≤30/day)
            │
   eBay comps → valuation + score (Sonnet, with photos) → distance-tier caps
            │
     Deals tab + dashboard ──► push: free ≥ 8, paid ≥ 9, otherwise in the 10:15 / 18:15 digest
```

Everything runs in **Google Apps Script** from one 5-minute trigger (`tick`). The trigger reads the **Settings** tab each time, so you change schedules, thresholds and keywords there without touching code.

| Piece | Where |
|---|---|
| Code | `apps-script/` (pushed with `clasp`) |
| KSL collector (Apify actor) | `ksl-collector/` (pushed with `apify push`) |
| Data | Google Sheet "Deal Finder" (tabs below) + Drive folder "Deal Finder Photos" |
| Secrets | Apps Script → Project Settings → **Script Properties** (never in code or the Sheet) |
| Tests | `npm test` (Node 20+) |

### Sheet tabs

| Tab | What's in it |
|---|---|
| **Deals** | Score, thumbnail, title, source, free/paid, price, resale range, profit, profit/hr, difficulty, pickup effort, distance, category, reasoning, links, Status (dropdown), date found, plus detail columns. 8–10 green, 5–7 yellow, 1–4 gray. |
| **Filtered** | Everything dropped, with the reason |
| **Settings** | All tunables: schedules, radius tiers, thresholds, price ceilings, keyword table, Facebook categories, KSL searches, category weights, models, budgets, quiet hours |
| **Sales log** | Your actual sale price and hours per item; used to recalibrate estimates |
| **Logs** | Run history, errors, and the cost of every Apify run and Claude call (projected monthly cost in the daily housekeeping line) |
| Seen / Queue / Runs | Hidden working tabs (dedupe index, items waiting to be scored, Apify runs in progress) |

---

## Sources

### KSL (primary: your alert emails)
The 16 saved searches below already exist in your KSL account with email alerts set to **Immediately**. A Gmail filter puts the emails under the label **KSL Alerts**. Every 5 minutes the script reads new alert emails, parses every listing in each one, and records which saved search it matched (`matched_search`).

- Free-category items are scored right away. Paid items are scored right away too, but held for the digest unless they score 9+.
- Gmail groups alerts with the same subject into one thread, so processed **messages** are tracked by ID. The label `deal-processed` is just a visual marker.
- Alert emails usually lack the description. For items that pass a quick keyword check, the script fetches that one public listing page for the description and all photos. That's at most 30 pages a day with the same politeness rules as the collector. Turn it off with `KSL_DETAIL_FETCH`.
- **Parser health:** if an alert email arrives and no listings can be read from it, you get a "KSL email format changed" push. Then run **Deal Finder → Capture KSL email samples** and update `apps-script/KslParser.js`.
- **Feed health:** if no alert email arrives for 6 hours between 7 a.m. and 10 p.m., you get a push. With `KSL_AUTO_BACKUP` = TRUE, the backup collector also switches on automatically, and turns itself off once emails resume.

#### KSL saved searches (already set up; don't recreate)
| Saved search name | Type | Radius | Max price |
|---|---|---|---|
| DF - Free 25mi | Category: FREE | 25 mi | Free |
| DF - Appliances <$150 | Category: Appliances | 25 mi | $150 |
| DF - Electronics <$75 | Category: Electronics | 25 mi | $75 |
| DF - Tools <$100 | Industrial / Power and Hand Tools | 25 mi | $100 |
| DF - Lawn Mowers <$200 | Home and Garden / Lawn Mowers | 25 mi | $200 |
| DF - Yard Equipment <$200 | Home and Garden / Other Garden/Lawn/Yard Equipment | 25 mi | $200 |
| DF - freeze dryer 100mi <$3000 | Keyword | 100 mi | $3,000 |
| DF - Harvest Right 100mi <$3000 | Keyword | 100 mi | $3,000 |
| DF - generator 50mi <$600 | Keyword | 50 mi | $600 |
| DF - snowblower 50mi <$500 | Keyword | 50 mi | $500 |
| DF - e-bike 50mi <$600 | Keyword | 50 mi | $600 |
| DF - welder 50mi <$500 | Keyword | 50 mi | $500 |
| DF - compressor <$300 | Keyword | 25 mi | $300 |
| DF - for parts <$400 | Keyword | 25 mi | $400 |
| DF - not working (no max) | Keyword | 25 mi | No max |
| DF - needs repair (no max) | Keyword | 25 mi | No max |

The same list sits in Settings → **KSL SAVED SEARCHES**, where the collector reads it.

### KSL backup collector (`ksl-collector/`)
It runs once at setup as the **baseline sweep**: all 16 searches, the first 3 pages each (5 for Free), skipping listings older than 14 days. After that it only runs if the email feed breaks or you set `KSL_BACKUP_MODE` = TRUE. In backup mode it polls Free every 20 minutes and the paid searches at 10:00 and 18:00, and stops early once it reaches listings it has already seen.

**What inspecting KSL showed (Oct 2026):**
- Search pages are server-rendered. The first ~11 results come embedded in the page as JSON, so page 1 needs only one plain HTTP request, with no browser.
- More results load as you scroll, through a Next.js "server action": a POST whose ID changes with every KSL deploy. That isn't a stable public JSON feed, so for pages 2 and beyond the collector opens a real browser and scrolls, letting KSL's own page code load the next batch. The browser skips images and fonts.
- Listing pages are server-rendered too: description, all photos and coordinates are in the HTML.
- `robots.txt` has no rules that apply to our user agent, so search and listing pages are allowed. The collector re-checks it on every run, and if robots.txt can't be read, it fetches nothing.

**Politeness rules (enforced in code):**
- Logged-out public pages only.
- `robots.txt` checked at runtime.
- One request at a time, with random 3–8 second gaps.
- A descriptive user agent.
- At most ~200 KSL page loads a day in total, counted across collector runs and detail fetches.
- On HTTP 403/429, a CAPTCHA or a block page: stop at once, back off 24 hours (`KSL_BLOCKED_UNTIL`) and push you an alert.
- No proxies, no stealth tricks, no retries against a block.

Tested locally on 2026-10-19:
- one page: 2 requests, 11 listings;
- two pages through the browser: 6 requests (the cap), 34 listings.

### Facebook (Apify `apify~facebook-marketplace-scraper`)
This is the official, most-used Marketplace actor: 11.5k users, about 158k successful runs in the last 30 days.

- **Input:** `{startUrls: [{url}], resultsLimit, includeListingDetails}`, where the URLs are ordinary Marketplace search links.
- **Output fields used:** `id`, `listingUrl`, `marketplace_listing_title`, `listing_price.amount`, `location.reverse_geocode.city/state`, `primary_listing_photo.image.uri`, plus `is_sold`/`is_pending`.
- The link formats are templates in Settings (`FB_URL_FREE`, `FB_URL_CATEGORY`, `FB_URL_SEARCH`), so you can fix them without code if Facebook changes its links. Radius goes in as kilometers.
- Each paid search URL runs as its own job, so each gets its own result cap. Every run is capped three ways: `resultsLimit`, `maxItems` and `maxTotalChargeUsd`.

### Manual share (iPhone Shortcut → `doPost`)
Share a listing link or screenshot from anywhere: a Facebook group, Craigslist, OfferUp. Claude reads the screenshot or text, and the item goes through the same valuation and scoring. See [Manual share Shortcut](#manual-share-iphone-shortcut).

---

## Scoring

For each item that's kept, the strong model returns:
- `item_type`, `brand_model_guess`, `condition_guess`, `likely_fault`;
- resale low/high (local KSL/Facebook pricing), parts cost and repair hours;
- `repair_difficulty` (1–5, calibrated to an A&P mechanic who is strong in electrical and appliances);
- `pickup_effort` (1–5), local demand (1–5), a raw `opportunity_score`, and 2–3 sentences of reasoning.

eBay **active** listings serve as comps, multiplied by `EBAY_DISCOUNT` (0.75) to approximate a local price, and the model adjusts for condition and local demand.

The script then computes:
- `est_profit = resale_mid − asking_price − parts`
- `profit_per_hour = est_profit / (repair_hours + pickup + listing + round-trip drive time)`
- `below_market` = asking price < 50% of `est_resale_low`
- The score is multiplied by the **category weight**, then capped:
  - a loss caps the score at 3;
  - **25–50 mi** needs $250+ profit to score 7+;
  - **50–100 mi** needs $750+ profit to score 7+;
  - beyond 100 mi is dropped.

**Calibration:** your Sales log feeds back into scoring in two ways.
- Per-category "actual vs. estimated profit" notes go into every valuation prompt.
- **Deal Finder → Recalibrate category weights** nudges the weights toward what actually made money. It needs 3+ sales per category and moves each weight at most ±20% per run.

## Notifications (ntfy)
- **Free items scoring 8+:** an instant push with the title, score, profit and distance, plus buttons for the listing and the dashboard card.
- **Paid items scoring 9+:** an instant push. Everything else goes into the **10:15** and **18:15** digests. The 18:15 digest also includes the **top 10 of the day** and re-sorts the Deals tab by score.
- **Quiet hours** (22:00–06:00) hold deal pushes and send them as one summary in the morning. Alerts about blocks, budgets and parser failures always go through.
- **Baseline items** never push. You get one "KSL baseline results" summary instead.
- **Swappable channel:** add a Telegram (or other) entry to `NOTIFIERS` in `Notify.js`; nothing else changes.

## Dashboard (`doGet`)
The dashboard is a mobile card grid showing:
- photo, score badge and free/paid tag;
- price, resale range, profit and profit/hr;
- difficulty, pickup effort and distance;
- the reasoning, and a link to the listing.

You can filter by score, free/paid, source, category, status and distance tier, and sort by score, profit, profit/hr or newest. Each card lets you change its status, open the item's photo folder, **Draft listing**, and **Log sale**.

The web app is deployed as "Anyone" so the iPhone Shortcut can reach it. The dashboard only opens with your private `DASHBOARD_KEY` in the link, so bookmark the link from **Deal Finder → Show dashboard link** and don't share it.

## Resale listing drafts
1. Set the item's status to **Picked Up**, **Repairing** or **Listed**. That creates its Drive photo folder.
2. Upload your photos to that folder. iPhone HEIC photos are fine.
3. Tap **Draft listing**.

The strong model looks at your photos and the item data, then writes:
- a KSL listing and a Facebook listing, each with title, description, price, category and firm/OBO guidance;
- the best photo order, and any retakes worth doing.

The drafts are saved to a Google Doc in the item folder. Nothing is ever posted automatically.

---

## Costs

| Item | Estimate at default settings | Control |
|---|---|---|
| Facebook free sweep | every 30 min, 7:00–22:00 = 30 runs × 8 listings = 240/day → **$36–45/mo** | `FB_FREE_INTERVAL_MIN`, `FB_FREE_RESULTS`, active hours |
| Facebook paid sweeps | 17 URLs × 2/day (5 listings, 10 for no-max) → **$28–35/mo** | `FB_PAID_TIMES`, `FB_PAID_RESULTS`, disable rows in the tables |
| KSL collector | baseline ≈ 50 page loads once; ~$0 afterwards | only runs in backup mode |
| Claude | Haiku filter ≈ $1/mo; Sonnet valuation ≈ 2–4¢ each, capped at 30/day → **$10–25/mo** | `SONNET_DAILY_CAP`, `SONNET_MIN_QUICK_PROFIT`, `VALUE_EFFORT`, `CLAUDE_MONTHLY_BUDGET` |
| eBay, ntfy, Google | free | |

The Facebook actor charges **$0.0062 per listing on Apify's free plan** and $0.005 on the $29/mo Starter plan, including repeats it has already shown. Full Facebook coverage at the defaults is about **$65–80/month**, well above a $20–30 target.

`APIFY_MONTHLY_BUDGET` (default **$30**) protects you:
- when the month's pace would exceed the budget, the paid Facebook sweeps are skipped first;
- when the budget is reached, all Apify runs pause and you get a push.

To land near $30 with full coverage, try:
- `FB_PAID_TIMES` = `18:00` (KSL emails already cover the same keywords instantly and for free);
- `FB_FREE_RESULTS` = 5;
- `FB_FREE_INTERVAL_MIN` = 45.

---

## Settings you're most likely to change
- **Schedules:** `FB_FREE_INTERVAL_MIN`, `FB_FREE_ACTIVE_START/END`, `FB_PAID_TIMES`, `DIGEST_TIMES`, `QUIET_START/END`
- **Thresholds:** `FREE_PUSH_MIN_SCORE` (8), `PAID_PUSH_MIN_SCORE` (9), and the tier miles and profits
- **Keyword table:** keyword, radius, max price (leave blank for no max), enabled
- **Facebook categories:** Facebook slug, max price, enabled
- **Models:** `MODEL_FILTER` (claude-haiku-5-5), `MODEL_VALUE` (claude-sonnet-5-5), `VALUE_EFFORT`
- **Budgets:** `APIFY_MONTHLY_BUDGET`, `CLAUDE_MONTHLY_BUDGET`

Valuation calls use Claude's server-side refusal fallback (`fallbacks: "default"`), so a rare refused request is retried on a suitable model automatically.

---

## Manual share (iPhone Shortcut)

You need two things:
- the web app URL (from **Deal Finder → Show dashboard link**, the part before `?k=`);
- your `SHARE_TOKEN`, found in Apps Script → Project Settings → Script Properties. Type it into the Shortcut yourself; never paste it into a chat.

1. Open **Shortcuts** → **+** and name the shortcut **Deal Finder**.
2. Tap **ⓘ** → turn on **Show in Share Sheet**. Under share sheet types, keep **Images**, **URLs**, **Text** and **Safari web pages**.
3. Add these actions in order:
   1. **Get URLs from Input** (Shortcut Input) → **Set Variable** `link`
   2. **Get Text from Input** (Shortcut Input) → **Set Variable** `words`
   3. **Get Images from Input** (Shortcut Input)
   4. **Convert Image** to JPEG
   5. **Resize Image**, width 1200
   6. **Base64 Encode**
   7. **Set Variable** `pic`
   8. **Get Contents of URL**, with:
      - URL: your web app URL;
      - Method: **POST**;
      - Request Body: **JSON**, with fields `token` (text: your SHARE_TOKEN), `url` (variable `link`), `text` (variable `words`) and `image` (variable `pic`).
   9. **Get Dictionary Value** `score` from the result. Add another for `title`.
   10. **Show Notification**: `Score [score]/10 – [title]`
4. Test it: open a listing → **Share** → **Deal Finder**. After 20–40 seconds you see the score, and a card appears on the dashboard.

---

## Developing

```bash
npm test                         # parser, scoring, filter, URL and config tests (Node 20+)
cd ksl-collector && npm run sync-parser   # after editing apps-script/KslParser.js
npm run bundle                   # rebuild dist/ for the copy-paste install
clasp push                       # deploy Apps Script (run from deal-finder/, rootDir apps-script)
cd ksl-collector && apify push   # deploy the actor
```

### Testing the KSL collector locally
```bash
cd ksl-collector
npm install
mkdir -p storage/key_value_stores/default
echo '{"searches":[{"name":"DF - Free 25mi","type":"category","category":"FREE","radius":25,"maxPrice":0,"maxPages":1}],"maxPageLoads":3}' \
  > storage/key_value_stores/default/INPUT.json
node src/main.js        # → storage/datasets/default/*.json and storage/key_value_stores/default/OUTPUT.json
```
For a two-page test (which uses the browser), set `"maxPages":2` and `"maxPageLoads":6`. Locally that needs Playwright's Chromium; Apify's Docker image already includes it.

### Files
| File | Purpose |
|---|---|
| `Main.js` | `tick()` scheduler, digests, housekeeping |
| `Pipeline.js` | queue → filter → value → score → record → push |
| `KslParser.js` | **all KSL parsing** (search page, listing page, alert emails, robots.txt); shared with the actor |
| `KslEmail.js` | Gmail intake, feed health, "Capture KSL email samples" |
| `KslCollector.js` | baseline/backup actor runs, single listing fetches, caps and back-off |
| `Facebook.js` | Facebook URLs, runs and normalization |
| `Apify.js` | run start/poll, datasets, cost, budget governor |
| `Ai.js` | Claude calls (filter, valuation, share extraction, listing drafts) |
| `Ebay.js` | eBay comps |
| `Scoring.js` | profit math, distance tiers, weights, Sales-log calibration |
| `Filter.js` | free rule-based filter and the detail-fetch keyword check |
| `Notify.js` | ntfy (swappable), quiet hours, alerts |
| `WebApp.js`, `Dashboard.html` | dashboard and share endpoint |
| `Listing.js` | resale listing drafts |
| `Setup.js`, `Config.js`, `Sheets.js`, `Util.js` | menu, setup, settings, sheet I/O, helpers |

### Known limits
- **Facebook thumbnails expire:** Facebook image links are signed and stop working after a few days. Old Deals rows show a blank thumbnail; the listing link still works.
- **KSL alert email parser:** built generically, because the email format couldn't be captured before setup. Setup step 3.2 checks it against your real emails, and `tests/fixtures/ksl-alert-email-SYNTHETIC.html` gets replaced by real samples.
- **Apps Script quotas:** a free Google account allows 90 min/day of trigger runtime. Idle ticks take a few seconds, run every 15 min during quiet hours, and you get a push if a day passes 75 min (the daily housekeeping log shows yesterday's total). Each tick stops after 4.5 minutes and continues on the next one.
