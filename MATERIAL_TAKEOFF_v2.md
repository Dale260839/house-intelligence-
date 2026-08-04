# Material Takeoff — v2 Reference

_Supersedes the stale `EOD_MATERIAL_TAKEOFF_2026-07-11.md` context file. Written 2026-07-28; updated 2026-07-30 (BuildSuite integration fixes live in prod)._

The Material Takeoff service maps a renovation **scope + size** to an **order-ready material list**
(quantities with waste baked in), optional **live Home Depot pricing + a profit layout**, and now — in
v2 — **multi-section jobs**, **proposal-driven extraction**, and a **print-ready export**. It is a
deterministic, zero-runtime-dependency Node service (Node core only) with pluggable provider seams for
everything external (pricing, extraction).

---

## 1. The three ways in

| Endpoint | Input | `source_type` | Use it for |
|---|---|---|---|
| `POST /material-takeoff` | one `{ projectType, ...inputs }` | `manual` | a single room, form-driven. **Unchanged from v1.** |
| `POST /material-takeoff/from-scope` | `{ sections:[…] }` | `scope` | a whole job (kitchen + bath + floor) in one call → merged takeoff, `project_type:"composite"`. |
| `POST /material-takeoff/from-proposal` | `{ proposal_markdown }` | `proposal` | a free-text proposal → extracted scope → takeoff, with provenance. |

All three accept opt-in pricing (`price=true` + `tier/markupPct/laborPct/laborCost`) and the render
formats `format=text` and `format=html` (print-ready → save as PDF). Full request/response shapes live
in `material-takeoff/API_GUIDE.md` (§4c–§4f).

---

## 2. Architecture — "Hybrid C" (deterministic core + LLM at the edge)

```
 proposal_markdown ─▶ [extraction_provider]  ─┐   (LLM behind a seam, or a deterministic
                        (llm | heuristic)      │    heuristic fallback — cached by proposal hash)
                                               ▼
 sections[] ────────▶ [scope_engine] ─▶ [takeoff_engine] ─▶ per-type [builders/*] ─▶ materials[]
   (from-scope)          merge +            validate +          (deterministic,          (each line
                         stamp section_id   dispatch            zero-dep)                 .section_id)
                                               │
 price=true ─────────▶ [pricing_engine] ◀──────┘   per-line lookup via [pricing_provider]
                        one labor + one            (SerpApi live | mock); pack/case normalize,
                        profit + bands             outlier + swatch guards, per-line bands, budget fallback
                                               │
                                               ▼
                        JSON  |  format=text  |  format=html (print → PDF)
```

**The core stays deterministic.** The only fuzzy step — turning prose into a scope — is isolated
behind `extraction_provider.js`, exactly like pricing is isolated behind `pricing_provider.js`. That
is the whole point of Hybrid C: an LLM improves extraction without leaking non-determinism into the
quantity math or the tests.

**Files**

| File | Role |
|---|---|
| `takeoff_engine.js` | single-type dispatcher; validates inputs, stamps `source_type`/`section_id`. |
| `builders/*.js` | per-type quantity derivation (kitchen, bathroom, flooring) + shared `addons.js`. |
| `line_builders.js` | shared line constructors incl. `passthroughLine` (long-tail items). |
| `scope_engine.js` | `buildScopeTakeoff` (merge sections) + `buildProposalTakeoff` (extract → scope). |
| `pricing_engine.js` | `priceTakeoff` (single) + `priceScopeTakeoff` (multi) + budget fallback + `PRICE_BANDS` (per-line sanity bands). |
| `pricing_provider.js` | live (SerpApi) + mock; `normalizePackPrice` (case/pack → per-unit) + outlier (pallet) + floor (swatch) guards. |
| `extraction_provider.js` | LLM seam + deterministic heuristic (Scope-of-Work parsing + heading denylist) + proposal-hash cache. |
| `pdf_export.js` | zero-dep print-ready HTML render. |
| `server.js` | Node-core HTTP front door; routes, CORS, rate limiter. |

