# Material Takeoff — Expansion & Hardening Plan

_A roadmap for adding project types (bathroom, flooring, whole-home) and closing the current
limitations. Effort is estimated in **real developer time (no AI assistance)**._

**Status:** v1 ships one project type (`kitchen_remodel`), quantities live in prod; pricing layer
built (provider swap pending). See `MATERIAL_TAKEOFF_STATE.md` for current state.

---

## 1. Goals

1. Go from **1 project type → several** (bathroom next, then flooring, then whole-home scopes).
2. Improve **accuracy** (real-measurement inputs, room shapes, per-surface options).
3. Broaden **material coverage** (demo, subfloor, paint, trim, hardware, appliances, permits).
4. **Productionize** (auth, persistence, rate limiting) before it's billed inside BuildSuite.

---

## 2. Architecture note (what makes this easy vs. hard)

**Already generalized (reusable, no rewrite needed):**
- The **input contract** — `material_dataset.json → project_types[].inputs` drives both validation
  (`resolveInputs`) and the dynamic form (`GET /project-types`). New project types declare their own
  inputs with zero engine changes to the form/validation path.
- The **line-item builders** — `madeToMeasureLine()`, `wasteFactorLine()`, `coverageLine()` are
  generic and reused across any material.
- The **pricing layer** — tier/markup/labor/profit is project-type-agnostic; a new type only needs a
  `pricing.lines` block (search terms per line).

**Kitchen-specific today (the thing to generalize):**
- `buildTakeoff()` hard-codes the kitchen derivation (cabinet LF, base/upper split, countertop,
  backsplash, drywall, etc.). Adding a project type today means adding branching logic here.

**➡️ Foundational refactor (Phase 0):** extract each project type's quantity derivation into a
**pluggable "recipe" module** — `buildTakeoff()` dispatches on `projectType` to a builder
(`builders/kitchen_remodel.js`, `builders/bathroom_remodel.js`, …). Each builder consumes resolved
inputs + rates and returns material lines via the shared builders. This unblocks every new project
type cleanly. **~1.5–2 days.** Do this before Phase 1.

---

## 3. Prioritized roadmap

