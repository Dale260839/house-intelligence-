# Material Takeoff — Knowledge Base (Production)

_Single source of truth for the Material Takeoff service. **Local and production are in sync** —
everything below is live._ **Last updated: 2026-07-16.**
Repo: `github.com/Dale260839/house-intelligence-` · branch `main` · dir `material-takeoff/`
**Prod base URL:** `https://house-intelligence-production-f7f6.up.railway.app`

---

## 1. What it is

Turns a remodel's size + measurements into an **order-ready material list** — quantities with waste
factors baked in and auditable math (`raw → waste/coverage → order`) — plus a plumbing/electrical
rough-in checklist. Optional `price=true` adds **live Home Depot pricing** per line at a quality tier
and a **profit layout** (materials + labor → cost → markup → client price → profit + margin).

Zero runtime dependencies (Node core). Sibling of House Intelligence (separate Railway service, same
repo). Called server-to-server by BuildSuite. **US-only.**

---

## 2. Production status — ALL GREEN ✅ (verified 2026-07-16)

| Capability | Status | Detail |
|---|---|---|
| **Quantities** | ✅ Live | Both project types, stable |
| **Project types** | ✅ **2 live** | `kitchen_remodel`, `bathroom_remodel` |
| **Room-shape accuracy** | ✅ Live | `roomShape` shape-aware perimeter |
| **Pack-size rounding** | ✅ Live | tile → boxes, countertop/vanity top → slabs |
| **Live pricing** | ✅ **Live via SerpApi** | Verified 11/11 lines priced with real HD products |
| **Rate limiting** | ✅ Live | 120 req / 60s per client IP |
| **Add-on groups** (Phase 4) | ✅ **Live** | demolition, subfloor, paint, trim, hardware — verified in prod (17-line kitchen) |
| Auth / persistence | ❌ Not yet | Roadmap Phase 7 (before billing) |

**Verified live in prod (2026-07-16):** `project-types` → 2 types · kitchen 200 sqft → 11 lines ·
all 5 add-ons on → **17 lines** · `floorTileBoxSqft=15.5` → `pack_round` **14 box** ·
`roomShape=galley` → 65.1 LF perimeter / 18 sheets · priced 11/11 via SerpApi · 429 + `X-RateLimit-*`
headers present.

### Uncommitted local files
| File | What it is |
|---|---|
| `material-takeoff/buildsuite-demo.html` | Single-file BuildSuite integration demo (see §11). Not pushed. |

Everything else is committed and pushed — `main` is in sync with `origin/main`
(latest: `ec30e3e` Phase 4 add-on line groups).

---

## 3. Endpoints

| Method & path | Purpose |
|---|---|
| `GET /material-takeoff/project-types` | Supported types + input form contract (render a form dynamically). |
| `POST /material-takeoff` | Main call: `{ projectType, <size>, ...optional }` → full takeoff. |
| `GET /material-takeoff?projectType=…&…` | Same, query-driven. |
| `GET /health` (rate-limit exempt) · `GET /` | Liveness · API index (reports `pricing_enabled`, `rate_limit`). |

Add `format=text` for a rendered block. Add `price=true` (+ `tier`, `markupPct`, `laborPct`/`laborCost`)
for pricing. Full contract: `material-takeoff/API_GUIDE.md`.

---

## 4. Project types

### 4.1 `kitchen_remodel`
- **Required:** `kitchenSqft`.
- **Optional:** `ceilingHeight`, `cabinetLF`, `baseCabinetLF`, `upperCabinetLF`, `countertopSqft`,
  `countertopType`, `tileLayout`, `floorTile`, `backsplashHeight`, `openings`, `wallPerimeterLF`,
  `includeCeiling`, `roomShape`, `floorTileLayout`, `backsplashTileLayout`, `floorTileBoxSqft`,
  `backsplashTileBoxSqft`, `countertopSlabSqft`.
- **11 lines:** base/upper cabinets, countertop, backsplash + floor tile, thinset, grout, drywall
  sheets, joint compound, tape, screws. **13-item rough-in checklist.**

### 4.2 `bathroom_remodel` (configurable, default-full)
- **Required:** `bathroomSqft`.
- **Optional:** `ceilingHeight`, `showerType` (`tub_shower`/`shower`/`tub`/`none`), `showerWallSqft`,
  `tileLayout`, `wainscotHeight`, `vanityLF`, `vanityTopType`, `floorTile`, `includeVanity`,
  `includeWaterproofing`, `openings`, `includeCeiling`, `wallPerimeterLF`, `roomShape`,
  `floorTileLayout`, `wallTileLayout`, `floorTileBoxSqft`, `wallTileBoxSqft`, `vanityTopSlabSqft`.
