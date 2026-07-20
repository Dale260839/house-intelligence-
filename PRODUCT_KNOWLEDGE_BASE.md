# Knowledge Base — House Intelligence & Material Takeoff

_Two sibling APIs in one repo, same zero-dependency Node stack, different questions._
**Reflects PRODUCTION state as of 2026-07-09.**

| | House Intelligence | Material Takeoff |
|---|---|---|
| Question | What to **inspect**? | What to **buy**? |
| Input | a property **address** | a project scope + size |
| Output | era-based inspection scope | an order-ready material list |
| Prod status | ✅ **Live** — RentCast active | ✅ Quantities live · 🟡 pricing deployed, blocked on BigBox zipcode `preparing` |

Both are called **server-to-server by BuildSuite** (the scope/proposal generator on the Alliance for
Contractors platform). No end user calls them directly.

---

# 1. House Intelligence

**Base URL:** `https://house-intelligence-production.up.railway.app`
**Status: LIVE in production.** Address→build-year runs on the **live RentCast** adapter (confirmed
2026-07-09 with real addresses). Supabase persistence is wired for the BuildSuite endpoint.

## What it is
A contractor gets matched to a homeowner. From the home's **address**, House Intelligence derives the
**build year + region** and returns the **era-specific things that home likely has and should be
inspected for** — knob-and-tube wiring, aluminum branch wiring, asbestos, lead paint, polybutylene
supply, old panels, seismic concerns, etc. _"Looks like an expert before visiting the site."_
Output is always **"likely / inspect for," never "guaranteed present"** — every response carries a
`disclaimer`; surface it.

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /scope?address=<full street address>` | Resolve **address → year → scope** (live RentCast). |
| `GET /scope?year=1945&state=WA&metro=SEA` | Scope for a **known build year** (no lookup needed). |
| `POST /scope` | Same, body-driven: `{ address }` **or** `{ year, state, metro }`. |
| `POST /intelligence` | **BuildSuite endpoint** — resolve from address **and persist a row** (see §1.4). |
| `GET /rows?region=<STATE\|METRO>` | Blueprint region+era grid (one row per era band). |
| `GET /health` · `GET /` | Liveness · API index. |

Add `&format=text` (GET) or `"format":"text"` (POST) to any `/scope` call for a rendered text block.

## 1.1 Address format (IMPORTANT)
Live RentCast needs a **real, full street address**: `<house# street>, city, ST zip`
(e.g. `9415 Lexington Ave SW, Tacoma, WA 98499`).

Non-resolutions all still show `build_year_source.source:"rentcast"` — **the integration is fine, the
input isn't**:
- **Incomplete** (city/zip only, no street) → `reason:"http_400"`.
- **No record** for that parcel / nonexistent / non-residential → `reason:"not_found"`.

> The old demo addresses (`1730 Minor Ave, Seattle`, etc.) are **MockProvider fixtures** — test data,
> not real RentCast records. They only resolve when the server runs WITHOUT `RENTCAST_API_KEY`
> (local/offline). In production they return `not_found`.

## 1.2 The graceful `ok:false` rule
`/scope` and `/intelligence` return **HTTP 200 even when no year resolves** — you get `200` with
`ok:false` + a `reason` and `message`, by design, so a proposal flow never hard-fails.
**Branch on `ok`, not the HTTP status.** (`/rows` with no region and malformed JSON are the only 400s;
unknown route is 404.)

## 1.3 Response essentials (`/scope`)
```jsonc
{
  "ok": true,
  "year": 1949, "state": "WA", "metro": null,
  "era": { "id": "1930_1949", "label": "1930–1949", "range": [1930, 1949] },
  "severity": "High",                       // overall rollup: High | Medium | Low
  "categories": {                           // 6 buckets, each an array of items w/ severity + source
    "Electrical": [ { "item": "Remaining knob-and-tube", "severity": "High", "source": "era:1930_1949" } ],
    "Plumbing": [...], "Structural": [...], "HVAC": [...], "Hazards": [...], "Envelope": [...]
  },
  "high_priority_flags": [ "Remaining knob-and-tube", "Lead-based paint (assume present)", ... ],
  "row": { "id": "SEA-1930", "region": "Seattle, WA", "severity": "High", ... },  // when metro known
  "address": { "line1": "...", "city": "...", "state": "WA", "zip": "...", "freeform": "..." },
  "build_year_source": { "source": "rentcast", "confidence": "exact", "resolved_year": 1949, "ok": true },
  "property": {                             // "more info about the house" — from the SAME RentCast call
    "propertyType": "Single Family", "squareFootage": 1740, "bedrooms": 3, "bathrooms": 3,
    "lotSize": 9800, "floorCount": 1, "features": { "heatingType": "Forced Air", "cooling": true, ... },
    "source": "rentcast"
  },
  "lead_links": { "redfin": "https://www.redfin.com/search?location=..." },  // lead hand-off only
  "summary": "...", "disclaimer": "These are probabilistic era patterns ... NOT a guarantee ..."
}
```
- 6 categories: **Electrical · Plumbing · Structural · HVAC · Hazards · Envelope**.
- Each item has a `source` (`era:<id>` or `region:<id>`) for provenance.
- `metro` is `null` for cities not yet mapped (only a handful mapped; e.g. Tacoma → null). Scope still
  works via **state-level** regional modifiers; only the metro blueprint `row` id is absent.