| Phase | Item | Value | Effort (real dev) |
|---|---|---|---|
| **0** | Engine refactor → pluggable per-project builders | Unblocks all types | 1.5–2 d |
| **1** | **Bathroom remodel** project type | High (most-requested #2) | 3–4 d |
| **2** | Measurement accuracy — room shapes + more real inputs | High | 2–3 d |
| **3** | Vendor pack-size rounding (tile boxes, slabs) + per-surface tile | Med-High | 2–3 d |
| **4** | Material coverage add-ons (demo, subfloor, paint, trim, hardware) | Med | 3–4 d |
| **5** | **Flooring-only** project type | Med | 2 d |
| **6** | Drywall scope modes (full / patch / none) | Med | 1 d |
| **7** | Productionization (auth, persistence, rate limiting) | High (pre-billing) | 3–5 d |
| **8** | Code/region awareness for rough-in (tie into House Intelligence) | Low-Med | 2–3 d |
| **9** | Whole-home / multi-room scoping | Low (later) | 4–6 d |

---

## 4. New project types

### 4.1 Bathroom remodel (Phase 1) — the priority
Highest-value second type. Reuses tile/drywall/thinset/grout logic; adds bath-specific lines.

**New inputs:** `bathroomSqft` (floor), `showerType` (tub / shower / tub-shower / none),
`showerSqft` or wall dimensions, `wainscotHeight`, `vanityLF`, `floorTile` (usually true),
`ceilingHeight`, plus the shared optional overrides.

**Material lines:**
- Floor tile + thinset + grout (reuse kitchen logic)
- **Shower/tub surround tile** (wall area of the wet zone) + thinset + grout
- **Waterproofing membrane** (shower walls + floor sqft, coverage-based) — NEW line type, easy
- **Cement backer board** (wet-wall area, /sheet) — variant of drywall builder
- Drywall (non-wet walls)
- Vanity (made-to-measure, LF) + vanity top (sqft + waste)
- Optional: niche, curb, waterproof tape/corners (coverage)

**Fixtures / rough-in checklist:** toilet, vanity + faucet, supply lines + shutoffs, P-traps, shower
valve + trim, tub or shower base, exhaust fan (+ vent), GFCI receptacle, vanity lighting, waste/vent.

**Pricing:** add `pricing.lines` search terms per new line (good/better/best).

**Effort:** 3–4 d (dataset block + bathroom builder + fixtures + pricing config + tests + docs).

### 4.2 Flooring-only (Phase 5)
Input: room/area sqft (or multiple rooms), `flooringType` (tile / LVP / laminate / engineered /
hardwood), `layout`. Output: flooring material (+waste, → boxes once §5 lands), underlayment/moisture
barrier, transitions/trim (by opening count or perimeter), setting materials (thinset+grout for tile,
adhesive for LVP), fasteners. **Effort:** ~2 d (small once Phase 0 + §5 exist).

### 4.3 Whole-home / multi-room (Phase 9)
Compose multiple single-room takeoffs (e.g. re-rock + paint across N rooms) and aggregate. Needs a
multi-room input model and roll-up. **Effort:** 4–6 d. Defer until single-room types are solid.

---

## 5. Fixing the current limits

Mapped to the limitations list, each with an approach + effort.

| # | Limit | Plan | Phase | Effort |
|---|---|---|---|---|
| 1 | **Kitchen only** | Phase 0 refactor + add bathroom/flooring/whole-home types (§4) | 0,1,5,9 | see §4 |
| 2 | **Estimates, not measurements** | Add a `roomShape` input (square / galley / L / U / island) with better perimeter + wall-area models; accept multiple wall segments and per-wall lengths; keep the square-room model as the fallback when only sqft is given | 2 | 2–3 d |
| 3 | **Cabinets/countertops made-to-measure** | Keep `field_verify` (correct), but add richer inputs: explicit per-run cabinet lengths, and optionally snap to **stock cabinet sizes** (12/15/18/24/30/36") to output a buildable cabinet list instead of raw LF | 2/4 | 1–2 d |
| 4 | **Tile in sqft, not boxes** | Add `tileSize` / `boxCoverage` inputs (or a small tile catalog); round tile → **boxes**, countertop → **slab count** using slab size. New `pack_round` line variant | 3 | 1.5–2 d |
| 5 | **One tile layout for floor+backsplash** | Split into `floorTileLayout` / `wallTileLayout`; feed tile size + joint width into grout/thinset coverage more precisely | 3 | 1 d |
| 6 | **No demo/subfloor/paint/trim/hardware/appliances/permits** | Add optional line groups: **demolition** (debris volume → dumpster size/count), **subfloor/backer board** (area/sheet), **paint** (primer+topcoat by wall+ceiling area ÷ coverage, N coats), **trim** (baseboard/quarter-round by perimeter → sticks), **hardware** (pulls/knobs per door+drawer), **appliances/permits** (checklist items, not quantified) | 4 | 3–4 d |
| 7 | **Drywall assumes full re-rock** | Add `drywallScope` input: `full` (current), `patch` (patch area input), `none`; scale sheets/compound/tape/screws accordingly | 6 | 1 d |
| 8 | **Rough-in checklist not code-compliant** | Keep as a checklist (correct scope), but optionally accept `state`/`metro` and surface region/era-relevant flags by reusing **House Intelligence** data; strengthen the disclaimer; version the NEC ruleset | 8 | 2–3 d |
| 9 | **No auth / persistence / rate limiting** | API-key auth (header) + simple rate limit + request logging; **persist takeoffs** to Supabase (reuse the House Intelligence insert-only pattern) so BuildSuite can save/retrieve per project | 7 | 3–5 d |
| 10 | **US-only** | Out of scope near-term (units + vendor + code assumptions are US). Revisit only if a market needs it; would require a units/locale layer | — | (deferred) |

---

## 6. Suggested sequencing

1. **Phase 0** (engine refactor) — foundational; do first.
2. **Phase 1** (bathroom) — the headline new capability; proves the refactor.
3. **Phase 2** (measurement accuracy) — lifts quality of every type.
4. **Phase 3** (pack-size rounding + per-surface tile) — makes output truly order-ready.
5. **Phase 7** (productionization) — required before billing inside BuildSuite; can run in parallel
   with 4–6 since it's mostly API/infra, not engine.
6. **Phases 4, 5, 6** — breadth (more materials, flooring, drywall modes).
7. **Phases 8, 9** — code-awareness and whole-home; later.

**Rough total to a strong v2** (Phases 0–3 + 7): **~12–17 developer days.**

---

## 7. Cross-cutting principles (keep these)

- **Data-driven first** — push everything expressible into `material_dataset.json`; only add engine
  code for genuinely new derivation logic.
- **Auditable math** — every line keeps `raw` + waste%/coverage + `basis`.
- **"No shortage" bias** — round up, conservative coverage.
- **Field-verify honesty** — made-to-measure lines stay flagged; output is a starting point.
- **Tests per addition** — each project type / line group ships with engine + server tests (current
  suite: 57 engine + 60 pricing + 33 server).
- **Pricing-agnostic** — new lines just add `pricing.lines` search terms; no pricing-engine changes.

---

## 8. Open questions (decide before building)

1. **Bathroom scope depth** — full gut vs. cosmetic refresh? (changes which lines are default-on)
2. **Stock-cabinet snapping** (limit #3) — do contractors want a buildable cabinet list, or is LF
   enough? (affects effort)
3. **Multi-room model** — one call per room (simpler) vs. one call with a rooms array (Phase 9)?
4. **Persistence owner** — same Supabase project as House Intelligence, or a separate table/service?
5. **Auth model** — shared BuildSuite key, or per-tenant keys with quotas?