- **12 lines:** floor tile, wall tile (shower/tub surround + wainscot), thinset, grout,
  waterproofing membrane, cement backer board, drywall sheets, joint compound, tape, screws,
  vanity, vanity top. **13-item rough-in checklist** (toilet, vanity + faucet, supplies, shutoffs,
  P-trap, shower/tub valve + trim, tub/shower base, waste/vent; 20A circuit, GFCI, exhaust fan,
  vanity lighting, Romex).
- **Scope toggles (all on by default):** `showerType:"none"` drops surround tile + waterproofing +
  backer board; `includeVanity:false`; `includeWaterproofing:false`; `floorTile:false`.

---

## 5. Material line types

| `type` | Applies to | Order math |
|---|---|---|
| `made_to_measure` | Cabinets, vanity | `order = raw` (no waste); `field_verify: true` |
| `waste_factor` | Countertop, tile, drywall (sqft) | `order = raw × (1 + waste%)` |
| `coverage` | Thinset, grout, compound, tape, screws, membrane | `order = ceil(raw ÷ coverage)` whole units |
| `pack_round` | Tile w/ box size; countertop/vanity top w/ slab size | `order = ceil(raw×(1+waste) ÷ pack_size)` in whole **boxes/slabs**; reports `covered_qty` + `pack_size`. **Priced per pack.** |

Every line carries `raw`, `order_qty`/`order_unit`, `basis` (plain-English math), and `field_verify`.

---

## 6. Accuracy features

**Room shape** — `perimeter = factor × √area` (exact `wallPerimeterLF` always overrides):

| shape | factor | | shape | factor |
|---|---|---|---|---|
| `square` *(default)* | 4.0 | | `l_shaped` | 4.8 |
| `rectangular` | 4.1 | | `u_shaped` | 5.2 |
| `galley` | 4.6 | | `island` *(kitchen)* | 4.1 + **15% cabinet run** |

**Pack sizes** — give the vendor pack size and tile/slab lines round to whole boxes/slabs **and price
per box/slab** (this is what fixes the per-case tile pricing over-count).
**Per-surface tile layouts** — floor vs backsplash/wall can differ; grout drops to small-tile coverage
if either is `mosaic`.

**Add-on groups (Phase 4)** — five optional scope groups on both types, each **off by default**:

| Toggle | Adds | Derivation |
|---|---|---|
| `includeDemolition` | `demolition_dumpster` | floor area × debris rate (kitchen 0.08 / bathroom 0.12 cu yd per sqft) → dumpsters |
| `includeSubfloor` | `subfloor` | floor area +10% → 4×8 panels |
| `includePaint` | `primer` + `paint` | drywall surface × coats ÷ 350 sqft/gal (bathroom: dry walls only); `paintCoats` default 2 |
| `includeTrim` | `baseboard` | perimeter − 3 ft/opening, +10% → 16 ft sticks |
| `includeHardware` | `cabinet_hardware` | cabinet LF (kitchen) / vanity LF (bathroom) × 0.9 pulls per LF |

*All accuracy + add-on features are optional and default to the original behavior — fully backward compatible.*

---

## 7. Pricing

- **Provider: SerpApi Home Depot engine** (`engine=home_depot`) — **live in prod and working.**
  Config: `HOMEDEPOT_API_KEY` = SerpApi key, and **no `HOMEDEPOT_API_URL`** (code defaults to SerpApi).
  `HOMEDEPOT_API_URL` exists only for other providers (`{key}`/`{query}` placeholders).
