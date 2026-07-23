# Material Takeoff — Production Knowledge Base

_Definitive current state of the Material Takeoff service in production, sample responses, and the
forward roadmap._ **Last updated: 2026-07-16.**
Repo: `github.com/Dale260839/house-intelligence-` · branch `main` · service dir `material-takeoff/`

---

## 1. What it is

Give it a kitchen remodel's size + measurements, and it returns an **order-ready material list** —
quantities that already include standard waste factors, with the raw measurement + waste %/coverage
shown so the math is auditable ("no waste, no shortage") — plus a plumbing/electrical rough-in
checklist. Optionally (`price=true`) it attaches **live Home Depot pricing** per line and a
**profit layout** (materials + labor → cost → markup → client price → profit + margin).

**v1 scope: one project type — `kitchen_remodel`.** Sibling of House Intelligence (separate Railway
service, shared repo). Called server-to-server by BuildSuite.

**Prod base URL:** `https://house-intelligence-production-f7f6.up.railway.app`

---

## 2. Production status (2026-07-16)

| Capability | Status | Notes |
|---|---|---|
| **Quantities** (`POST /material-takeoff`) | ✅ **Live & stable** | The reliable core. Build against it now. |
| **Rate limiting** | ✅ **Live** | Per-client IP, 120 req/60s, HTTP 429 + `Retry-After`; `/health` exempt. Deployed commit `fe380b8`. |
| **Pricing** (`price=true`) | 🟢 **Provider verified — prod env swap pending** | BigBox retired (multi-day platform outage). **SerpApi verified working end-to-end** (11/11 lines priced with real HD prices). Needs the prod env vars updated (see §6) to go live. |
| Auth / persistence | ❌ Not yet | Roadmap Phase 7 (before billing). |

**Bottom line:** quantities + rate limiting are live in prod. Pricing works (proven on SerpApi) and
goes live the moment the prod env vars are switched from BigBox to SerpApi.

---

## 3. Endpoints

| Method & path | Purpose |
|---|---|
| `GET /material-takeoff/project-types` | Supported types + input form contract (render a form dynamically). |
| `POST /material-takeoff` | `{ projectType, kitchenSqft, ...optional }` → full takeoff. |
| `GET /material-takeoff?projectType=kitchen_remodel&kitchenSqft=200` | Same, query-driven. |
| `GET /health` | Liveness (rate-limit exempt). · `GET /` API index. |

Add `&format=text` for a rendered block. Add `price=true` (+ `tier`, `markupPct`, `laborPct`/`laborCost`)
for pricing. Over the rate limit → **HTTP 429** `{ ok:false, error:"rate_limited", retry_after_s }`.

---

## 4. Sample response — quantities (`POST /material-takeoff {"projectType":"kitchen_remodel","kitchenSqft":200}`)

Real output (trimmed to 3 of 11 material lines). Every line is self-describing: `raw` (measured
driver) → `waste_pct`/`coverage` → `order_qty`/`order_unit` (what to buy), plus a `basis` string.

```jsonc
{
  "ok": true,
  "project_type": "kitchen_remodel",
  "inputs": { "kitchenSqft": 200, "ceilingHeight": 8, "tileLayout": "straight", "floorTile": true,
              "countertopType": "solid", "backsplashHeight": 18, "openings": 2, "includeCeiling": false,
              "cabinetLF": null, "baseCabinetLF": null, "upperCabinetLF": null,
              "countertopSqft": null, "wallPerimeterLF": null },
  "derived": {
    "total_cabinet_lf": 40, "base_cabinet_lf": 24, "upper_cabinet_lf": 16,
    "wall_perimeter_lf": 56.6, "wall_area_sqft": 422.5,
    "backsplash_sqft": 36, "floor_tile_sqft": 200, "tiled_substrate_sqft": 236,
    "countertop_finished_sqft": 24
  },
  "materials": [
    { "key": "base_cabinets", "label": "Base cabinets", "type": "made_to_measure",
      "raw": 24, "raw_unit": "LF", "waste_pct": 0, "order_qty": 24, "order_unit": "LF",
      "field_verify": true, "basis": "0.2 LF/sqft total x 60% base",
      "note": "Linear feet, made-to-measure -> NO waste factor. Always field-verify before ordering." },

    { "key": "countertop", "label": "Countertop slab (solid)", "type": "waste_factor",
      "raw": 24, "raw_unit": "sqft", "waste_pct": 15, "order_qty": 28, "order_unit": "sqft",
      "field_verify": true, "basis": "1 sqft per base LF (24 LF)",
      "note": "Slab order adds 15% (solid) to 25% (veined) cutting waste. Field-verify." },

    { "key": "thinset", "label": "Thinset mortar", "type": "coverage",
      "raw": 236, "raw_unit": "sqft", "coverage": 75, "coverage_unit": "sqft/bag",
      "order_qty": 4, "order_unit": "50 lb bag", "waste_pct": null,
      "basis": "backsplash 36 + floor 200 sqft set" }
    // ...8 more: upper_cabinets, backsplash_tile, floor_tile, grout, drywall_sheets,
    //           joint_compound, drywall_tape, drywall_screws  (11 total)
  ],
  "fixtures_checklist": {
    "plumbing":   [ /* 7 items: sink, faucet, supply lines, shutoffs, P-trap, dishwasher, disposal */ ],
    "electrical": [ /* 6 items: GFCI receptacles, small-appliance + dedicated circuits, range, lighting, Romex */ ]
  },
  "field_verify_items": ["base_cabinets", "upper_cabinets", "countertop"],
  "summary": "Full Kitchen Remodel - 200 sqft: 11 material lines quantified ... 13-item rough-in checklist ...",
  "disclaimer": "This is an order-ready STARTING POINT ... NOT a substitute for field measurement ..."
}
```

