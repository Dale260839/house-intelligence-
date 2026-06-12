# Priority #2 — House Intelligence Knowledge Base

_Phase 1 foundation + address layer. Files: `era_dataset.json`, `lookup_engine.js`, `address_provider.js`,
and tests `test_engine.js`, `test_address_provider.js`, `test_alignment.js` (121 tests, all passing)._

---

## The spec (Chris's words)

> We create a dataset of construction eras by region — knob and tube wiring, cast iron
> plumbing, aluminum wiring years, panel types — and load it into the knowledge base. Then
> when a contractor enters a job address, the scope of work automatically includes the right
> inspection items based on the year the house was built. The contractor looks like an expert
> before they ever visit the site. Nobody else in this space has that.

---

## What's built (Phase 1)

The hard part of this product is the **data and the logic** — not the wiring. Both now exist
and are tested.

**1. `era_dataset.json` — the knowledge base.**
A national dataset of 9 construction-era bands (pre-1900 → 2010-present). For each era it
records, across **10 systems** (electrical, plumbing supply, plumbing waste, panel, hazards,
foundation, heating, insulation, roofing, windows): what's *likely* present, and what to
*inspect for*. Plus **5 regional modifiers** (Pacific NW, Seismic West, Gulf/Southeast, Cold
Northeast/Midwest, Arid Southwest) that add location-specific items.

Era boundaries were **researched and corroborated**, not guessed — e.g. knob-and-tube fading
by ~1930s, aluminum branch wiring ~1965–73, polybutylene late-70s to mid-90s, lead paint
banned 1978, lead pipe/solder banned 1986, Chinese drywall 2001–2009. Sources are listed in
the dataset's `_meta`.

**2. `lookup_engine.js` — the brain.**
Takes a build year + optional state/metro and returns the era, the likely systems, a **deduped
list of inspection items grouped into the 6 blueprint categories** (Electrical, Plumbing,
Structural, HVAC, Hazards, Envelope), a **High/Medium/Low severity** per item and an overall
**row severity**, the **high-priority flags** (every High item — knob-and-tube, aluminum wiring,
Federal Pacific/Zinsco, lead service line, lead paint, asbestos, polybutylene, Chinese drywall,
unreinforced masonry, buried oil tanks, seismic), and a **blueprint-style region+era row**
(`SEA-1930`, `LA-1965`, …). It renders a clean scope-of-work text block and can emit the
blueprint's flat Layer-1 table as CSV (`--rows SEA`).

**3. `address_provider.js` — the address layer.**
The vendor-agnostic seam: `resolveBuildYear(address)` contract + a deterministic mock adapter +
a cache decorator + `resolveScopeForAddress()` that chains address → year → scope. Metro is
inferred from the address (Seattle → `SEA` rows) for region-pilot work.

**4. Tests — proof it works.**
121 tests across `test_engine.js` (27), `test_address_provider.js` (32), and `test_alignment.js`
(62). Covers the spec example, era boundaries, new-build/clean cases, bad input, the address
flow, metro inference, and full Dataset-Blueprint alignment (categories, severity flags, sample
rows, grid, categorization correctness). An adversarial audit (one agent per blueprint layer)
drove the latest round of fixes.

### The spec example, working

Input: **1945, WA** (a 1940s Seattle house). Output, automatically:
- Era: 1930–1949 + Pacific NW + Seismic West regional factors — **37 inspection items**, 16 flagged high-priority, **overall severity High**, blueprint row **`SEA-1930`**.
- Electrical: remaining knob-and-tube, cloth NM, ungrounded circuits, service capacity.
- Plumbing: galvanized at end-of-life, lead solder joints, possible lead service line.
- Hazards: lead paint (assume present), asbestos tile/pipe-wrap/siding, lead service line.
- Regional: crawlspace moisture, wood rot, knob-and-tube lingering, buried oil tanks, **foundation bolting / sill-plate anchorage, cripple-wall bracing, unreinforced masonry**.

That's the "looks like an expert before they visit the site" output — generated from a year and a state, no site visit.

---

## How to use it right now

```bash
node lookup_engine.js 1945 WA      # 1940s Seattle house
node lookup_engine.js 1968 IL      # aluminum-wiring-era Chicago
node lookup_engine.js 2022 CA      # new CA build (clean, but seismic items)
```

Or call `buildScope({ year, state })` from any Node context — it returns a structured object
(`inspection_items`, `categories`, `severity`, `high_priority_flags`, `row`, `systems`, …) for a
proposal engine or GHL. Address-first: `resolveScopeForAddress(address, { provider })`.

```bash
node lookup_engine.js --rows SEA     # blueprint Layer-1 table for Seattle, as CSV
node address_provider.js "1730 Minor Ave, Seattle, WA 98101"   # address → scope
```

