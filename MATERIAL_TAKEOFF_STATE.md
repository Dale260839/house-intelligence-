# Material Takeoff — Current State (session context)

_A load-me-first context file for a Claude chat session picking up the Material Takeoff work._
**Last updated: 2026-07-30.** Repo: `c:\Users\John\ProgrammingProjects\house-intelligence-`
(GitHub `Dale260839/house-intelligence-`, branch `main`; Railway auto-deploys `main`).

---

## TL;DR — where things stand

- **v2 is built, tested, and LIVE in production.** Three endpoints, three project types, live pricing,
  proposal extraction, and a print-ready export. **524 tests, 0 failing.**
- **BuildSuite (Sing) has the API integrated into the frontend** — the takeoff panel is live on the
  proposal page and running end-to-end. His side is essentially done.
- **No blockers.** The old BigBox "preparing zipcode" blocker is gone — pricing moved to **SerpApi**
  (search-term matched, no per-zipcode provisioning).
- **Most recent work:** the v2 build (multi-section + proposal + extraction + HTML export) followed by
  a round of fixes from Sing's real-proposal integration testing (pack/case pricing, Scope-of-Work
  parsing, heading denylist). All shipped.
- **Open decision (not code):** who owns/pays for the LLM extraction (see §8). Everything else has a
  clear next step in §9.

---

## 1. What it is

`material-takeoff/` — sibling of House Intelligence in the same repo, a **separate Railway service**,
zero runtime dependencies (Node core only), deterministic engine with provider seams for anything
external (pricing, proposal extraction).

Give it a renovation scope + size → an **order-ready material list** (quantities with waste baked in +
auditable math) + a rough-in checklist, with **opt-in live pricing + a profit layout**.

**Three ways in:**

| Endpoint | Input | `source_type` | For |
|---|---|---|---|
| `POST /material-takeoff` | one `{ projectType, ...inputs }` | `manual` | a single room (unchanged from v1) |
| `POST /material-takeoff/from-scope` | `{ sections:[…] }` | `scope` | a whole job in one call → merged, `project_type:"composite"` when >1 |
| `POST /material-takeoff/from-proposal` | `{ proposal_markdown }` | `proposal` | free-text proposal → extracted scope → takeoff, with provenance |

All accept opt-in pricing (`price=true` + `tier`/`markupPct`/`laborPct`/`laborCost`) and render formats
`format=text` and `format=html` (print-ready → save as PDF). Also `GET /material-takeoff/project-types`
(form contract), `GET /demo`, `GET /health`.

**Project types:** `kitchen_remodel`, `bathroom_remodel`, `flooring_only`.
**Add-ons (per section):** `demolition`, `subfloor`, `paint`, `trim`, `hardware`, `site_protection`.

**Prod URL:** `https://house-intelligence-production-f7f6.up.railway.app`
(House Intelligence is a *separate* service at `https://house-intelligence-production.up.railway.app`.)

---

## 2. Architecture / files (`material-takeoff/`)

| File | Role |
|---|---|
| `material_dataset.json` | Quantity rates/waste + geometry + the `pricing` block (tiers, per-line HD search terms, defaults). Add a project type = a block here + a builder. |
| `takeoff_engine.js` | Single-type dispatcher; validates inputs, stamps `source_type` + per-line `section_id`. Deterministic, sync. |
| `builders/*.js` | Per-type quantity derivation (`kitchen_remodel`, `bathroom_remodel`, `flooring_only`) + shared `addons.js` (incl. area-derived `site_protection`). |
| `line_builders.js` | Shared line constructors: made-to-measure / waste-factor / coverage / pack_round / `passthroughLine` (long-tail items). |
| `scope_engine.js` | `buildScopeTakeoff` (merge sections) + `buildProposalTakeoff` (extract → scope). add_ons[]→toggle mapping, section-id gen. |
| `pricing_engine.js` | `priceTakeoff` (single) + `priceScopeTakeoff` (multi) + budget fallback + `PRICE_BANDS` (per-line sanity bands). One labor line + one profit layout. Lookups concurrent (cap 5). |
| `pricing_provider.js` | Live SerpApi/BigBox provider over a zero-dep https shim + `mock` + `selectPricingProvider(env)`. `extractProduct` (pallet outlier + swatch floor guards) + `normalizePackPrice` (case/pack → per-unit). |
| `extraction_provider.js` | Proposal → scope. **Heuristic** (deterministic: Scope-of-Work parsing, denylist, remove/reinstall, confidence) + **LLM seam** (temp 0, structured, cached by proposal hash) + `selectExtractionProvider(env)`. |
| `pdf_export.js` | Zero-dep print-ready HTML render (`format=html`). |
| `server.js` | Node-core HTTP API; the routes above; CORS; rate limiter; opt-in `price=true` (async). |
| `rate_limiter.js` | Per-client-IP fixed window (default 120/60s), 429 + Retry-After + X-RateLimit-* headers, `/health` exempt. |
| `test_*.js` | engine 59 · bathroom 46 · room-shape 19 · pack-size 23 · add-ons 40 · flooring 53 · pricing 89 · scope 63 · proposal 50 · rate-limit 24 · HTTP 58 = **524**. |