**Line `type`s:** `made_to_measure` (cabinets — no waste, `field_verify`), `waste_factor`
(`order = raw × (1+waste%)`), `coverage` (`order = ceil(raw ÷ coverage)` whole units).

---

## 5. Sample response — with pricing (`&price=true&tier=better`)

When pricing is on, a `pricing` block is added (quantities unchanged). Values below are **real,
from SerpApi**. Note the caveats in §6.

```jsonc
"pricing": {
  "ok": true,
  "source": "homedepot_live",
  "currency": "USD",
  "tier": "better", "tier_label": "Better - mid-grade",
  "lines": [
    { "key": "thinset", "label": "Thinset mortar", "tier": "better",
      "order_qty": 4, "order_unit": "50 lb bag", "price_unit": "50 lb bag",
      "unit_price": 14.97, "line_cost": 59.88, "priced": true,
      "product_title": "VersaBond 50 lb. Gray Professional Polymer-Modified Thinset Mortar",
      "product_url": "https://.../p/Custom-Building-Products-VersaBond-.../202090305" },
    { "key": "drywall_sheets", "label": "Drywall (4x8 sheets)", "tier": "better",
      "order_qty": 16, "order_unit": "sheet", "price_unit": "sheet",
      "unit_price": 21.98, "line_cost": 351.68, "priced": true,
      "product_title": "1/2 in. x 4 ft. x 8 ft. Mold and Moisture-Resistant Gypsum Board" }
    // ...one per material line (11)
  ],
  "unpriced_lines": [],        // lines the price service couldn't match land here (never fails the request)
  "fully_priced": true,
  "labor": { "basis": "pct_of_materials", "pct_of_materials": 100, "cost": 21323.14 },
  "profit_layout": {
    "materials_cost": 21323.14,
    "labor_cost":     21323.14,
    "total_cost":     42646.28,
    "markup_pct":     20,          // the applied markup
    "price":          51175.54,    // what the client pays
    "profit":         8529.26,     // price - total_cost
    "margin_pct":     16.7         // profit / price (implied margin)
  },
  "disclaimer": "Prices are LIVE from a third-party Home Depot pricing API ... budgetary estimate, not a quote ..."
}
```

- **Both lenses shown:** `markup_pct` (input) and `margin_pct` (implied gross margin).
- **Independent of quantities:** a `price=true` call always returns `ok:true` with full quantities;
  only `pricing.ok` reflects whether prices came through. Render the pricing block **only when
  `pricing.ok === true`**.

---

## 6. Pricing provider — SerpApi (Home Depot engine)

