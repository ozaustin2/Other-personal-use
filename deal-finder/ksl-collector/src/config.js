// All KSL-specific selectors and URL knowledge for the collector lives here (plus src/kslParser.cjs,
// which is a copy of apps-script/KslParser.js: run `npm run sync-parser` after editing that file).

export const KSL_BASE = 'https://classifieds.ksl.com';

// What we found when inspecting the site (Oct 2026):
// - Search pages are server-rendered (Next.js). The first ~11 results are embedded in the HTML as JSON,
//   so page 1 needs only a plain HTTP GET (no browser).
// - Further results load on scroll through a Next.js "server action" (POST with a hashed action id that
//   changes on every KSL deploy). That is not a stable public JSON endpoint, so for pages 2+ we use a real
//   browser and let KSL's own page script load the next batch, exactly like a person scrolling.
// - Listing pages (/listing/<id>) are server-rendered too; description, photos and coordinates are in the HTML.
export const SELECTORS = {
  card: 'a[data-item-id]',            // one search result card
  cardPrice: '[aria-label^="Price "]', // aria-label="Price $50" / "Price FREE"
  cardImage: 'img',
  cardCity: '.text-sm span[role="link"]',
  loadMoreButton: 'button:has-text("Load more"), button:has-text("Show more"), button:has-text("More results")'
};

// Text that means "this search legitimately has no results" (not a layout change).
export const NO_RESULTS_RX = /no results|0 results|no listings found|didn['’]t find any/i;

// Resource types the browser never downloads (fewer requests to KSL's servers/CDN).
export const BLOCKED_RESOURCE_TYPES = ['image', 'media', 'font'];
