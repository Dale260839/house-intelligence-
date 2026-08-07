# Material Takeoff — Technical Reference

_Complete technical reference: architecture, endpoints, data flow, pricing/extraction pipelines,
decisions, and configuration. Last updated 2026-08-04._

**Repo:** `house-intelligence-/material-takeoff/` (GitHub `Dale260839/house-intelligence-`, branch `main`, Railway auto-deploy).
**Prod:** `https://house-intelligence-production-f7f6.up.railway.app`
**Stack:** Node core only — **zero runtime dependencies**. **559 tests, 0 failing.**

---

## Table of contents

1. What it is
2. Architecture & principles
3. File map
4. API endpoints
5. Project types, inputs & add-ons
6. Material line types
7. Data flow (request → response)
8. Pricing pipeline
9. Extraction pipeline (proposals)
10. Response reference
11. Configuration (env vars)
12. Decision log
13. Determinism & reliability guarantees
14. Testing
15. Known limitations / open items

---

## 1. What it is

Maps a renovation **scope + size** to an **order-ready material list** — quantities with standard waste
factors already applied and the math shown for auditability — plus a plumbing/electrical rough-in
checklist. Optional **live Home Depot pricing + a profit layout**. Three ways in: a single room, a whole
job (`from-scope`), or a free-text proposal (`from-proposal`). Renders as JSON, text, or print-ready HTML.

Sibling of House Intelligence in the same repo, deployed as a **separate Railway service**.

---

## 2. Architecture & principles

**"Hybrid C" — deterministic core, fallible work behind seams.**

- The **engine** (validate → derive quantities) is **pure, synchronous, zero-dependency**. Same inputs →
  same output, always. It never touches the network and has no external state.
- Everything fallible sits behind a **provider seam** with an injectable transport (so tests never hit
  the network) and an auto-selector mirroring the same pattern:
  - **Pricing** — `pricing_provider.js` (live SerpApi/BigBox | mock), `selectPricingProvider(env)`.
  - **Extraction** — `extraction_provider.js` (LLM | deterministic heuristic), `selectExtractionProvider(env)`.
- **Pluggable builders.** Each project type is a module `builders/<type>.js` exporting `build(v, def, ds)`.
  Adding a type = a dataset block + a builder; the dispatcher doesn't change.
- **Data-driven.** Rates, waste factors, geometry, pricing search terms, and disclaimers live in
  `material_dataset.json`, not code.
- **Graceful degradation over failure.** A bad price, a slow/dead provider, an unmatched line, or a failed
  extraction all **degrade** (`ok:false` / `unpriced_lines` / budget fallback / partial results) — never
  a crash, never a hang.
- **Additive-only responses.** New fields are added; existing keys are never removed or renamed, so the
  BuildSuite frontend keeps working across releases.

---

## 3. File map

| File | Role |
|---|---|
| `server.js` | Node-core HTTP front door: routes, CORS, rate limiter, body parsing, format negotiation. |
| `takeoff_engine.js` | Dispatcher. `buildTakeoff`, `resolveInputs`, `getProjectTypes`, `renderTakeoffText`, `loadDataset`. Stamps `source_type` + per-line `section_id`. |
| `builders/kitchen_remodel.js`, `bathroom_remodel.js`, `flooring_only.js` | Per-type quantity derivation. |
| `builders/addons.js` | Shared optional groups (demolition/subfloor/paint/trim/hardware/site_protection). |
| `line_builders.js` | Line constructors: `madeToMeasureLine`, `wasteFactorLine`, `coverageLine`, `passthroughLine`, `buildFixtures`. |
| `scope_engine.js` | `buildScopeTakeoff` (merge sections) + `buildProposalTakeoff` (extract → scope). add_ons→toggle map, section-id gen. |
| `pricing_engine.js` | `priceTakeoff`, `priceScopeTakeoff`, `priceMaterialLines`, `budgetFallbackLines`, `PRICE_BANDS`, `NOT_RETAIL_KEYS`, reliability + time-budget helpers. |
| `pricing_provider.js` | `createHomeDepotProvider` (cache + breaker + retry), `createMockPricingProvider`, `selectPricingProvider`, `extractProduct`, `normalizePackPrice`, `parsePrice`, `buildSearchUrl`, `SHARED_PRICE_CACHE`. |
| `extraction_provider.js` | Heuristic + LLM extraction, `selectExtractionProvider`, `hashProposal`, block parsing, classification, merge. |
| `pdf_export.js` | `renderTakeoffHtml` — zero-dep print-ready HTML. |
| `rate_limiter.js` | Per-client-IP fixed window; `clientKey`, `selectRateLimiter`. |
| `material_dataset.json` | The knowledge base: per-type inputs, geometry, rates, fixtures, pricing config. |
| `test_*.js` | 11 files, 559 tests (dependency-free harness). |

