# Deal Finder setup checklist

Claude walks you through this one step at a time and ticks each box once it's verified.
If you stop partway, just say "let's continue setup" and it picks up at the first unchecked box.

**Never paste API keys, tokens or passwords into the chat.** Each step tells you where to put them yourself.

Progress: 3 of 47 done

---

## Phase 1: Accounts and keys

- [ ] 1.1 Create the "Deal Finder" Google Sheet with its attached Apps Script project (done by `clasp create` in 2.3, or by hand if you choose the copy-paste install)
- [x] 1.2 Anthropic: create an API key named "Deal Finder" at console.anthropic.com → API keys (keep the tab open; you'll paste it in step 2.5)
- [x] 1.3 Anthropic: add a small prepaid credit (e.g. $5, auto-reload OFF) and set a monthly spend limit of $5 (Settings → Limits)
- [x] 1.4 Apify: create an account at apify.com (Google sign-in is fine)
- [ ] 1.5 Apify: set a monthly usage limit (Settings → Usage & billing → Limits), suggested to match `APIFY_MONTHLY_BUDGET`
- [ ] 1.6 Apify: copy your API token from Settings → API & Integrations (paste it in 2.5)
- [ ] 1.7 eBay: create a developer account at developer.ebay.com and wait for approval (can take up to a day; everything else works without it)
- [ ] 1.8 eBay: create a **Production** keyset; note the App ID (Client ID) and Cert ID (Client Secret) (paste them in 2.5)
- [ ] 1.9 ntfy: install the ntfy app on your iPhone, allow notifications
- [ ] 1.10 ntfy: subscribe to a private topic name you make up (long and unguessable, e.g. `df-` + 20 random letters)

## Phase 2: Install and deploy

- [ ] 2.1 Choose the install method: **A** (Claude runs `clasp`; you approve a one-time Google sign-in) or **B** (copy-paste 3 files into the Apps Script editor)
- [ ] 2.2 (A) Claude installs `clasp`; you complete the Google sign-in. (B) Open the Sheet → Extensions → Apps Script
- [ ] 2.3 Create the Apps Script project and push the code (A: `clasp create` + `clasp push`; B: paste `dist/Code.gs`, `dist/Dashboard.html`, `dist/appsscript.json`)
- [ ] 2.4 In the Sheet: reload, then **Deal Finder → 1. Set up / repair Sheet**; approve the Google permission screen (Gmail, Drive, Sheets, Docs, external requests)
- [ ] 2.5 Apps Script → Project Settings (gear) → Script Properties: add `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `EBAY_APP_ID`, `EBAY_CERT_ID`, `NTFY_TOPIC`
- [ ] 2.6 Deploy the web app: Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → Deploy
- [ ] 2.7 Open the deployment URL once with `?k=<DASHBOARD_KEY>` (Claude tells you where to find the key) so the system learns its own address
- [ ] 2.8 **Deal Finder → Show dashboard link** → open it on your iPhone in Safari → Share → **Add to Home Screen**
- [ ] 2.9 **Deal Finder → 2. Check setup**: everything except KSL actor / schedules shows ✅

## Phase 3: KSL

- [ ] 3.1 Confirm the Gmail label `KSL Alerts` has alert emails (Check setup shows "KSL Alerts label has emails")
- [ ] 3.2 **Deal Finder → Capture KSL email samples**: saves 10 real alert emails to Drive and shows what the parser read in the "Parser test" tab
- [ ] 3.3 Review the "Parser test" tab together; Claude adjusts the parser if any listing is missing or wrong, then re-runs the tests
- [ ] 3.4 **Deal Finder → Read KSL alert emails now**: rows appear on the Deals / Filtered tabs
- [ ] 3.5 Claude installs the Apify CLI and you complete `apify login` (one-time sign-in, same as clasp)
- [ ] 3.6 Claude runs the collector locally once (robots.txt + 1 search page) and shows the result
- [ ] 3.7 Claude runs `apify push`; you see "ksl-classifieds-collector" under Apify Console → Actors
- [ ] 3.8 Put the actor ID (`yourname~ksl-classifieds-collector`) in Settings → `KSL_ACTOR_ID`
- [ ] 3.9 **Deal Finder → Run KSL baseline** (about 50 page loads, spread over 2 days if needed)
- [ ] 3.10 Review the "KSL baseline results" push and the baseline cards on the dashboard (filter Source = KSL (baseline))

## Phase 4: Facebook

- [ ] 4.1 Open the actor page (apify.com/apify/facebook-marketplace-scraper) and accept its terms if Apify asks
- [ ] 4.2 Confirm `FB_LOCATION_SLUG` (open facebook.com/marketplace/saltlakecity/ in a browser; the slug is the part after /marketplace/)
- [ ] 4.3 **Deal Finder → Run Facebook free sweep now**; within ~10 minutes new rows appear and the Logs tab shows the run cost

## Phase 5: Schedules and alerts

- [ ] 5.1 **Deal Finder → 3. Install schedules (triggers)**
- [ ] 5.2 **Deal Finder → Send test push** arrives on your phone
- [ ] 5.3 Confirm quiet hours (`QUIET_START` 22, `QUIET_END` 6) and the push thresholds
- [ ] 5.4 Review the Settings tab together: Facebook budget trade-offs, keyword table, category ceilings, digests
- [ ] 5.5 After the first hour: Logs tab shows ticks running without errors and the projected monthly cost

## Phase 6: iPhone Shortcut (manual share)

- [ ] 6.1 Copy your `SHARE_TOKEN` from Script Properties into a note on your phone (you'll type it into the Shortcut, not the chat)
- [ ] 6.2 Build the "Deal Finder" Shortcut (steps in README → Manual share)
- [ ] 6.3 Turn on "Show in Share Sheet"
- [ ] 6.4 Share a real listing link to it; the reply shows a score and the deal appears on the dashboard
- [ ] 6.5 Share a screenshot to it; same result

## Phase 7: Final end-to-end test

- [ ] 7.1 One Facebook free sweep → rows + cards
- [ ] 7.2 One KSL email intake → rows + cards
- [ ] 7.3 One manual share → row + card + reply
- [ ] 7.4 A deal scoring 8+ (or a test push) reaches your phone and opens the dashboard card
- [ ] 7.5 Day-to-day walkthrough: checking deals, updating status, drafting a resale listing, logging a sale