## 1.4 BuildSuite endpoint — `POST /intelligence`
BuildSuite passes the match context; House Intelligence resolves the scope **and appends one row** to
Supabase (`house_intelligence_requests`, insert-only, one row per request) for the matched-clients view.

```jsonc
// request
{ "address": "9415 Lexington Ave SW, Tacoma, WA 98499",   // REQUIRED
  "project_id": "...", "contractor_id": "...",
  "client_id": "...",    // contacts.id (uuid)
  "contact_id": "..." }  // GHL ghl_contact_id  → joins matches.contact_id
// response
{ "ok": true, "scope": { ...full scope... }, "property": {...}, "lead_links": {...},
  "stored": { "ok": true, "stored": true, "record": { ... } } }
```
- **No auth of its own** — only called server-to-server from GHL-authenticated BuildSuite. Don't call
  it from the browser.
- `stored.ok` is independent of `ok` (scope can succeed while the DB write fails — check both).
- Full detail: [BUILDSUITE_INTEGRATION.md](BUILDSUITE_INTEGRATION.md). Engine reference: [API_GUIDE.md](API_GUIDE.md).

## 1.5 Production notes
- `RENTCAST_API_KEY` is set on Railway (live). Locally there's no `.env`, so local runs fall back to
  the MockProvider — don't let that confuse debugging.
- Supabase persistence needs `SUPABASE_URL` + `SUPABASE_KEY` (publishable/anon, RLS-gated) set on the
  host and the migration `supabase/house_intelligence_requests.sql` applied. Confirm a real row lands.
- Limits: US-only; probabilistic (not factual); state-level region granularity; scope only (no pricing).

---

# 2. Material Takeoff

**Base URL:** `https://house-intelligence-production-f7f6.up.railway.app`
**Status: quantities LIVE in production.** The **pricing + profit layer is built and tested locally
but NOT yet deployed** (uncommitted) — and even once deployed it needs a `HOMEDEPOT_API_KEY` to work.
See §2.4.