---

## 4. API endpoints

Base URL: prod above. **CORS enabled** (browser-callable). No client API key (pricing/extraction keys
live on the server). Every takeoff call accepts `format=text` or `format=html` (a.k.a. `print`/`pdf`).

| Method & path | Purpose |
|---|---|
| `GET /` | API index — reports `pricing_enabled`, `rate_limit`, endpoint list. |
| `GET /health` | Liveness probe `{status:"ok"}` (rate-limit exempt). |
| `GET /material-takeoff/project-types` | Supported types + required/optional input contract (render a form dynamically). |
| `POST /material-takeoff` | Single room. Body `{ projectType, <sizeField>, ...optional, price?, tier?, ... }`. |
| `GET /material-takeoff?projectType=…&<size>=…` | Same, query-driven. |
| `POST /material-takeoff/from-scope` | Whole job as `{ sections:[…] }` → merged takeoff, `project_type:"composite"` when >1. POST only. |
| `POST /material-takeoff/from-proposal` | `{ proposal_markdown, … }` → extracted scope → takeoff with provenance. POST only. |
| `GET /demo` | BuildSuite integration demo UI (same-origin). |

**HTTP status semantics:** bad/missing input → **400** with a clear message. `from-proposal` with no
recognizable scope → **200** with `ok:false, error:"no_scope_extracted"` (actionable, not a failure).
Over the rate limit → **429** with `Retry-After`. Pricing failures never change the status — the takeoff
returns 200 and `pricing.ok` carries the signal.

### `from-scope` request

```jsonc
{
  "sections": [
    { "section_id": "kitchen", "label": "Main Kitchen", "project_type": "kitchen_remodel",
      "inputs": { "kitchenSqft": 220 }, "add_ons": ["demolition","paint","site_protection"],
      "budget_hint": 22000 },                 // per-section MATERIALS budget (optional)
    { "label": "Hall Bath", "project_type": "bathroom_remodel", "inputs": { "bathroomSqft": 60 } }
  ],
  "price": true, "tier": "better", "markupPct": 20, "laborPct": 100,
  "budget_total": 40000,                      // CLIENT PRICE (× materialsShare before use)
  "budget_sections": [{ "label": "Kitchen", "amount": 22000 }],
  "materials_budget": 14000, "materialsShare": 0.35,   // optional budget-unit controls
  "location": { "city": "Tacoma", "state": "WA" }
}
```

### `from-proposal` request

```jsonc
{
  "proposal_markdown": "## Scope of Work\n### 1. Bathroom\n- 75 sqft floor tile ...",
  "budget_total": 45000, "budget_sections": [{ "label":"Bathroom", "amount":9000 }],
  "project_type": "bathroom_remodel",         // optional hint
  "price": true, "tier": "better"
}
```

---

## 5. Project types, inputs & add-ons

