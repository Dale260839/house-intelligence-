# Material Takeoff — Current State (session context)

_A load-me-first context file for a Claude chat session picking up the Material Takeoff work._
**Last updated: 2026-07-11.** Repo: `c:\Users\John\ProgrammingProjects\house-intelligence-`
(GitHub `Dale260839/house-intelligence-`, branch `main`).

---

## TL;DR — where things stand

- **Quantity engine:** ✅ built, tested, **live in production** for a long time.
- **Pricing + profit layer:** ✅ built, tested (150 tests), **committed & pushed**, and **deployed**
  to prod. Uses **live BigBox (Home Depot) pricing**, lookups parallelized.
- **🟡 ACTIVE BLOCKER (BigBox side, not ours):** prod + local both return `http_400` because BigBox is
  still **"preparing" zipcode 98006** — a one-time, per-zipcode provisioning step. Config and code are
  correct; we're just waiting for BigBox to flip it `preparing → ready`. See §2.
- **No code or config changes are pending.** Prod config was fixed (the earlier `auth_error` is gone).
  Once BigBox finishes preparing 98006, pricing works with zero further changes.

---

## 1. What it is

`material-takeoff/` — sibling of House Intelligence in the same repo, separate Railway service.
Give it a kitchen-remodel scope + size → an **order-ready material list** (quantities with waste
factors + auditable math) + a plumbing/electrical rough-in checklist. **v1: `kitchen_remodel` only.**

Opt-in pricing layer (`price=true`): prices each material line at a **quality tier**
(good/better/best) from **live Home Depot pricing via BigBox**, adds a **labor line**, and produces a
**profit layout** (materials → labor → cost → markup% → client price → profit + implied margin%).

**Prod URL:** `https://house-intelligence-production-f7f6.up.railway.app`
(House Intelligence is a *separate* service at `https://house-intelligence-production.up.railway.app`.)

---

## 2. 🟡 The active blocker: BigBox is still "preparing" the zipcode

**Current symptom:** prod + local both return `pricing.ok:true`, `source:"homedepot_live"`, but every
line is `unpriced` with `http_400`. Raw BigBox message:
> *"Zipcode '98006' is set up on your account but is **not yet ready to service requests**... it takes
> a couple minutes before they are available."*

**What this means:** BigBox provisions each newly-added zipcode before it can serve requests (HD prices
are store-specific, so it caches that store first). This is a **one-time, per-zipcode** step — it does
**not** happen per request, and won't recur for 98006 once ready. Just waiting on BigBox.

**Everything on our side is DONE and validated:**
- ✅ Key valid (`/account` → `success:true`, Free plan, 100 credits, 0 used).
- ✅ Zipcode **98006** configured by Chris (`/zipcodes` → status `preparing`).
- ✅ Railway vars corrected (prod flipped from `auth_error` → `http_400`, proving it now hits BigBox
  correctly with the zip). `HOMEDEPOT_API_KEY` = raw key; `HOMEDEPOT_API_URL` = BigBox template with
  `customer_zipcode=98006`.
- ✅ Code correct + parallelized — **local and prod produce identical `http_400`**, i.e. nothing left
  to change on our end.

**History (resolved):** the earlier `auth_error` was a misconfigured Railway var (whole URL pasted into
`HOMEDEPOT_API_KEY`, no `HOMEDEPOT_API_URL` → hit SerpApi with a bogus key). Fixed.

**REMAINING ACTION: none on our side — wait for BigBox.** Chris can watch
https://app.bigboxapi.com/zipcodes for 98006 to flip `preparing → ready` (contact BigBox support if it
stalls). Then it just works.

**Verify command (run once BigBox is ready):**
```
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&format=text"
```
Expect 11 priced lines + a full profit layout.

---

## 3. BigBox account facts (as of 2026-07-11)
- Provider: **BigBox API** (Traject Data) — purpose-built for Home Depot.
- Account: **Chris Carr**, `home@alliance4contractors.com`, **Free** plan.
- Credits: **100/month, 0 used**, reset 2026-08-13. **~1 credit per material line → ~9 full priced
  takeoffs** before the free tier is exhausted (size up for real use).
- Zipcodes: **limit 1** — **98006 (Bellevue, WA) configured by Chris**, currently `status: preparing`
  (one-time BigBox provisioning; ← the current wait). Switching stores means removing this one first.
- API key: `CCC6…D067` (exposed in screenshots this session — **recommend rotating** once live).
  Real value lives in Railway env + the BigBox dashboard.
- Endpoints used: `/request?type=search&search_term=…&customer_zipcode=…`, `/account`, `/zipcodes`.

---