---

## 3. Project types & add-on catalog

**Project types (live):** `kitchen_remodel`, `bathroom_remodel`, `flooring_only`.
Discover inputs at runtime via `GET /material-takeoff/project-types`.

**Add-on groups** (booleans on the single endpoint; an `add_ons:[]` array per section on v2):

| add_on | Lines | Basis |
|---|---|---|
| `demolition` | `demolition_dumpster` | floor area × debris rate → dumpsters |
| `subfloor` | `subfloor` | floor area +10% → 4×8 panels |
| `paint` | `primer` + `paint` | wall area × coats ÷ 350 sqft/gal |
| `trim` | `baseboard` | perimeter − openings → 16 ft sticks |
| `hardware` | `cabinet_hardware` | cabinet/vanity LF × 0.9 |
| `site_protection` **(v2/U5)** | `floor_protection`, `plastic_sheeting`, `masking_tape`, `dust_barrier`, `hepa_filter` | **all area-derived** (floor area + openings) |

**Passthrough (v2/U5):** long-tail items a ruleset can't derive from geometry (pot filler, range hood)
become `type:"passthrough"`, `calculation:"estimated"` lines carrying their `source_quote`.

---

## 4. Pricing & fallback model

1. Each material line is priced against **its own project type's** search term at the chosen tier
   (a composite job mixes configs correctly).
2. **Pack/case normalization:** Home Depot lists flooring by the case, trim by the pack, tile by the
   box, with the size in the product title (`(23.95 sqft/case)`, `(5-Pack — 80 Total Linear Feet)`,
   `Case of N`). `normalizePackPrice` divides the listed price down to the line's unit *before* costing
   — otherwise a case price read as per-unit over-charges 5×–25×.
3. **Guards:** reject **pallet/bulk outliers** (> 12× the result-set median) and **sample swatches**
   (below a per-line floor). Plus a **per-line sanity band** (`PRICE_BANDS`, dataset
   `min/max_unit_price` overrides): a normalized price still outside the plausible range for that line
   key is a unit mismatch → the line drops to `unpriced_lines` rather than ship a wrong number.
4. **Reliability (Aug-1 + Aug-4 hardening):** transient lookups (network_error / timeout / rate-limit)
   are **retried** with backoff; a **circuit breaker** trips after N consecutive failures so a
   dead/slow provider fails the rest of the takeoff **fast** (→ budget fallback) instead of hanging
   10-15s per line. A **persistent price cache** (module-level, TTL default 24h, `sharedCache`) scrapes
   each of the small fixed set of search terms **once** and reuses it — instant + cheap on later
   takeoffs, and a cache warmed before a provider outage keeps serving prices **through** the outage.
   The block carries `priced_count`/`unpriced_count`, and `ok` flips to **false** (`reason:
   "pricing_degraded"`) when >25% of lines fail — one signal so consumers degrade cleanly. A budget
   (which fills unpriced lines) keeps `ok` true. Env knobs: `PRICING_TIMEOUT_MS`, `PRICING_MAX_RETRIES`,
   `PRICING_BREAKER_THRESHOLD`, `PRICE_CACHE_TTL_MS`.
5. **Budget fallback + UNITS (U3 + Aug-1 fix):** an unmatched line no longer silently drops from the
   total — the section's materials budget is spread across the unmatched lines, tagged
   `price_source:"proposal_budget"`. **`budget_total`/`budget_sections` are the CLIENT PRICE**, so they
   are multiplied by a **materials share** (default 0.35, override `materialsShare`) before seeding the
   materials-only fallback (otherwise a $15k bath → $36k). An explicit `materials_budget` and a
   from-scope per-section `budget_hint` are already MATERIALS figures and bypass the share. It *tops up* —
   fires when the materials budget ≥ live-priced materials; else the line stays `unpriced`.