**Live project types:** `kitchen_remodel`, `bathroom_remodel`, `flooring_only`. Discover exact inputs at
runtime via `GET /material-takeoff/project-types` (drives both the engine's validation and a UI form from
the same spec, so they can't drift).

- **kitchen_remodel** — required `kitchenSqft`. Optionals: cabinet LF overrides, `countertopType`,
  `tileLayout` (+ per-surface), `roomShape`, box/slab sizes, ceiling/openings, etc.
- **bathroom_remodel** — required `bathroomSqft`. `showerType` (tub_shower/shower/tub/none),
  `includeVanity`, `includeWaterproofing`, wall/floor tile, vanity + top, etc.
- **flooring_only** — required `floorSqft`. `flooringType` (tile/lvp/laminate/engineered/hardwood) drives
  setting materials (backer+thinset+grout for tile; underlayment; fasteners for nail-down). Labor default
  60% (vs 100% for full remodels). No plumbing/electrical.

**Add-on groups** (booleans `include*` on the single endpoint; an `add_ons:[]` array per section on v2):

| add_on | Lines | Basis |
|---|---|---|
| `demolition` | `demolition_dumpster` | floor area × debris rate → dumpsters (**not a retail SKU** → `not_retail_sku`) |
| `subfloor` | `subfloor` | floor area +10% → 4×8 panels |
| `paint` | `primer` + `paint` | wall area × coats ÷ 350 sqft/gal |
| `trim` | `baseboard` | perimeter − openings → 16 ft sticks |
| `hardware` | `cabinet_hardware` | cabinet/vanity LF × 0.9 pulls |
| `site_protection` | `floor_protection`, `plastic_sheeting`, `masking_tape`, `dust_barrier`, `hepa_filter` | all **area-derived** (floor area + openings) |

**Passthrough** — long-tail items a ruleset can't derive from geometry (pot filler, range hood) become
`type:"passthrough"`, `calculation:"estimated"` lines carrying their `source_quote`.

---

## 6. Material line types

Every material line is self-describing (raw measurement + the transform + the final order qty):

| `type` | Applies to | Order math |
|---|---|---|
| `made_to_measure` | cabinets, vanity | `order_qty = raw` (no waste); `field_verify:true` |
| `waste_factor` | countertop, tile, drywall (sqft) | `order_qty = raw × (1 + waste_pct/100)` |
| `coverage` | thinset, grout, compound, tape, screws | `order_qty = ceil(raw ÷ coverage)` in whole units |
| `pack_round` | tile w/ box size, slab w/ slab size | `order_qty = ceil(raw×(1+waste) ÷ pack_size)` in whole boxes/slabs; **priced per box/slab** |
| `passthrough` | long-tail proposal items | `order_qty` as stated; `calculation:"estimated"` |

Common fields: `key`, `label`, `type`, `order_qty`, `order_unit`, `basis` (plain-English math),
`field_verify`, and the v2 additions `section_id`, and on proposals `source_quote`/`confidence`.

---

## 7. Data flow (request → response)

```
                          ┌─────────────────────── server.js ───────────────────────┐
  HTTP request  ─────────▶│ CORS/OPTIONS → rate limiter (per-IP 120/60s, /health     │
                          │ exempt) → route dispatch → readJsonBody (size-capped)    │
                          └──────────────────────────┬──────────────────────────────┘
        ┌────────────────────────────────────────────┼────────────────────────────────────────┐
        ▼                                             ▼                                          ▼
 POST /material-takeoff              POST /material-takeoff/from-scope        POST /material-takeoff/from-proposal
   (manual, 1 room)                     (multi-section)                          (free-text)
        │                                             │                    selectExtractionProvider(env)
        │                                             │                     ├─ LLM (EXTRACTION_API_KEY) or
        │                                             │                     └─ heuristic (default)
        │                                             │                    buildProposalTakeoff():
        │                                             │                     • extract() → extracted_scope{sections,notes}
        │                                             │                     • no scope → ok:false @ HTTP 200
        │                                             ▼                          │ sections[]
        │                                   buildScopeTakeoff(body) ◀────────────┘
        │                                     • per section: add_ons→toggles, gen section_id,
        │                                       buildTakeoff(), passthrough
        │                                     • merge materials + fixtures; "composite" when >1
        ▼                                             │ (buildTakeoff called once per section)
  buildTakeoff(params, DATASET)  ◀───────────────────┘
   • validate projectType + resolveInputs (coerce/default vs dataset `inputs` spec)
   • dispatch → builders/<type>.build → derived + materials[] + fixtures_checklist + summary
   • stamp source_type + per-line section_id ; ok:false → HTTP 400        ← DETERMINISTIC, SYNC, ZERO-DEP
        │  ok:true (quantities ALWAYS returned)
        ▼
  price=true ? ──no──▶ render ────────────────────────────────────────────────┐
        │yes                                                                    │
        ▼                                                                       │
  selectPricingProvider(env) → live SerpApi | mock | null                       │
  priceTakeoff() / priceScopeTakeoff()  ──▶ (pricing pipeline, §8)  ──▶ takeoff.pricing
        │                                                                       ▼
        └──────────────────────────▶ render: json (default) | text | html (print→PDF) ─▶ HTTP response
```

---

## 8. Pricing pipeline

`priceTakeoff` / `priceScopeTakeoff` → `priceMaterialLines(materials, cfg, provider, tier, deadlineAt)`:

```
 shared deadlineAt = now + PRICING_MAX_TOTAL_MS (20s)        ← total-time budget
 mapLimit(concurrency 5) over lines → priceOne(line):
   ├─ no search config          → unpriced: no_pricing_config
   ├─ dumpster (NOT_RETAIL_KEYS) → unpriced: not_retail_sku      (skip live call)
   ├─ past deadline             → unpriced: pricing_timeout      (partial results)
   ├─ band = PRICE_BANDS[key] (dataset min/max_unit_price overrides)
   └─ provider.lookup({query, minPrice, maxPrice, priceUnit, timeoutMs=remaining budget}):
        1. shared price cache (TTL 24h) hit ──────────▶ cached (instant, 0 credits)
        2. per-request memo hit ─────────────────────▶ return
        3. circuit breaker tripped ──────────────────▶ provider_unavailable (fail fast)
        4. retry loop (maxRetries, backoff):
             attempt(): fetch → status → 200-with-error? → provider_error (transient)
                        else extractProduct(json):
                          • normalizePackPrice (case/pack → per-unit)
                          • pallet-outlier guard (median×12) + swatch floor
                          • per-line sanity band → drop unit mismatches
                          → price | no_match
             transient → count toward breaker, backoff, retry (abort if breaker trips)
             success → write shared cache + memo
   success → priced line: unit_price, line_cost = unit_price × order_qty, price_source
```

**Merge / cost step:**

- **Budget fallback** (scope/proposal): unmatched lines are filled from the section's *materials* budget,
  tagged `price_source:"proposal_budget"`. Budget units: `budget_total`/`budget_sections` are the **client
  price** → `× materialsShare` (default **0.35**); `materials_budget` and from-scope `budget_hint` are
  already materials, used as-is. Tops up when the budget ≥ live-priced materials.
- **One labor line** (explicit `$` via `laborCost`, else `laborPct` % of materials).
- **One profit layout:** `materials + labor = total_cost` → `× (1+markup)` = `price` → `profit = price −
  total_cost`, `margin% = profit/price`. Shown both as markup% (input) and margin% (implied).
- **Reliability:** `priced_count`/`unpriced_count`; `pricing.ok=false` + `reason:"pricing_degraded"` when
  >25% of lines fail; `pricing.timed_out:true` when the budget/breaker cut the pass short.

**Pack normalization** parses the pack size from the product title (`(23.95 sqft/case)`, `(5-Pack — 80
Total Linear Feet)`, `Case of N`) and divides to the line's unit before costing — fixing 5×–25×
over-pricing. **Per-line sanity bands** (`PRICE_BANDS`) drop unit mismatches to `unpriced_lines` rather
than ship a wrong number.

**Providers:** live via SerpApi Home Depot engine (or a `{query}`/`{key}` template for BigBox) through a
zero-dep HTTPS shim; a deterministic `mock` for dev/tests (`PRICING_MOCK`); `null` when no key
(pricing unavailable, quantities still return). Cache is module-level in prod, per-instance in tests.

---

## 9. Extraction pipeline (proposals)

`buildProposalTakeoff` → `provider.extract({ proposal_markdown, budget_total, budget_sections, project_type_hint })`:

- **Heuristic (default, deterministic):**
  1. `selectBlocks` — if a `## Scope of Work` heading exists, only its `### N.` subsections count (or
     `- **Title**: body` bullets); else legacy top-level headings. Non-work headings (Executive Summary,
     Exclusions, Warranty, Permits, …) are **denylisted**.
  2. `classifyBlock` — score by keyword hits; **dominant-type biasing** folds a weak "floor tile" phase
     into the dominant room instead of spawning a spurious `flooring_only` section.
  3. `extractSection` — pull area (`stated` vs `assumed` confidence), add-ons, passthrough, a body-sentence
     `source_quote`; remove-and-reinstall generates no new item.
  4. `mergeRoomSections` — same-type phases merge into one job (labeled by resolved trade); global
     add-ons/passthrough apply to the primary section.
- **LLM (behind the seam, `EXTRACTION_API_KEY`):** structured output, temperature 0, **cached by proposal
  hash** (identical proposal → identical result, no re-bill). Handles arbitrary formats.
- Output: `extracted_scope{sections[],notes[]}` → run the **same** deterministic `buildScopeTakeoff`.
  Every material line inherits its section's `source_quote`/`confidence`; sections gain `id`/`area_sqft`;
  assumed areas surface at the response level as `assumptions[]`. `no_scope_extracted` → `ok:false` @ 200.

---

## 10. Response reference

**Top level (all takeoffs):** `ok`, `project_type` (or `"composite"`), `project_label`, `source_type`
(`manual`|`scope`|`proposal`), `inputs`/`derived` (manual) or `sections`/`derived_by_section` (scope),
`materials[]`, `fixtures_checklist`, `summary`, `field_verify_items`, `disclaimer`. Proposals add
`extracted_scope`, `extraction_source`, `assumptions[]`.

**Material line:** `key`, `label`, `type`, `order_qty`, `order_unit`, `basis`, `field_verify`,
`section_id`, (+ `source_quote`/`confidence` on proposals; type-specific `raw`/`waste_pct`/`coverage`/
`pack_size`).

**`pricing` block (when `price=true`):** `ok`, `reason?`, `source`, `currency`, `tier`/`tier_label`,
`lines[]`, `unpriced_lines[]`, `fully_priced`, `priced_count`, `unpriced_count`, `timed_out?`,
`sections[]` (scope breakdown), `labor`, `profit_layout`, `warnings?`, `disclaimer`.

**Priced line:** `key`, `label`, `section_id`, `order_qty`, `order_unit`, `price_unit`, `unit_price`,
`line_cost`, `price_source`, `product_title`, `product_url`, `field_estimate`, `query`.

**Enums:**
- `price_source`: `homedepot_live` | `mock` | `proposal_budget`
- unpriced-line `reason`: `no_pricing_config` | `not_retail_sku` | `pricing_timeout` |
  `provider_unavailable` | `provider_error` | `network_error` | `rate_limited` | `auth_error` | `http_5xx`
  | `no_match`
- `pricing.reason`: `pricing_unavailable` | `pricing_degraded` | `no_takeoff` | `no_pricing_config`
- `confidence`: `stated` | `inferred` | `assumed`

> **Plan gating** is BuildSuite's job — the API **always** returns the full payload; the frontend does any
> blur/teaser. `product_url` is normalized to a public `www.homedepot.com` page. `order_discount` (volume
> tiers) is a documented seam between `materials_cost` and `total_cost`, not yet applied.

---

## 11. Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | 3100 / 0.0.0.0 | Railway injects PORT. |
| `HOMEDEPOT_API_KEY` | — | SerpApi (or BigBox) key → live pricing. No key → pricing unavailable. |
| `HOMEDEPOT_API_URL` | SerpApi HD engine | Endpoint template (`{query}`/`{key}` for BigBox). |
| `PRICING_MOCK` | off | Dev/test deterministic prices (never in prod). |
| `PRICING_TIMEOUT_MS` | 12000 | Per-lookup fetch timeout. |
| `PRICING_MAX_TOTAL_MS` | 20000 | Total-time budget for a pricing pass. |
| `PRICING_MAX_RETRIES` | 2 | Retries on transient failure. |
| `PRICING_BREAKER_THRESHOLD` | 5 | Consecutive fails before the circuit breaker trips. |
| `PRICE_CACHE_TTL_MS` | 86400000 (24h) | Persistent price-cache TTL. |
| `EXTRACTION_API_KEY` / `ANTHROPIC_API_KEY` | — | Turns on LLM extraction; else heuristic. |
| `EXTRACTION_MODEL` / `EXTRACTION_API_URL` | `claude-sonnet-5` / Anthropic | LLM config. |
| `RATE_LIMIT_MAX` / `_WINDOW_MS` / `_DISABLED` | 120 / 60000 / off | Rate limiter. |

---

## 12. Decision log

| # | Decision | Rationale |
|---|---|---|
| D-1 | **Live pricing only, no baked catalog** | Product-owner choice; real HD prices or none. No key → `pricing_unavailable`, quantities still return. |
| D-2 | **Good/better/best tiers; profit shown as markup% AND margin%; labor as a line** | Contractors think in both markup and margin; labor is explicit, not hidden. |
| D-3 | **SerpApi over BigBox** | BigBox had its own outage (zip "preparing", 503/500) in July; BigBox flagged "problematic". Seam keeps BigBox one config swap away. |
| D-4 | **Hybrid C — deterministic core + LLM at the edge** | Keeps quantity math and tests reproducible; the only fuzzy step (prose→scope) is isolated + mockable. |
| D-5 | **Per-project builders + data-driven dataset** | A new project type is a dataset block + a builder; dispatcher untouched. |
| D-6 | **PDF = print-ready HTML (`format=html`), not a server-side PDF engine** | A pdfkit/puppeteer dep would break zero-dependency; the browser owns the paper. |
| D-7 | **Plan gating is BuildSuite's job** | API stays "full payload always" — simpler, cacheable; frontend blurs. |
| D-8 | **Pack/case normalization + per-line sanity bands** | HD lists by case/pack; reading a case price per-unit over-charged 5×–25×. Bands drop unit mismatches to unpriced, never a wrong number. |
| D-9 | **Scope-of-Work parsing + denylist + dominant-type biasing + bolded-bullet subsections** | Match BuildSuite's real proposal format; stop non-work headings (Exclusions/Warranty) and phase subsections from spawning phantom takeoffs. |
| D-10 | **Budget units: `budget_total`/`budget_sections` = client price × `materialsShare` (0.35); explicit `materials_budget` bypasses** | A client-price budget spread across materials produced a $15k → $36k bug. |
| D-11 | **Reliability layer: circuit breaker + persistent cache + total-time budget + 200-error handling** | Provider slowness/outage must degrade fast (partial + flag), stay cheap (cache), and survive outages — not hang or silently understate. |
| D-12 | **Additive-only response shape** | BuildSuite is integrated; correcting values + adding fields keeps them working with no changes. |
| D-13 | **`demolition_dumpster` → `not_retail_sku`** | HD doesn't rent 20-yd dumpsters; a distinct reason lets the UI render a "local quote" line vs a broken lookup. |

---

## 13. Determinism & reliability guarantees

- Engine + builders are **pure and synchronous** — same inputs, same output.
- Pricing and extraction are the only async/external steps and are both **seam + mock**; the full suite
  runs with **no network and no keys**.
- **Extraction cached by proposal hash** (sha256): identical `proposal_markdown` → identical result.
- **Nothing crashes a request:** bad price, unmatched line, provider outage, bad section, or failed
  extraction all degrade (`ok:false` / `unpriced_lines` / budget fallback / partial results).
- **Bounded latency:** the total-time budget + circuit breaker cap a pricing pass even when the provider
  hangs; the persistent cache serves prices through provider outages.

---

## 14. Testing

**559 passing, 0 failing** (`npm test`), dependency-free harness. Coverage: engine 59 · bathroom 46 ·
room-shape 19 · pack-size 23 · add-ons 40 · flooring 53 · pricing 107 · scope 71 · proposal 59 ·
rate-limit 24 · HTTP 58. Pricing tests exercise pack normalization, bands, the circuit breaker, the
cache (+ TTL), the total-time budget, and the 200-with-error path against injected transports (no network).

---

## 15. Known limitations / open items

- **Pricing depends on a single scraper (SerpApi).** It has had outages (55–90s hangs). Mitigated by cache
  + breaker + budget; a second provider behind the seam (BigBox/RapidAPI) would add real redundancy.
- **LLM extraction not wired to a live key** — the heuristic covers BuildSuite's format; arbitrary
  proposals want the LLM (needs the ownership/key decision).
- **`order_discount`** — seam documented, not applied.
- **New room types** from the huddle (drywall-only, bedroom, living room) — small builders, not yet added.
- **Stateless + public** (rate-limited only) — no auth/persistence yet (needed before billing).
- **Made-to-measure lines are rough** (cabinets per LF, slabs per sqft; `field_estimate:true`) — budget
  only, field-verify.

_Companion docs: `MATERIAL_TAKEOFF_v2.md` (narrative changelog), `material-takeoff/API_GUIDE.md`
(full request/response examples), and the dated `Material_Takeoff_*_for_Sing.md` handoffs._