---

## 3. Pricing model (opt-in, `price=true`)

Live prices from **SerpApi's Home Depot engine** via `HOMEDEPOT_API_KEY` (no baked catalog — live only;
no key → `pricing.ok:false, reason:"pricing_unavailable"` while quantities still return). Per line:

1. Search term per quality tier (good/better/best) → `provider.lookup`.
2. **Pack/case normalization** — HD lists flooring by the case, trim by the pack, with the size in the
   title (`(23.95 sqft/case)`, `(5-Pack — 80 Total Linear Feet)`). `normalizePackPrice` divides to the
   line's unit before costing (fixes 5×–25× over-pricing).
3. **Guards:** reject pallet/bulk outliers (median×12), reject sample swatches (per-line floor), and a
   **per-line sanity band** (`PRICE_BANDS`, dataset `min/max_unit_price` overrides) — anything still
   out of range is a unit mismatch → dropped to `unpriced_lines`, never a wrong number.
4. **Budget fallback:** an unmatched line, when the section has a `budget_hint`/`budget_sections`, gets
   a budget-derived estimate tagged `price_source:"proposal_budget"` (tops up when budget ≥ priced).
5. `price_source` per line: `homedepot_live | mock | proposal_budget`.
6. Profit layout: materials + labor → total_cost → markup% → client price → profit + implied margin%.
   `order_discount` (volume tiers) is a **documented seam**, not yet applied.

---

## 4. Extraction model (`from-proposal`)

Behind `selectExtractionProvider(env)`:
- **No key → deterministic heuristic** (the default; always available). Parses `## Scope of Work` →
  `### N.` subsections as work areas, merges phase subsections into one job with their add-ons,
  denylists non-work headings (Executive Summary / Exclusions / Warranty / Permits / …), honours
  remove-and-reinstall (no new item), prefers stated quantities (`confidence: stated|inferred|assumed`).
- **`EXTRACTION_API_KEY` / `ANTHROPIC_API_KEY` set → LLM** (structured output, temp 0, cached by
  proposal hash). Handles arbitrary formats beyond the Scope-of-Work template.
- Response adds `extracted_scope { sections[], notes[] }`; sections carry `id`/`area_sqft`/
  `source_quote`/`confidence`; per-line `source_quote`/`confidence`. `no_scope_extracted` → `ok:false`
  at HTTP 200 (never a crash).

---

## 5. Config / env (material-takeoff service)

| Var | Purpose | Status |
|---|---|---|
| `HOMEDEPOT_API_KEY` | SerpApi key → live pricing. No key → `pricing_unavailable`. | ✅ Set in Railway (SerpApi). Rotate the key exposed earlier if not already done. |
| `HOMEDEPOT_API_URL` | Endpoint template (`{key}`/`{query}`). Default = SerpApi Home Depot engine. | Default (SerpApi) unless overridden. |
| `EXTRACTION_API_KEY` / `ANTHROPIC_API_KEY` | Turns on LLM proposal extraction. No key → deterministic heuristic. | Not set → heuristic (fine as default). |
| `EXTRACTION_MODEL` | LLM model id (default `claude-sonnet-5`). | Optional. |
| `PRICING_MOCK` | Dev/test only — deterministic fake prices. `0/false/no/off` = disabled. | Not set in prod (correct). |
| `RATE_LIMIT_MAX` / `_WINDOW_MS` / `_DISABLED` | Rate-limiter tuning. | Defaults (120/60s). |
| `PORT` | Railway injects. | ok |