6. **One labor line + one profit layout** over the merged scope. Totals reconcile:
   `materials + labor = total_cost`, `price = total_cost × (1+markup)`, `profit = price − total_cost`,
   `margin = profit/price`.
7. **`price_source`** per line: `homedepot_live` | `mock` | `proposal_budget`.
8. **`order_discount` seam** (documented, not yet applied): volume discounts slot between
   `materials_cost` and `total_cost` without moving other fields.

> `demolition_dumpster` returns **`unpriced`** with `reason:"not_retail_sku"` by design — Home Depot
> doesn't rent 20-yd dumpsters, so the line skips the live call entirely. Surface it as a "local quote"
> line, or let the budget fallback cover it.

---

## 5. Determinism guarantees

- The engine + builders are pure and synchronous — same inputs, same output, every time.
- Pricing and extraction are the only async/external steps and are both **seam + mock**; the whole
  test suite runs with no network and no keys.
- **Extraction is cached by proposal hash** (sha256): identical `proposal_markdown` → identical result
  (the LLM is called at temperature 0; the heuristic is pure). Re-running a proposal never re-bills or
  drifts.
- Nothing throws a request to the client: a bad price, an unmatched line, an extraction miss, or a bad
  section all **degrade** (`ok:false` / `unpriced_lines` / budget fallback), never crash.

---

## 6. Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| A1 | Existing `POST /material-takeoff` unchanged (additive fields only) | ✅ MET — 59 engine + 37→58 HTTP tests green |
| A2 | Engine deterministic; suite runs with no network/keys | ✅ MET |
| A3 | `from-scope` accepts `sections[]`, runs per-type builder, merges, stamps `section_id`, `composite` when >1 | ✅ MET (U1) |
| A4 | `source_type` on all responses; `section_id` on every line | ✅ MET (U2) |
| A5 | Budget-derived fallback; per-line `price_source`; totals reconcile | ✅ MET (U3) |
| A6 | Countertop/vanity-top swatch guard (`min_unit_price`) | ✅ MET (U4) |
| A7 | `site_protection` add-on, area-derived; passthrough for long-tail | ✅ MET (U5) |
| A8 | `extracted_scope{sections,notes}` + per-line `source_quote`/`confidence` | ✅ MET (U6) |
| A9 | `from-proposal` + LLM seam (temp 0, structured, **cached by hash**); heuristic fallback | ✅ MET (U7) |
| A10 | Remove+reinstall → no new item; prefer stated qty (confidence) | ✅ MET (U7) |
| A11 | `no_scope_extracted` → `ok:false`, HTTP 200, no crash | ✅ MET (U7) |
| A12 | Bad price / failed extraction never crashes a request | ✅ MET |
| A13 | PDF export path | ✅ MET as **`format=html`** print-ready export (U8). Server-side binary PDF intentionally **not** built (would break zero-dep). |
| A14 | Pack/case-size price normalization — no 5×–25× unit-mismatch errors | ✅ MET (Sing fix) |
| A15 | Per-line sanity bands — an out-of-band price drops to `unpriced_lines`, never a wrong number | ✅ MET (Sing fix) |
| A16 | `## Scope of Work` → `### N.` subsections parsed as sections; non-work headings denylisted | ✅ MET (Sing fix) |
| A17 | JSON response shape unchanged across the fixes (values corrected, fields additive) | ✅ MET — verified by key diff |

**Test count: 553 passing, 0 failing** (`npm test`).

---

## 7. CHANGELOG (U1–U8)

- **U1** — `POST /from-scope`: multi-section aggregator (`scope_engine.js`), `project_type:"composite"`.
- **U2** — `source_type` (manual/scope/proposal) + per-line `section_id` everywhere.
- **U3** — budget-derived fallback + per-line `price_source`; totals reconcile.
- **U4** — `min_unit_price` swatch floor + retuned countertop/vanity-top search terms.
- **U5** — `site_protection` add-on group (area-derived) + `passthroughLine` for long-tail items.
- **U6** — `extracted_scope` schema + per-line `source_quote`/`confidence` fields.
- **U7** — `POST /from-proposal` + `extraction_provider.js` (LLM seam + heuristic + hash cache);
  remove/reinstall + stated-over-inferred handling; `no_scope_extracted` → 200.