**Provider:** SerpApi's Home Depot Search API (`engine=home_depot`). Replaced BigBox after BigBox's
Home Depot service went into a multi-day platform-wide outage (verified via BigBox's own demo key).

**Prod configuration (Railway → material-takeoff service → Variables):**
```
HOMEDEPOT_API_KEY = <SerpApi API key>
# HOMEDEPOT_API_URL: DELETE it — with no URL set, the code defaults to SerpApi's Home Depot engine.
```
Our code (`pricing_provider.js`) defaults to `https://serpapi.com/search.json?engine=home_depot`, so
SerpApi needs **only the key**; the `HOMEDEPOT_API_URL` template is for other providers (e.g. BigBox)
and must be removed for SerpApi.

**SerpApi raw response our provider consumes** (trimmed — `products[].price` is a plain number):
```jsonc
{
  "search_metadata": { "status": "Success" },
  "search_parameters": { "engine": "home_depot", "q": "1/2 in drywall 4x8" },
  "products": [
    { "title": "1/2 in. x 4 ft. x 8 ft. TE Lite-Weight Gypsum Board",
      "brand": "ToughRock", "model_number": "012237",
      "rating": 4.48, "reviews": 376, "price": 17.98,
      "link": "https://.../p/ToughRock-...-Gypsum-Board-012237/202830343" },
    { "title": "1/2 in. x 4 ft. x 8 ft. Mold and Moisture-Resistant Gypsum Board",
      "brand": "ToughRock", "price": 21.98, "link": "https://.../100322690" }
  ]
}
```
`extractProduct()` reads `products[0].price` (+ title + link). Also handles SerpApi
`product_results`, BigBox `search_results[].product`, and a flat `{price,title,link}` shape.

**Cost:** SerpApi free trial ≈ 100 searches/month; each full priced takeoff uses ~11 (one per line,
run at concurrency 5) → ~9 takeoffs on the trial before a paid plan is needed.

**⚠️ Known data-quality caveats (integration is correct — these are search-term tuning items):**
- **Tile is priced per *case*, not per sqft.** HD sells tile by the box; SerpApi returns the case
  price, so tile line totals are currently inflated (e.g. floor tile priced at a per-case rate ×
  sqft). Roadmap §5 item #4 (pack-size rounding) fixes this.
- **Countertop can match a sample swatch** instead of a slab (search term needs refining).
- Consumables (thinset, grout, drywall, compound, tape, screws) price **accurately** today.

---

## 7. Rate limiting (live)

- **Per client IP**, in-memory fixed window. Default **120 requests / 60s** (env-configurable:
  `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_DISABLED`).
- Over the limit → **HTTP 429** `{ ok:false, error:"rate_limited", retry_after_s: N }` + `Retry-After` header.
- Every response carries `X-RateLimit-Limit` / `-Remaining` / `-Reset` so clients self-throttle.
- **`/health` is exempt.** Proxy-aware (uses `X-Forwarded-For` first hop behind Railway).
- **Limit:** in-memory per process — a multi-instance deploy multiplies the effective limit; move the
  counter to Redis/Supabase when scaling out.

---

## 8. What it currently handles vs. does NOT

**Handles:** `kitchen_remodel` only → ~11 material lines (cabinets, countertop, backsplash + floor
tile, thinset, grout, drywall + compound/tape/screws) with waste built in + a 13-item rough-in
checklist; optional tiered live pricing + profit layout; per-client rate limiting.

**Does NOT (current limits):**
1. Kitchen only — no bathroom/flooring/whole-home.
2. Estimates, not measurements (square-room geometry unless real measurements passed).
3. Cabinets/countertops made-to-measure (`field_verify`, budget only).
4. Tile in sqft, not vendor boxes/slabs (→ pricing caveat §6).
5. One tile layout for floor + backsplash.
6. No demo, subfloor, paint, trim, hardware, appliances, permits.
7. Drywall assumes a full re-rock.
8. Rough-in checklist is rules-of-thumb, not code compliance.
9. No auth/persistence yet (rate limiting IS in place).
10. US-only.
11. Cosmetic: em-dash characters in a few dataset labels can render as mojibake (`â€"`) — minor,
    fixable by swapping em-dashes for `-`.

---

## 9. Future plans (roadmap)

Full detail + effort estimates in **`MATERIAL_TAKEOFF_PLAN.md`**. Summary:

| Phase | Item | Value | Effort (real dev) |
|---|---|---|---|
| **0** | Engine refactor → pluggable per-project **builders** (unblocks all new types) | Foundational | 1.5–2 d |
| **1** | **Bathroom remodel** project type (shower/tub surround, waterproofing, backer board, vanity) | High — #2 requested | 3–4 d |
| **2** | Measurement accuracy — `roomShape` (galley/L/U/island) + per-wall inputs | High | 2–3 d |
| **3** | Vendor pack-size rounding (tile → boxes, countertop → slabs) + per-surface tile layout | Med-High — fixes pricing §6 | 2–3 d |
| **4** | Material add-ons: demolition, subfloor/backer, paint, trim, hardware | Med | 3–4 d |
| **5** | **Flooring-only** project type | Med | 2 d |
| **6** | Drywall scope modes (full / patch / none) | Med | 1 d |
| **7** | Productionization: **auth + persistence** (rate limiting ✅ done) | High — pre-billing | 3–5 d |
| **8** | Region/era-aware rough-in (tie into House Intelligence) | Low-Med | 2–3 d |
| **9** | Whole-home / multi-room scoping | Low (later) | 4–6 d |

**Suggested order:** Phase 0 → 1 (bathroom) → 2 (accuracy) → 3 (pack sizes / fix tile pricing) →
7 (auth+persistence, can run in parallel). **Rough total to a strong v2 (Phases 0–3 + 7): ~12–17 dev days.**

**Immediate next actions:**
1. Set SerpApi key in prod (§6) → pricing goes live.
2. Tune tile/countertop pricing (search terms + per-case→per-sqft) — folds into Phase 3.
3. Fix the em-dash labels (quick).
4. Kick off Phase 0 refactor before adding the bathroom type.

---

## 10. Repo / deploy

- **Deploy:** Railway auto-deploys `material-takeoff/` from `main`. Zero runtime dependencies
  (`node server.js` is the whole start command).
- **Latest pushed commits:** `ddd09ed` (docs), `fe380b8` (rate limiting), `ab947b7` (parallelized
  pricing), `cb73d62` (pricing + profit layer).
- **Tests:** `npm test` → **178 passing** (57 engine + 60 pricing + 24 rate-limit + 37 server).
- **Live-pricing verification tool:** `HOMEDEPOT_API_KEY=<serpapi> node smoke_pricing.js 200 better`.
- Related docs: `material-takeoff/API_GUIDE.md` (frontend), `MATERIAL_TAKEOFF_PLAN.md` (roadmap),
  `PRODUCT_KNOWLEDGE_BASE.md` (HI + MT overview), `MATERIAL_TAKEOFF_STATE.md` (session context).