---

## 6. Git / deploy state

- Branch `main`, **in sync with `origin/main`**. Railway auto-deploys the material-takeoff service.
- Latest relevant commits (pushed):
  - `6754af3` — Fix Sing's integration issues (pack-size pricing, Scope-of-Work extraction, denylist).
  - `587e492` — Material Takeoff v2 (from-scope + from-proposal, extraction seam, budget fallback,
    site protection, HTML export).
  - (earlier) v1 engine + pricing layer + bathroom/flooring/room-shape/pack-size/add-ons phases.
- **Uncommitted (docs only, no prod impact):** the EOD files and the Sing handoff
  (`Material_Takeoff_v2_Fixes_from_Dale.md`), plus this state file. Code + API guide + reference doc
  are committed. (House Intelligence code untouched.)

---

## 7. What BuildSuite (Sing) reported + we fixed (2026-07-29)

Real-proposal integration testing surfaced three issues; all fixed, response **shape unchanged**
(values corrected, fields additive):
1. **Pack/case pricing (blocker)** — case/pack prices read as per-unit → 5×–25× over. Fixed via
   `normalizePackPrice` + per-line sanity bands. Dumpster retuned off the consumer bag + floored (now
   honestly `unpriced` — HD doesn't rent 20-yd dumpsters; budget fallback covers it).
2. **Extraction captured one trade** — now parses `### N.` subsections under `## Scope of Work`.
3. **Every heading became a section** — non-work headings denylisted; only Scope-of-Work counts.
Plus: `extracted_scope` `id`/`area_sqft`/body-level `source_quote`/populated `notes`.

Sing can now **remove his `## Scope of Work` slicing workaround** and start sending the **cost
breakdown table** (feeds the budget fallback). Awaiting his re-test on real proposals.

---

## 8. Open decisions / known gotchas

- **Q1 — who owns the LLM extraction?** Heuristic covers BuildSuite's format; arbitrary proposals need
  the LLM (seam built, just needs the ownership call + a key). Single biggest strategic unblock.
- **Dumpster/rental → `unpriced`** by design (HD can't price it). Open call with Sing: keep it a
  "local quote" line or add a per-locality placeholder.
- **`order_discount`** — volume-pricing seam documented, not applied to the profit layout yet.
- **Made-to-measure lines are rough** (cabinets per LF, countertop/vanity-top per sqft, flagged
  `field_estimate:true`) — budget only, not a quote.
- **Labor default = 100% of materials** (flooring 60%) — placeholder; override per job.
- **Stateless + public** (rate-limited only) — no auth/persistence yet (needed before billing).

---

## 9. Next steps / phase options

1. **Support Sing's re-test** (reactive) — retune pack-title patterns / sanity bands as real proposals
   come back. Same-day.
2. **Expanded project types** (recommended next build) — drywall-only, bedroom, living room,
   whole-home-by-room. Deterministic, no external dependency; each is a small builder + dataset block
   and instantly works in `from-scope`/`from-proposal`. Requested in the huddle.
3. **Turn on LLM extraction** — pending the Q1 decision + a key.
4. **Productionization** — API-key auth, request logging, persistence (save takeoffs per project) —
   the gate before billing inside BuildSuite.
5. **Pricing polish** — apply `order_discount`, exact-SKU pinning, price caching/refresh.

---

## 10. Quick commands

```bash
cd material-takeoff
npm test                                                 # 524 tests
PRICING_MOCK=1 node smoke_pricing.js 200 better          # dry-run pricing (no key)

# prod — quantities (always), pricing (needs the SerpApi key on the server)
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&format=text"

# multi-section (from-scope)
curl -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff/from-scope \
  -H "Content-Type: application/json" \
  -d '{"sections":[{"label":"Kitchen","project_type":"kitchen_remodel","inputs":{"kitchenSqft":200}},{"label":"Bath","project_type":"bathroom_remodel","inputs":{"bathroomSqft":60}}],"price":true}'

# from a proposal
curl -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff/from-proposal \
  -H "Content-Type: application/json" \
  -d '{"proposal_markdown":"## Scope of Work\n### 1. Flooring Installation\n- install 1400 sqft of LVP\n","price":true}'
```