---

## Alignment with the Dataset Blueprint (#2)

The engine speaks the blueprint's language while keeping a DRY model under the hood:

| Blueprint | Where it lives |
|---|---|
| **Layer 1** — one region+era row (`id`, `region`, `era_start/end`, system columns, `inspection_items`, `severity`) | `buildEraRow()` / `scope.row`; full grid via `buildRegionGrid()` / `--rows` |
| **Layer 2** — 6 categories (Electrical, Plumbing, Structural, HVAC, Hazards, Envelope) | `CATEGORY_OF` + `scope.categories`; `_meta.category_map` |
| **Layer 2** — High/Medium/Low **severity** flags | `classifySeverity()` (encodes the feature→flag table) + `scope.severity` |
| **Layer 3** — sample rows `SEA-1940` / `LA-1968` | reproduced as `SEA-1930` / `LA-1965` (band-based ids); content matches |
| **Layer 4** — address → year → era → items | `address_provider.js` |

**Design choice (deliberate):** the blueprint draws one flat row per region+era. We store the
national era pattern *once* and layer regional modifiers on top, then **generate** those flat
rows on demand — so JC still gets the exact Layer-1 table (and CSV for the sheet) without the
national pattern being hand-copied into every region. Same output, no duplication.

**Two band-vs-blueprint notes:** (1) our era bands are research-driven (e.g. 1930–1949), so row
ids use the band start (`SEA-1930`) rather than the blueprint's decade label (`SEA-1940`) — the
*content* matches. (2) Regional items aren't yet era-gated, so a new Seattle build still shows
seismic items (and reads "High"). Era-gating regional modifiers is a clean next refinement.

---

## What's NOT built yet (the roadmap)

This is the foundation. To reach the full spec, the remaining work is **integration**, in order:

1. **Address → build year lookup.** The spec says "when a contractor enters a job *address*."
   Right now the engine takes a *year* directly. The missing piece is turning an address into a
   build year — via a property-data API (county assessor / parcel data; several exist on Apify
   or as paid APIs). Once that's in, the contractor enters an address and the year is resolved
   automatically. _(This is the same pattern as the #1 license actor — pick a data source,
   confirm its schema, wire it. Don't guess the schema.)_

2. **Wire into BuildSuite's scope-of-work / proposal engine.** The output needs to flow into
   the actual scope-of-work generator so the inspection items appear in the proposal Kairo
   produces. This is the integration point with the existing BuildSuite system Sing maintains.

3. **Product name.** Chris wants an "Intelligence" product name (placeholders seen: SiteIQ /
   House Intelligence) — he sees commercial and even government potential. Decide before launch.

4. **Data depth pass.** v1 covers the major, well-documented era patterns nationally. A second
   pass can deepen specific high-value regions (e.g. more granular Seattle/PNW detail) and add
   more regional modifiers. The dataset is structured so this is additive — no rewiring.

5. **#5 spin-off — Material Takeoff.** Chris flagged this builds on #2: once the system knows
   scope + house type, it auto-calculates material quantities. That's the next automation after
   this, and it reads from the same foundation.

---

## Honest caveats

- **"Likely / inspect for", never "guaranteed".** Every output carries a disclaimer: these are
  probabilistic era patterns to *prompt* inspection, not assert what's in a specific house
  (homes get re-piped, re-wired, renovated). Keep that framing in the product so it's never
  oversold.
- **National = era patterns, not a single downloadable database.** There is no one file that
  says "house built year X has system Y." This dataset codifies well-documented national era
  norms with regional shading. That's the honest, defensible way to build "national" v1.
- **Era boundaries are approximate and overlapping in reality.** Adoption was gradual and
  regional; the bands are deliberately framed as "transition" where appropriate.

---

## Status

| Piece | Status |
|---|---|
| Era dataset (9 bands × 10 systems) | ✅ Built & researched |
| Regional modifiers (5 regions) | ✅ Built |
| Lookup engine (year+state → scope) | ✅ Built & tested |
| Blueprint alignment (6 categories, severity, region+era rows, CSV grid) | ✅ Built & tested |
| Spec example (1940s Seattle) | ✅ Working |
| Test suite (engine + provider + alignment) | ✅ 121/121 passing |
| Address → build-year: provider interface + mock | ✅ Built (vendor adapter pending pick) |
| Address → build-year: live vendor adapter | ⬜ RentCast recommended — confirm schema, then wire |
| BuildSuite proposal integration | ⬜ Needs Sing |
| Product name | ⬜ Chris's call |
| Deeper regional data pass (+ era-gate regional items) | ⬜ Additive, anytime |
| #5 Material Takeoff (spin-off) | ⬜ Builds on this |