## What it is
Give it a project type + size and it returns an **order-ready material list** — quantities that already
include standard **waste factors**, with the raw measurement + waste %/coverage shown so the math is
**auditable** ("no waste, no shortage"), plus a plumbing/electrical rough-in checklist.
**v1 covers one project type: `kitchen_remodel`.** Cabinets & countertops are made-to-measure and
always flagged `field_verify`.

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /material-takeoff/project-types` | Supported types + required/optional input fields (render a form). |
| `POST /material-takeoff` | Body `{ projectType, kitchenSqft, ...optional }` → full takeoff. |
| `GET /material-takeoff?projectType=kitchen_remodel&kitchenSqft=200` | Same, query-driven. |
| `GET /health` · `GET /` | Liveness · API index. |

Add `&format=text` / `"format":"text"` for a rendered block. Bad/missing input → **HTTP 400** with a
clear JSON message (unlike House Intelligence, this one *does* 400 on invalid input).

## 2.1 Inputs (kitchen_remodel)
**Required:** `kitchenSqft` (floor area, ≥1). **Optional (with defaults):** `ceilingHeight` (8),
`tileLayout` (straight | diagonal | herringbone | mosaic), `floorTile` (true), `countertopType`
(solid | veined), `backsplashHeight` (18in), `openings` (2), `includeCeiling` (false), and
known-measurement overrides `cabinetLF` / `baseCabinetLF` / `upperCabinetLF` / `countertopSqft` /
`wallPerimeterLF`. **Pass the overrides when known** — the defaults are square-room estimates.

## 2.2 Response essentials
```jsonc
{
  "ok": true, "project_type": "kitchen_remodel",
  "derived": { "total_cabinet_lf": 40, "wall_area_sqft": 422.5, "tiled_substrate_sqft": 236, ... },
  "materials": [   // ~11 lines for a 200 sqft kitchen
    { "key": "thinset", "type": "coverage", "raw": 236, "coverage": 75,
      "order_qty": 4, "order_unit": "50 lb bag", "basis": "...", "note": "..." },
    { "key": "base_cabinets", "type": "made_to_measure", "order_qty": 24, "order_unit": "LF",
      "field_verify": true, ... }
  ],
  "fixtures_checklist": { "plumbing": [...], "electrical": [...] },
  "summary": "...", "field_verify_items": [...], "disclaimer": "...order-ready STARTING POINT..."
}
```
Line `type`s: `made_to_measure` (cabinets — no waste, field-verify), `waste_factor`
(`order = raw × (1+waste)`), `coverage` (`order = ceil(raw ÷ coverage)` in whole units).

## 2.3 Standards (baked into `material_dataset.json`, sourced in `_meta`)
Cabinets 0.20 LF/sqft (60% base / 40% upper), made-to-measure · Countertop ~1 sqft/base-LF, +15%
solid / +25% veined · Tile waste 7% straight / 15% diagonal / 20% herringbone·mosaic · Thinset
75 sqft/50lb bag · Grout 100 sqft/25lb (50 for mosaic) · Drywall 32 sqft/sheet, 15% kitchen waste,
+ compound/tape/screws. Conservative by design ("no shortage" > "no waste").

## 2.4 Pricing + profit layer — DEPLOYED, blocked on BigBox zipcode provisioning
> Built, tested (150 tests), committed, pushed, and **deployed to prod**. Prod is wired to **live
> BigBox (Home Depot) pricing** and the config is correct. **Current blocker (BigBox side, one-time):**
> the configured zipcode `98006` is still `preparing` on BigBox, so requests return `http_400` until it
> goes `ready`. No code/config changes pending. See MATERIAL_TAKEOFF_STATE.md §2 for live detail.

Design (opt-in via `price=true`):
- **Live Home Depot pricing** per material line via a **third-party API** (Home Depot has no official
  one). Set `HOMEDEPOT_API_KEY` (SerpApi default; `HOMEDEPOT_API_URL` supports `{query}`/`{key}` for
  BigBox etc.). **No key → pricing unavailable** (`{ ok:false, reason:"pricing_unavailable" }`);
  quantities still return. No baked price catalog by design.
- **Quality tiers** `tier=good|better|best` (builder / mid / premium) — each maps to a HD search term.
- **Profit layout** — materials → **labor line** (`laborPct`, default 100% of materials, or `laborCost`)
  → total cost → `markupPct` (default 20%) → client price → profit, showing **both markup % and implied
  margin %**.
```jsonc
"pricing": {
  "ok": true, "source": "homedepot_live", "tier": "better",
  "lines": [ { "key":"thinset", "unit_price":18, "line_cost":72, "order_qty":4, "order_unit":"50 lb bag" } ],
  "profit_layout": { "materials_cost":10382, "labor_cost":10382, "total_cost":20764,
                     "markup_pct":20, "price":24916.80, "profit":4152.80, "margin_pct":16.7 }
}
```
Recommended pricing vendor: **BigBox API** (purpose-built for Home Depot, ~$15/mo/500 credits, free
100-request trial) or **SerpApi** (pricier, very reliable — the code default). Full contract:
[material-takeoff/API_GUIDE.md](material-takeoff/API_GUIDE.md) §4b.

**To ship pricing to prod:** commit the pricing files → redeploy → set `HOMEDEPOT_API_KEY` → make one
real call to confirm the third-party response shape parses.

---

# 3. Quick test links (production)

**House Intelligence — real address (resolves):**
```
https://house-intelligence-production.up.railway.app/scope?address=9415%20Lexington%20Ave%20SW,%20Tacoma,%20WA%2098499
```
add `&format=text` for a readable block.

**House Intelligence — known year (no lookup):**
```
https://house-intelligence-production.up.railway.app/scope?year=1945&state=WA&metro=SEA
```

**Material Takeoff — quantities:**
```
https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200
```
(`&price=true` will only return pricing once the pricing layer is deployed + a Home Depot key is set.)

---

# 4. Standing principles
- **Both are advisory starting points, not guarantees.** HI: "likely / inspect for." MT: "order-ready
  starting point, field-verify." Always surface the `disclaimer`.
- **Called by BuildSuite only**, server-to-server. No public auth/rate-limit yet — add before broad use.
- **Zero runtime dependencies**, deterministic, unit-tested. HI ~138 tests; MT 57 engine + 33 server
  (+ 56 pricing locally). Vendor field names stay quarantined in the provider/adapter seams.