- **BigBox retired** — multi-day platform-wide outage (their own demo key 503'd). Not our code.
- `product_url` normalized to public `www.homedepot.com/p/...` links.
- Response: `pricing.{ ok, source, tier, lines[], unpriced_lines[], fully_priced, labor, profit_layout }`.
  Quantities and pricing are **independent** — a pricing failure never fails the request; render the
  pricing block only when `pricing.ok`.
- **Cost:** ~1 lookup per material line (~11–12 per takeoff), run at concurrency 5.
- **Remaining caveats:** without a pack size, tile prices per-sqft against a per-box price (over-counts
  — pass `*TileBoxSqft` to fix); countertop search can match a sample swatch; a few dataset labels have
  an em-dash encoding artifact (cosmetic).

---

## 8. Rate limiting

Per-client-IP, in-memory fixed window. **120 req / 60s** (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_DISABLED`). Over → **429** + `Retry-After`; all responses carry `X-RateLimit-Limit`/
`-Remaining`/`-Reset`. `/health` exempt. Proxy-aware (`X-Forwarded-For`). **Caveat:** in-memory per
process — a multi-instance deploy multiplies the effective limit (move to Redis when scaling out).

---

## 9. Architecture & files

`buildTakeoff()` is a thin **dispatcher**; each project type is a pluggable builder:

```
takeoff_engine.js     validate → resolveInputs → BUILDERS[type].build() → response envelope
line_builders.js      shared: madeToMeasureLine, wasteFactorLine (incl. pack), coverageLine,
                      buildFixtures (generic qty_per_* scaling)
builders/kitchen_remodel.js · builders/bathroom_remodel.js
material_dataset.json both project blocks (inputs/geometry/rates/fixtures/pricing) + _meta
pricing_provider.js   SerpApi/BigBox provider + mock + env selector
pricing_engine.js     priceTakeoff (tiers, labor, markup+margin), concurrency-capped
rate_limiter.js · server.js · smoke_pricing.js
```
**Adding a 3rd type = one dataset block + one `builders/<type>.js` + tests.** No engine rewrite.

`builders/addons.js` holds the five shared add-on groups, so any new project type gets them for free.

**Tests — 298 passing** (`npm test`): 59 engine + 46 bathroom + 19 room-shape + 23 pack-size +
29 add-ons + 61 pricing + 24 rate-limit + 37 server.

**Recent commits:** `f9981e5` KBs · `fed4e87` Phases 0–3 (builders, bathroom, room shapes, pack sizes)
· `ddd09ed` docs · `fe380b8` rate limiting · `ab947b7` parallel pricing · `cb73d62` pricing layer.

---

## 10. Roadmap (remaining)

Detail + estimates in `MATERIAL_TAKEOFF_PLAN.md`. **Done & deployed:** Phase 0 (pluggable builders),
1 (bathroom type), 2 (room shapes), 3 (pack sizes + per-surface tile), **4 (add-on groups)**.

| Phase | Item | Effort |
|---|---|---|
| **5** | `flooring_only` project type | 2 d |
| **6** | Drywall scope modes (full / patch / none) | 1 d |
| **7** | **Auth + persistence** (rate limiting ✅ done) — required before billing | 3–5 d |
| **8** | Region/era-aware rough-in (tie into House Intelligence) | 2–3 d |
| **9** | Whole-home / multi-room scoping | 4–6 d |

**Suggested next:** Phase 7 (auth + persistence) if billing is near; otherwise Phase 4 or 5 for breadth.
Quick wins: tune the countertop search term, fix the em-dash labels.

---

## 11. BuildSuite integration demo (`material-takeoff/buildsuite-demo.html`)

A **single self-contained HTML file** (no server, no build, no dependencies) demonstrating the
intended BuildSuite integration. Open it directly in a browser — it points at prod by default and
works from the filesystem because CORS is `*`.

What it shows a frontend dev:
1. **The form is generated from the API**, not hardcoded — it calls `GET /material-takeoff/project-types`
   and renders every field from the contract (type → input/checkbox/select, defaults, units, min,
   allowed values, descriptions as tooltips), auto-grouped into *Project basics* / *Accuracy & vendor
   packs* / *Optional scope (add-ons)*. **Add a project type or input server-side and the UI picks it
   up with zero frontend changes.**
2. **Contractor-facing output** — summary, KPI tiles from `derived`, the material order list with each
   line's auditable `basis`, and badges for `field-verify`, `pack` (box/slab), and `add-on`.
3. **The profit layout** — materials → labor → cost → markup → client price → profit + margin,
   rendered **only when `pricing.ok`**, with a graceful "pricing unavailable" banner otherwise
   (quantities and pricing are independent).
4. **Real-world handling** — loading state for the slow live-pricing call, a **429** branch that reads
   `Retry-After`, per-line `n/a` for unpriced lines, the disclaimer, and a raw-JSON drawer.

Point the API base field at `http://localhost:3100` to run it against a local server.
⚠️ Ticking live pricing spends ~11–17 SerpApi credits per run — go easy during demos.

---

## 12. Quick commands

```bash
cd material-takeoff && npm test                       # 269 tests
node takeoff_engine.js 200                            # kitchen CLI demo
PRICING_MOCK=1 node smoke_pricing.js 200 better       # pricing dry-run (no key)
HOMEDEPOT_API_KEY=<serpapi> node smoke_pricing.js     # live pricing verification
```
```bash
# prod
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff/project-types"
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=bathroom_remodel&bathroomSqft=60&format=text"
curl "https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&format=text"
```
