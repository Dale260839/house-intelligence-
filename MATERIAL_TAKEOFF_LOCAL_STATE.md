# Material Takeoff — LOCAL Working-Tree State

_Snapshot of the **local working copy**, which is **ahead of production/GitHub**. Everything in §2
(bathroom type, engine refactor, product links, room shapes) is **implemented + tested locally but
NOT committed/pushed/deployed yet.**_ **Last updated: 2026-07-16.**
Repo: `github.com/Dale260839/house-intelligence-` · branch `main` · dir `material-takeoff/`

---

## 0. ⚠️ Local vs. Production — the delta

`main` is in sync with `origin/main` **on commits**, but the working tree has **substantial
uncommitted work**. So GitHub/Railway (prod) is BEHIND this local copy.

| Capability | Prod / GitHub | **Local (this tree)** |
|---|---|---|
| `kitchen_remodel` quantities | ✅ live | ✅ (unchanged behavior) |
| Rate limiting | ✅ live (`fe380b8`) | ✅ |
| Pricing layer (SerpApi-ready) | ✅ deployed | ✅ + **product links normalized** |
| **Engine = pluggable builders** (Phase 0) | ❌ monolithic | ✅ **refactored** |
| **`bathroom_remodel` type** (Phase 1) | ❌ | ✅ **added** |
| **`roomShape` accuracy** (Phase 2) | ❌ | ✅ **added** |
| Tests | 178 | **246** |

**Nothing in Phases 0–2 is deployed** — a `POST /material-takeoff` to prod still 400s on
`projectType:"bathroom_remodel"` and ignores `roomShape`. To ship: commit + push (see §9).

---

## 1. What it is

Turns a remodel's size + measurements into an **order-ready material list** (quantities with waste
factors baked in, auditable `raw → waste/coverage → order` math) + a plumbing/electrical rough-in
checklist. Optional `price=true` adds tiered **live Home Depot pricing** + a **profit layout**.
Zero-dependency Node core. Prod base URL: `https://house-intelligence-production-f7f6.up.railway.app`.

---

## 2. Supported project types (LOCAL: two)

`_meta.supported_project_types = ["kitchen_remodel", "bathroom_remodel"]`

### 2.1 `kitchen_remodel` (unchanged behavior)
- **Required:** `kitchenSqft`. **Optional:** `ceilingHeight`, `cabinetLF`, `baseCabinetLF`,
  `upperCabinetLF`, `countertopSqft`, `countertopType`, `tileLayout`, `floorTile`, `backsplashHeight`,
  `openings`, `wallPerimeterLF`, `includeCeiling`, **`roomShape`** (new).
- **11 material lines:** base/upper cabinets, countertop, backsplash + floor tile, thinset, grout,
  drywall sheets, joint compound, tape, screws. **13-item rough-in checklist.**

### 2.2 `bathroom_remodel` (NEW — Phase 1, configurable/default-full)
- **Required:** `bathroomSqft`. **Optional:** `ceilingHeight`, `showerType`
  (`tub_shower`/`shower`/`tub`/`none`), `showerWallSqft`, `tileLayout`, `wainscotHeight`, `vanityLF`,
  `vanityTopType`, `floorTile`, **`includeVanity`**, **`includeWaterproofing`**, `openings`,
  `includeCeiling`, `wallPerimeterLF`, **`roomShape`**.
- **Configurable, default-full:** all line groups on by default; toggle off via `showerType:"none"`
  (drops shower wall tile / waterproofing / backer board), `includeVanity:false`,
  `includeWaterproofing:false`, `floorTile:false`.
- **12 material lines:** `floor_tile`, `wall_tile` (shower/tub surround + wainscot), `thinset`,
  `grout`, `waterproofing_membrane`, `cement_backer_board`, `drywall_sheets`, `joint_compound`,
  `drywall_tape`, `drywall_screws`, `vanity` (made-to-measure), `vanity_top`.
- **`derived`:** `wall_perimeter_lf`, `total_wall_area_sqft`, `dry_wall_area_sqft`, `shower_wall_sqft`,
  `wall_tile_sqft`, `floor_tile_sqft`, `tiled_substrate_sqft`, `waterproofing_sqft`, `vanity_lf`.
- **Rough-in checklist (13):** plumbing — toilet, vanity sink + faucet, supply lines, angle-stop
  shutoffs, P-trap, shower/tub valve + trim, tub/shower base + drain, waste/vent; electrical —
  bathroom branch circuit (20A), GFCI receptacle, exhaust fan (+ vent), vanity lighting, Romex.

---

## 3. Architecture (Phase 0 refactor — LOCAL)

`buildTakeoff()` is now a **thin dispatcher**; each project type is a pluggable builder:

```
takeoff_engine.js      validate projectType → resolveInputs → dispatch to BUILDERS[type] → wrap envelope
line_builders.js       shared helpers: round1, ceil, isPosNum, madeToMeasureLine,
                        wasteFactorLine, coverageLine, buildFixtures (generic qty_per_* scaling)
builders/
  kitchen_remodel.js    kitchen quantity derivation → { derived, materials, fixtures_checklist,
  bathroom_remodel.js   field_verify_items, summary }
```
**Adding a 3rd type = one dataset block + one `builders/<type>.js` + tests.** No engine rewrite.
`resolveInputs` (validation) and `getProjectTypes` (dynamic form contract) already handle any type.

