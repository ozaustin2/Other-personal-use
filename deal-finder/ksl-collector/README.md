# ksl-classifieds-collector (Apify actor)

The backup and baseline collector for Deal Finder. It reads **public, logged-out** KSL Classifieds pages only. Apps Script starts it:
- once for the baseline sweep;
- and only when the KSL alert-email feed is broken (backup mode).

## Politeness (enforced in `src/main.js`)
- Reads `robots.txt` first; disallowed paths are skipped. If robots.txt can't be read, nothing is fetched.
- One request at a time, random 3–8 s gaps, descriptive user agent.
- A hard page-load cap per run (`maxPageLoads`). Apps Script also enforces ~200/day.
- HTTP 403/429, CAPTCHA or a block page: stops immediately and reports `blocked` in the `OUTPUT` record. Apps Script then backs off 24 h and alerts you.
- No proxies or stealth tricks. The browser (used only for pages 2+) skips images, media and fonts.

## How it reads KSL
| Need | Method |
|---|---|
| Page 1 of a search (~11 newest) | Plain HTTP GET; listings are JSON embedded in the server-rendered page |
| Pages 2+ (baseline only) | Playwright: load the search and scroll so KSL's own code loads the next batch (KSL uses a Next.js server action, not a stable public JSON endpoint) |
| Listing details | Plain HTTP GET of `/listing/<id>` |

URL patterns and parsing live in `src/kslParser.cjs`, a copy of `../apps-script/KslParser.js` (`npm run sync-parser`). DOM selectors for the browser path are in `src/config.js`.

## Input
```json
{
  "mode": "search",
  "zip": "84054",
  "searches": [{ "name": "DF - Free 25mi", "type": "category", "category": "FREE", "radius": 25, "maxPrice": 0, "maxPages": 1, "stopAtIds": [] }],
  "maxPageLoads": 20,
  "sinceDays": 0
}
```
Output:
- **dataset:** one normalized listing per item (`listing_id`, `title`, `price`, `city`, `zip`, `url`, `image_url`, `posted_at`, `matched_search`, …);
- **`OUTPUT` record:** `{pageLoads, blocked, blockedReason, layoutChanged[], robotsSkipped[], newestIds{}, completedSearches[]}`.

## Local test
```bash
npm install
mkdir -p storage/key_value_stores/default
echo '{"searches":[{"name":"DF - Free 25mi","type":"category","category":"FREE","radius":25,"maxPrice":0,"maxPages":1}],"maxPageLoads":3}' > storage/key_value_stores/default/INPUT.json
node src/main.js
```

## Deploy
```bash
npm install -g apify-cli
apify login          # one-time browser sign-in
apify push           # builds on Apify; the actor ID is <your-username>~ksl-classifieds-collector
```
Put that ID in the Sheet → Settings → `KSL_ACTOR_ID`.