- **U8** — `format=html` print-ready export (`pdf_export.js`), zero-dependency.
- **Integration fixes (Sing, 2026-07-29)** — (1) **pack/case-size price normalization** + per-line
  sanity bands: parses "(23.95 sqft/case)", "(5-Pack — 80 Total Linear Feet)", "Case of N" etc. out of
  the product title and divides to the line's unit, fixing 5×–25× over-pricing on flooring/trim; the
  dumpster consumer-bag mismatch is floored out. (2) **`## Scope of Work` → `### N.` subsections** are
  parsed as sections (phase subsections merge into one job with their add-ons). (3) **Non-work headings**
  (Executive Summary, Exclusions, Warranty, Permits, …) are denylisted so they never become takeoffs.
  (4) `extracted_scope` `id` / `area_sqft` / `source_quote` (a body sentence) / `notes` are populated.
  **JSON response shape unchanged** — values corrected, fields added additively.
- **Pricing-stability + budget-unit fixes (Sing, 2026-08-01)** — (1) **lookup retry** with backoff for
  transient SerpApi failures (fixes the non-deterministic total); `priced_count`/`unpriced_count` added
  and `pricing.ok` flips false (`pricing_degraded`) past a 25% failure share. (2) **Budget-fallback
  units**: `budget_total`/`budget_sections` treated as CLIENT PRICE × `materialsShare` (0.35 default);
  explicit `materials_budget` bypasses the share (fixes the $15k → $36k bug). (3) **Merged section
  label** by resolved trade, not the first subsection. (4) `demolition_dumpster` → `not_retail_sku`.
  (5) Bathroom assumed-area default 100 → 50 sqft + response-level `assumptions[]`. (6) `- **Title**:
  body` bullets accepted as SOW subsections; a weak "floor tile" phase folds into the dominant room
  (no more spurious flooring split). Response shape still additive-only.
- **Provider-outage hardening (2026-08-04)** — a **circuit breaker** (fail fast when the live provider
  is down/slow, → budget fallback, instead of hanging every line) and a **persistent price cache**
  (scrape each fixed search term once, reuse across requests + survive outages, and cut credit burn).
  Both are invisible to the response shape. Prompted by a SerpApi Home Depot engine outage where every
  search took 55-90s vs our per-lookup timeout — an upstream provider issue, not our code.

---

## 8. Outstanding / decisions

- **Q1 — who owns the LLM?** Extraction ships with a deterministic heuristic default; the real LLM path
  is wired behind the seam but needs a key + the ownership decision (BuildSuite vs this service). This
  is the single gating call for full proposal fidelity. See `MATERIAL_TAKEOFF_V2_GAP_ANALYSIS.md`.
- **`order_discount`** — seam documented, not yet applied to the profit layout.
- **Dumpster / rental pricing** — returns `unpriced` by design (not an HD SKU). Open call with Sing:
  keep it a "local quote" line, or add a per-locality placeholder.
- **Heuristic multi-section** now parses `## Scope of Work` → `### N.` subsections (BuildSuite's
  format) and denylists non-work headings; a heading-less blob that mixes trades still captures only the
  top-priority one (the LLM handles arbitrary formats — the Q1 decision above).
- **New room types** from the huddle (drywall-only, bedroom, living room) — each is a small new builder
  + dataset block; the composite aggregator already handles them once added.
- **Deployed** — v2 endpoints **and** the 2026-07-29 integration fixes are LIVE in production (pushed to
  `main`, auto-deployed). BuildSuite is integrated (panel live on the proposal page) and re-testing real
  proposals; Sing can now drop his `## Scope of Work` slicing workaround and send the cost-breakdown
  table (feeds the budget fallback).