---

## 4. Phase 2 — `roomShape` (measurement accuracy, both types)

Wall perimeter is now **shape-aware**: `perimeter = factor[roomShape] × √area` (was always `4·√area`).

| shape | factor | notes |
|---|---|---|
| `square` *(default)* | 4.0 | = the original model → **no regression** |
| `rectangular` | 4.1 | |
| `galley` | 4.6 | |
| `l_shaped` | 4.8 | |
| `u_shaped` | 5.2 | |
| `island` *(kitchen only)* | 4.1 | also **+15% cabinet/counter run** (`island_cabinet_factor`) |

- Defaults to `square` → existing quantities unchanged. `wallPerimeterLF` (exact) **always overrides**
  `roomShape`. Factors live in each type's `geometry.perimeter_factor_by_shape` (data-driven).

---

## 5. Pricing (LOCAL)

- Opt-in `price=true` + `tier` (good/better/best) + `markupPct` + `laborPct`/`laborCost`.
- **Provider: SerpApi Home Depot engine** (`engine=home_depot`). Verified working end-to-end.
  Config: set `HOMEDEPOT_API_KEY` = SerpApi key and **remove `HOMEDEPOT_API_URL`** (code defaults to
  SerpApi). BigBox retired (multi-day platform outage — even their demo key 503s).
- **Local addition:** `product_url` is normalized to public `www.homedepot.com/p/...` links (SerpApi
  returns `apionline.homedepot.com`).
- Bathroom lines have their own `pricing.lines` search terms + mock prices (mock covers both types).
- Response: `pricing.{ ok, source, tier, lines[], unpriced_lines[], fully_priced, labor, profit_layout }`.
- **Known data-quality caveats (unchanged):** tile priced per-case not per-sqft (inflates tile);
  countertop can match a sample swatch. Consumables price accurately. (Roadmap Phase 3 fixes tile.)

---

## 6. Rate limiting (already in prod + local)

Per-client-IP, in-memory, **120 req/60s** (env: `RATE_LIMIT_MAX`/`_WINDOW_MS`/`_DISABLED`). Over →
**429** + `Retry-After` + `X-RateLimit-*` headers. `/health` exempt. Proxy-aware (X-Forwarded-For).

---

## 7. File structure (`material-takeoff/`)

| File | Role | State |
|---|---|---|
| `takeoff_engine.js` | Dispatcher + `resolveInputs` + `getProjectTypes` + `renderTakeoffText` + CLI | **modified** |
| `line_builders.js` | Shared line-item helpers + generic `buildFixtures` | **new** |
| `builders/kitchen_remodel.js` | Kitchen derivation | **new** |
| `builders/bathroom_remodel.js` | Bathroom derivation | **new** |
| `material_dataset.json` | Both project blocks (inputs/geometry/rates/fixtures/pricing) + `_meta` | **modified** |
| `pricing_provider.js` | SerpApi/BigBox provider + mock + selector; product-URL normalize | **modified** |
| `pricing_engine.js` | `priceTakeoff` (tiers, labor, markup+margin), concurrency-capped | **modified** |
| `rate_limiter.js` · `server.js` | Rate limiter · HTTP API (opt-in `price=true`, async) | committed |
| `smoke_pricing.js` | Live pricing verification tool | committed |
| `test_engine.js` (59) · `test_bathroom.js` (46) · `test_room_shape.js` (19) · `test_pricing.js` (61) · `test_rate_limit.js` (24) · `test_server.js` (37) | Tests | mix new/modified |

---

## 8. Tests — **246 passing** (`npm test`)

`59 engine + 46 bathroom + 19 room-shape + 61 pricing + 24 rate-limit + 37 server = 246`. All green.

---

## 9. Uncommitted local changes (to ship, commit + push these)

**Modified:** `takeoff_engine.js`, `material_dataset.json`, `pricing_provider.js`, `pricing_engine.js`,
`package.json`, `test_engine.js`, `test_pricing.js`, `API_GUIDE.md`.
**New:** `line_builders.js`, `builders/` (kitchen + bathroom), `test_bathroom.js`, `test_room_shape.js`
(+ root docs: `MATERIAL_TAKEOFF_KB.md`, this file).

Suggested: one clean commit for the code (Phases 0–2 + product links), docs optionally separate.
Railway auto-deploys `material-takeoff/` from `main` on push → bathroom + roomShape go live.

---

## 10. Remaining roadmap (not yet built)

Per `MATERIAL_TAKEOFF_PLAN.md`: Phase 3 (vendor pack-size rounding — fixes the per-case tile pricing +
per-surface tile), Phase 4 (demo/subfloor/paint/trim/hardware), Phase 5 (flooring-only type), Phase 6
(drywall scope modes), Phase 7 (auth + persistence — pre-billing), Phase 8 (region/era-aware rough-in
via House Intelligence), Phase 9 (whole-home/multi-room). Immediate: push Phases 0–2; set SerpApi key
in prod; tune tile/countertop pricing; fix em-dash labels.