## 4. Architecture / files (`material-takeoff/`)
| File | Role |
|---|---|
| `material_dataset.json` | Quantity rates/waste + the **`pricing`** block (tiers, per-line HD search terms, defaults, disclaimers). |
| `takeoff_engine.js` | Quantity engine (unchanged by pricing — deterministic, sync). |
| `pricing_provider.js` | Live BigBox/SerpApi provider over a zero-dep https shim + a `mock` provider + `selectPricingProvider(env)`. Provider-agnostic parser (`extractProduct`/`parsePrice`). |
| `pricing_engine.js` | `priceTakeoff()` — tier selection, per-line cost, labor, markup+margin layout. **Lookups run concurrently (cap 5) via `mapLimit`.** |
| `server.js` | HTTP API; opt-in `price=true` (async). |
| `smoke_pricing.js` | Live-verification tool (`npm run smoke:pricing`). Runs vs mock with `PRICING_MOCK=1`. |
| `test_engine.js` / `test_pricing.js` / `test_server.js` | 57 / 60 / 33 tests = **150 total**. |

**Pricing flow:** `buildTakeoff` (quantities) → `priceTakeoff(takeoff, {provider, tier, markupPct, laborPct/laborCost})` → per line `provider.lookup({query})` builds the BigBox URL from `HOMEDEPOT_API_URL` (or SerpApi default), parses the first product price, `line_cost = unit_price × order_qty` → labor + markup/margin layout. Failures degrade to `unpriced_lines`; a bad price NEVER fails the request.

---

## 5. Config / env (material-takeoff service)
| Var | Purpose | Current status |
|---|---|---|
| `HOMEDEPOT_API_KEY` | BigBox raw key → activates live pricing. No key → `pricing_unavailable` (quantities still return). | ✅ **Set correctly** to the raw key. |
| `HOMEDEPOT_API_URL` | Endpoint template (`{key}`/`{query}` placeholders). Default = SerpApi. For BigBox, set + include `&customer_zipcode=`. | ✅ **Set** to BigBox template with `customer_zipcode=98006`. |
| `PRICING_MOCK` | Dev/test only — deterministic fake prices, no key/network. `0/false/no/off` = disabled. | Not set in prod (correct). |
| `PORT` | Railway injects. | ok |

Repo-root `.env.example` documents all three. There is **no baked price catalog** (live-only by design).

---

## 6. Git / deploy state
- Branch `main`, **in sync with `origin/main`**. Railway auto-deploys the material-takeoff service from `main`.
- Relevant commits (all pushed):
  - `ab947b7` — Parallelize price lookups (capped concurrency).
  - `cb73d62` — Add pricing & profit layer (live Home Depot pricing).
  - `58dc199` — Original Material Takeoff module (engine + HTTP API).
- **Uncommitted (docs only, no prod impact):** `API_GUIDE.md` (HI), `BUILDSUITE_INTEGRATION.md`,
  `PRODUCT_KNOWLEDGE_BASE.md`, `EOD_MATERIAL_TAKEOFF_2026-07-09.md`, `EOD_MATERIAL_TAKEOFF_2026-07-11.md`,
  and this file. (House Intelligence code is untouched this thread.)

---

## 7. Known issues / gotchas
- **em-dash artifact:** `tier_label` renders as `Better â€" mid-grade` in served JSON — an em-dash
  encoding issue in `material_dataset.json` tier labels. Cosmetic, **not yet fixed** (planned: replace
  em-dashes with `-`; HI had the same issue before).
- **Made-to-measure pricing is rough:** cabinets priced per LF, countertop per sqft (flagged
  `field_estimate:true`) — budget only, not a quote. Tile priced per sqft, not per box/slab.
- **Labor default = 100% of materials** — a placeholder rule of thumb; override per job.
- **Free-tier credits** run out fast (~9 takeoffs) — see §3.

---

## 8. Next steps (in order)
1. **Wait for BigBox** to finish preparing zip 98006 (`preparing → ready`). Nothing to change; a poll
   for `hammer` returning `success:true` = ready. (As of 2026-07-11 it had not finished after ~8 min.)
2. **Then:** re-test prod (§2 verify command) → confirm 11 priced lines + profit layout. First real
   call also validates BigBox's response shape parses via `extractProduct` (standing "confirm live
   shape" rule).
3. Fix the em-dash tier labels (quick, key-free).
4. Consider: rotate the exposed BigBox key; upgrade BigBox plan before real usage.
5. Later product work: 2nd project type (bathroom — data-driven, no engine rewrite); wire pricing into
   the BuildSuite proposal UI; unit reconciliation (tile per box, not sqft).

---

## 9. Quick commands
```bash
cd material-takeoff
npm test                                   # 150 tests
PRICING_MOCK=1 node smoke_pricing.js 200 better         # dry-run pricing (no key)
HOMEDEPOT_API_KEY=<key> HOMEDEPOT_API_URL='https://api.bigboxapi.com/request?api_key={key}&type=search&search_term={query}&customer_zipcode=98499' \
  node smoke_pricing.js 200 better         # LIVE verification against BigBox
```
```bash
# BigBox account/zipcode diagnostics (replace KEY)
curl "https://api.bigboxapi.com/account?api_key=KEY"
curl "https://api.bigboxapi.com/zipcodes?api_key=KEY"
```
```bash
# prod quantities (works today) / prod pricing (works after §2 fix)
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&format=text"
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&format=text"
```
