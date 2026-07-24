# Material Takeoff API — Usage Guide

**Base URL:** `https://house-intelligence-production-f7f6.up.railway.app`

Give it a kitchen's scope + size, get back an **order-ready material list** — quantities that
already include standard waste factors, with the raw measurement and waste % shown so the math
is auditable. JSON in / JSON out, **CORS enabled** (callable from the browser). No API key.

> Sibling of the House Intelligence API (`/scope`, `/rows`), deployed as a separate service from
> the same repo. **Supported project types: `kitchen_remodel` and `bathroom_remodel`.** Each has its
> own inputs — always discover them via `GET /material-takeoff/project-types` (§3).

---

## ⚠️ Current status — read first

- ✅ **Quantities are LIVE and stable.** `POST /material-takeoff` reliably returns the full material
  list + rough-in checklist. **Build the core UI against this now** — it won't change.
- 🟡 **Pricing (`price=true`) — response contract is FINAL; provider being activated.** BigBox (the
  original Home Depot price source) had a multi-day platform outage, so we switched to **SerpApi**,
  which is **verified working end-to-end** (real prices flowing). It goes live the moment the SerpApi
  key is set on the server. Until then, a `price=true` call still returns **HTTP 200 with the full
  quantities**, but the `pricing` block comes back `{ "ok": false, "reason": "pricing_unavailable" }`.
- 👉 **What this means for you:** build the pricing UI **defensively** — always render the quantities,
  and render the pricing/profit block **only when `data.pricing?.ok === true`**; otherwise show a
  graceful "pricing unavailable" state. **No frontend change will be needed when pricing turns back
  on** — the shape in §4b is already the final one. See the pricing-aware example in §6.

---

## 1. How to use it

**The typical flow — 3 steps:**

1. **Discover the form** → `GET /material-takeoff/project-types`
   Returns every input field (name, type, default, unit, allowed values) so you can render the form
   dynamically without hardcoding it.
2. **Request a takeoff** → `POST /material-takeoff` with `{ projectType, kitchenSqft, ...optional }`
   Returns the material list + rough-in checklist. Quantities always come back; add `price=true` to
   also get live pricing + a profit layout.
3. **Render the result**
   Always show `materials` + `fixtures_checklist`. If you requested pricing, show the `pricing` block
   **only when `pricing.ok === true`** (quantities and pricing are independent — see §6).

**Call it two ways — same parameters (§3) either way:**

```bash
# POST + JSON (use this from an app)
curl -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff \
  -H "Content-Type: application/json" \
  -d '{"projectType":"kitchen_remodel","kitchenSqft":200}'
```

```
# GET + query string (handy for a link / browser). Add &format=text for a human-readable block.
https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&format=text
```

CORS is enabled, so the browser can call it directly. No API key required to call the API (pricing
needs a provider key configured **on the server**, not sent by the client).

---

## 2. Endpoints

| Method & path | Purpose |
|---|---|
| `GET /material-takeoff/project-types` | Supported project types + the required/optional input fields (types, defaults, units). Use this to **render a form dynamically.** |
| `POST /material-takeoff` | The main call. Body `{ projectType, kitchenSqft, ...optional }` → full takeoff. |
| `GET /material-takeoff?projectType=...&kitchenSqft=...` | Same as POST, query-driven (handy for a browser/link). |
| `GET /health` | Liveness probe → `{"status":"ok"}`. |
| `GET /` | API index + endpoint list. |

Add `&format=text` (GET) or `"format":"text"` (POST) to any takeoff call for a rendered text
block instead of JSON.

Add `price=true` to any takeoff call to attach **live Home Depot pricing + a profit layout**
(see §4b). Requires `HOMEDEPOT_API_KEY` on the server.

---

## 3. Parameters

Every parameter works the same as a **JSON body field** (POST) or a **query-string param** (GET) —
they coerce identically (query strings like `floorTile=false` become the right type). Parameters
fall into three groups: **A** describes the job, **B** controls output format, **C** turns on pricing.

### A. Takeoff inputs (describe the job)

Inputs are **per project type** — `projectType` (always required) selects the type, and each type
declares its own fields. The authoritative list is `GET /material-takeoff/project-types`; the two
built-in types are documented below.

#### `kitchen_remodel`

**Required**

| Param | Type | Unit | Notes |
|---|---|---|---|
| `projectType` | string | — | `"kitchen_remodel"`. |
| `kitchenSqft` | number | sqft | Kitchen **floor** area. Drives every derived quantity. Must be ≥ 1. |

**Optional** (sensible defaults; override when you know the real number)

| Param | Type | Default | Notes |
|---|---|---|---|
| `ceilingHeight` | number (ft) | `8` | Wall height for drywall. |
| `tileLayout` | enum | `straight` | `straight` (7%), `diagonal` (15%), `herringbone` (20%), `mosaic` (20%) — sets tile waste %. |
| `floorTile` | boolean | `true` | Whether the floor is tiled. Set `false` for LVP / wood / existing floor. |
| `countertopType` | enum | `solid` | `solid` (+15% slab waste) or `veined` (+25%, pattern-matched). |
| `backsplashHeight` | number (in) | `18` | Backsplash height; `0` = no backsplash. |
| `openings` | number | `2` | Door/window openings, deducted from drywall (~15 sqft each). |
| `includeCeiling` | boolean | `false` | Add the ceiling to the drywall quantity. |
| `cabinetLF` | number (LF) | derived | Known **total** cabinet LF. Overrides the floor-area estimate; split 60/40 base/upper. |
| `baseCabinetLF` | number (LF) | derived | Known base LF (also drives countertop + backsplash). |
| `upperCabinetLF` | number (LF) | derived | Known upper LF (drives under-cabinet lighting length). |
| `countertopSqft` | number (sqft) | derived | Known **finished** countertop area. |
| `wallPerimeterLF` | number (LF) | derived | Known wall perimeter (else estimated from `roomShape`). |
| `roomShape` | enum | `square` | `square` / `rectangular` / `galley` / `l_shaped` / `u_shaped` / `island` — refines the wall-perimeter estimate (longer/irregular shapes have more wall per sqft); `island` also adds ~15% cabinet/counter run. Ignored when `wallPerimeterLF` is given. |
| `floorTileLayout` · `backsplashTileLayout` | enum | *falls back to `tileLayout`* | Per-surface tile layout (`straight`/`diagonal`/`herringbone`/`mosaic`) so floor and backsplash can differ. |
| `floorTileBoxSqft` · `backsplashTileBoxSqft` | number (sqft) | — | Coverage per box of your tile. When given, that tile is ordered in whole **boxes** (`pack_round` line) and **priced per box**. |
| `countertopSlabSqft` | number (sqft) | — | Usable area per slab. When given, countertop is ordered in whole **slabs**. |
| `includeDemolition` · `includeSubfloor` · `includePaint` · `includeTrim` · `includeHardware` | boolean | `false` | **Add-on groups (§3.D)** — each adds its own material line(s). All off by default. |
| `paintCoats` | number | `2` | Topcoats when `includePaint` is on (primer is always 1 coat). |

> **Pass the known-measurement overrides whenever you have them** (`cabinetLF`, `countertopSqft`,
> `wallPerimeterLF`). Defaults are scoping estimates from a square-room model; real measurements make
> the takeoff accurate. `GET /material-takeoff/project-types` returns this exact list programmatically
> (with types/defaults/units) so a UI can build the form without hardcoding it.

#### `bathroom_remodel`

**Required**

| Param | Type | Unit | Notes |
|---|---|---|---|
| `projectType` | string | — | `"bathroom_remodel"`. |
| `bathroomSqft` | number | sqft | Bathroom **floor** area. Drives floor tile + geometry. Must be ≥ 1. |

**Optional** — scope is **configurable, default-full**; toggles drop major line groups.

| Param | Type | Default | Notes |
|---|---|---|---|
| `ceilingHeight` | number (ft) | `8` | Wall height for drywall + surround. |
| `showerType` | enum | `tub_shower` | `tub_shower` / `shower` (walk-in) / `tub` / `none`. Sets the surround wall area; **`none` drops surround tile, waterproofing, and backer board.** |
| `showerWallSqft` | number (sqft) | derived | Known tiled surround area (else derived from `showerType`). |
| `tileLayout` | enum | `straight` | Waste %: `straight` 7 / `diagonal` 15 / `herringbone` 20 / `mosaic` 20. Applies to floor + wall tile. |
| `wainscotHeight` | number (in) | `0` | Wall-tile wainscot around the room beyond the wet zone. `0` = none. |
| `vanityLF` | number (LF) | `3` | Vanity linear feet → vanity + vanity top. `0` (or `includeVanity:false`) drops them. |
| `vanityTopType` | enum | `solid` | `solid` (+15% slab waste) or `veined` (+25%). |
| `floorTile` | boolean | `true` | Set `false` for LVP / existing floor (drops floor tile). |
| `includeVanity` | boolean | `true` | Set `false` to keep the existing vanity. |
| `includeWaterproofing` | boolean | `true` | Set `false` to skip the membrane (keeps tile + backer). |
| `openings` | number | `1` | Door/window openings, deducted from wall area (~15 sqft each). |
| `includeCeiling` | boolean | `false` | Add the ceiling to the drywall quantity. |
| `wallPerimeterLF` | number (LF) | derived | Known wall perimeter (else estimated from `roomShape`). |
| `roomShape` | enum | `square` | `square` / `rectangular` / `galley` / `l_shaped` / `u_shaped` — refines the wall-perimeter estimate. Ignored when `wallPerimeterLF` is given. |
| `floorTileLayout` · `wallTileLayout` | enum | *falls back to `tileLayout`* | Per-surface tile layout so the floor and the shower/wall surround can differ. |
| `floorTileBoxSqft` · `wallTileBoxSqft` | number (sqft) | — | Box coverage; when given, that tile is ordered in whole **boxes** (`pack_round`) and **priced per box**. |
| `vanityTopSlabSqft` | number (sqft) | — | Usable area per slab; when given, the vanity top is ordered in whole **slabs**. |
| `includeDemolition` · `includeSubfloor` · `includePaint` · `includeTrim` · `includeHardware` | boolean | `false` | **Add-on groups (§3.D)** — all off by default. Paint covers the **dry** walls only (the wet zone is tiled). |
| `paintCoats` | number | `2` | Topcoats when `includePaint` is on. |

> Bathroom material lines: floor tile, **wall tile** (shower/tub surround + wainscot), thinset, grout,
> **waterproofing membrane**, **cement backer board** (wet walls), drywall (dry walls) + compound/tape/
> screws, **vanity** + **vanity top** — plus a bathroom rough-in checklist (toilet, vanity+faucet,
> shutoffs, P-trap, shower valve, tub/shower base, waste/vent, exhaust fan, GFCI, vanity lighting, Romex).

### B. Output format

| Param | Type | Default | Effect |
|---|---|---|---|
| `format` | enum | `json` | Set to `text` for a human-readable rendered block instead of JSON (great for email/proposal/browser). |

### C. Pricing parameters (opt-in — see §4b for the pricing response)

| Param | Type | Default | Notes |
|---|---|---|---|
| `price` | boolean | `false` | Turn pricing on. The rest of this group is ignored unless this is set. |
| `tier` | enum | `better` | `good` (builder grade), `better` (mid), `best` (premium). Picks which product/price per line. |
| `markupPct` | number (%) | `20` | Markup on total cost: `price = cost × (1 + markupPct/100)`. |
| `laborPct` | number (%) | `100` | Labor as a **percent of material cost**. Default 1:1 is a rough rule of thumb — override per job. |
| `laborCost` | number ($) | — | Explicit labor dollars. **Overrides `laborPct`** when given. |

### D. Add-on groups (opt-in — extra scope beyond the core material list)

Each toggle adds its own material line(s) to `materials`. **All default to `false`**, so turning none
on gives exactly the same takeoff as before. Available on **both** project types.

| Toggle | Adds line(s) | How it's derived |
|---|---|---|
| `includeDemolition` | `demolition_dumpster` | floor area × debris rate (kitchen 0.08, bathroom 0.12 cu yd/sqft) → whole dumpsters |
| `includeSubfloor` | `subfloor` | floor area +10% waste → 4×8 panels |
| `includePaint` | `primer` + `paint` | drywall surface × coats ÷ ~350 sqft per gal (bathroom: **dry walls only**); `paintCoats` sets topcoats (default 2) |
| `includeTrim` | `baseboard` | perimeter − 3 ft per opening, +10% → 16 ft sticks |
| `includeHardware` | `cabinet_hardware` | cabinet LF (kitchen) / vanity LF (bathroom) × 0.9 pulls per LF |

Add-on lines carry the same `raw` / `order_qty` / `basis` fields as core lines and are **priced** like
any other line when `price=true`.

> Dumpster/haul-away pricing varies hugely by locality — treat `demolition_dumpster` cost as a rough
> placeholder and use a local quote.

---

## 4. Response — quantities

A successful takeoff (`ok: true`, HTTP 200) has these top-level fields:

| Field | Type | What it is |
|---|---|---|
| `ok` | boolean | `true` on success. **Always branch on this**, not just the HTTP status. |
| `project_type` | string | Echo of the project type (`"kitchen_remodel"`). |
| `inputs` | object | Every input echoed back with defaults applied (so you can confirm what was used). |
| `derived` | object | The geometry the estimate was built from (cabinet LF, wall area, tiled area, etc.). |
| `materials` | array | One object per material line — **the order list** (see "Reading a material line"). |
| `fixtures_checklist` | object | `{ plumbing:[…], electrical:[…] }` — rough-in items (`item`, `qty`, `unit`, `note`). Not priced. |
| `summary` | string | One-line human summary of the takeoff. |
| `field_verify_items` | string[] | Keys of the made-to-measure lines to flag "verify before ordering". |
| `disclaimer` | string | Surface this — it states the output is a starting point, not a field measurement. |
| `pricing` | object | **Only present when `price=true`** — see §4b. |

```jsonc
{
  "ok": true,
  "project_type": "kitchen_remodel",
  "inputs": { "kitchenSqft": 200, "ceilingHeight": 8, "tileLayout": "straight", "floorTile": true, ... },
  "derived": {
    "total_cabinet_lf": 40, "base_cabinet_lf": 24, "upper_cabinet_lf": 16,
    "wall_perimeter_lf": 56.6, "wall_area_sqft": 422.5,
    "backsplash_sqft": 36, "floor_tile_sqft": 200, "tiled_substrate_sqft": 236,
    "countertop_finished_sqft": 24
  },
  "materials": [ /* one object per material line — see below */ ],
  "fixtures_checklist": {
    "plumbing":   [ { "item": "Kitchen sink", "qty": 1, "unit": "ea", "note": "..." }, ... ],
    "electrical": [ { "item": "GFCI counter receptacles", "qty": 6, "unit": "ea", "note": "..." }, ... ]
  },
  "summary": "Full Kitchen Remodel — 200 sqft: 11 material lines quantified ...",
  "field_verify_items": ["base_cabinets","upper_cabinets","countertop"],
  "disclaimer": "This is an order-ready STARTING POINT ... NOT a substitute for field measurement ..."
}
```

### Reading a material line

Each object in `materials` has these fields:

| Field | Type | What it is |
|---|---|---|
| `key` | string | Stable id for the line (`base_cabinets`, `thinset`, …) — use for keying UI rows. |
| `label` | string | Human label (`"Thinset mortar"`). |
| `type` | enum | `made_to_measure` / `waste_factor` / `coverage` — how `order_qty` was reached (below). |
| `raw` | number | The measured driver (e.g. 236 sqft to tile). |
| `raw_unit` | string | Unit of `raw` (`sqft`, `LF`, …). |
| `order_qty` | number | **What to actually buy.** |
| `order_unit` | string | Unit of `order_qty` (`50 lb bag`, `sheet`, `sqft`, `LF`, …). |
| `waste_pct` | number\|null | Waste % applied (`waste_factor` lines); `0` for made-to-measure; `null` for coverage lines. |
| `coverage` / `coverage_unit` | number / string | Coverage rate (`coverage` lines only, e.g. 75 `sqft/bag`). |
| `field_verify` | boolean | `true` = made-to-measure; show a "verify before ordering" flag. |
| `basis` | string | Plain-English explanation of the math — show it for trust/auditability. |
| `note` | string | Estimating note for the line. |

The `type` determines how `order_qty` is computed:

| `type` | Applies to | Order math |
|---|---|---|
| `made_to_measure` | Cabinets, vanity — cut to fit | `order_qty = raw` (no waste factor); **`field_verify: true`** |
| `waste_factor` | Countertop, tile, drywall (sqft) | `order_qty = raw × (1 + waste_pct/100)` |
| `coverage` | Thinset, grout, compound, tape, screws | `order_qty = ceil(raw ÷ coverage)` in whole purchasable units |
| `pack_round` | Tile w/ box size, countertop/vanity-top w/ slab size | `order_qty = ceil(raw×(1+waste) ÷ pack_size)` in whole **boxes/slabs**; also reports `covered_qty` (sqft incl. waste) + `pack_size`/`pack_unit`. **Priced per box/slab.** |

Example lines:

```jsonc
{ "key": "base_cabinets", "type": "made_to_measure",
  "raw": 24, "raw_unit": "LF", "waste_pct": 0,
  "order_qty": 24, "order_unit": "LF",
  "field_verify": true, "basis": "0.2 LF/sqft total x 60% base" }

{ "key": "countertop", "type": "waste_factor",
  "raw": 24, "raw_unit": "sqft", "waste_pct": 15,
  "order_qty": 28, "order_unit": "sqft",
  "field_verify": true, "basis": "1 sqft per base LF (24 LF)" }

{ "key": "thinset", "type": "coverage",
  "raw": 236, "raw_unit": "sqft", "coverage": 75, "coverage_unit": "sqft/bag",
  "order_qty": 4, "order_unit": "50 lb bag" }
```

- **`raw`** = the measured driver. **`order_qty` / `order_unit`** = what to actually buy.
- **`basis`** = a plain-English explanation of where the number came from (show it in the UI for
  trust/auditability).
- **`field_verify: true`** = made-to-measure; surface a "verify before ordering" flag.

For the canonical **200 sqft** kitchen you get **11 material lines** + a **13-item rough-in
checklist**: base/upper cabinets, countertop, backsplash + floor tile, thinset, grout, drywall
sheets, joint compound, tape, screws — plus plumbing (sink, faucet, supplies, shutoffs, P-trap,
dishwasher, disposal) and electrical (GFCI receptacles, small-appliance circuits, dedicated
appliance circuits, range circuit, under-cabinet lighting, Romex).

---

## 4b. Pricing & profit layout (opt-in)

Add `price=true` and the takeoff gains a **`pricing`** block: a **live Home Depot unit price**
for each material line at a chosen **quality tier**, and a **profit layout** (materials + labor →
cost → markup → client price → profit + margin).

> **Home Depot has no official pricing API.** Live prices come from a third-party service
> (SerpApi Home Depot, BigBox, …) via a `HOMEDEPOT_API_KEY` set on the server. **Without a working
> key/provider, pricing is unavailable** — the takeoff still returns quantities, and `pricing` comes
> back `{ "ok": false, "reason": "pricing_unavailable" }`. There is no baked price catalog.
>
> **Provider status:** switched to **SerpApi** (verified working end-to-end) after BigBox's outage —
> it activates when the SerpApi key is set on the server. Until then, `price=true` returns an
> unavailable `pricing` block. Treat pricing as optional and degrade gracefully — the response shape
> below is final regardless of which provider is behind it.

**Pricing parameters** are in §3.C (`price`, `tier`, `markupPct`, `laborPct` / `laborCost`).

**Pricing response** — a `pricing` object added to the takeoff (quantities are unchanged). Fields:

| Field | Type | What it is |
|---|---|---|
| `ok` | boolean | `true` if pricing succeeded. **Render the pricing block only when this is `true`.** |
| `reason` | string | Present when `ok:false` (e.g. `pricing_unavailable`). |
| `source` | string | `homedepot_live` (or `mock` in dev). |
| `currency` | string | `USD`. |
| `tier` / `tier_label` | string | The tier used + its label. |
| `lines` | array | Priced material lines: `key`, `label`, `order_qty`, `order_unit`, `unit_price`, `line_cost`, `product_title`, `product_url`. |
| `unpriced_lines` | array | Lines the price service couldn't match, each with a `reason`. |
| `fully_priced` | boolean | `false` if any line landed in `unpriced_lines`. |
| `labor` | object | `{ basis, pct_of_materials, cost }`. |
| `profit_layout` | object | `materials_cost`, `labor_cost`, `total_cost`, `markup_pct`, `price`, `profit`, `margin_pct`. |
| `disclaimer` | string | States prices are a live budgetary estimate, not a quote. |

Example `takeoff.pricing`:

```jsonc
{
  "ok": true,
  "source": "homedepot_live",          // or "mock" in dev
  "currency": "USD",
  "tier": "better", "tier_label": "Better — mid-grade",
  "lines": [
    { "key": "thinset", "label": "Thinset mortar", "tier": "better",
      "order_qty": 4, "order_unit": "50 lb bag", "price_unit": "50 lb bag",
      "unit_price": 18.0, "line_cost": 72.0, "priced": true,
      "product_title": "...", "product_url": "https://homedepot.com/p/..." }
    // ...one per material line
  ],
  "unpriced_lines": [ /* lines the price service couldn't match, with a reason */ ],
  "fully_priced": true,
  "labor": { "basis": "pct_of_materials", "pct_of_materials": 100, "cost": 10382.0, "note": "..." },
  "profit_layout": {
    "materials_cost": 10382.0,
    "labor_cost":     10382.0,
    "total_cost":     20764.0,
    "markup_pct":     20,          // applied markup
    "price":          24916.80,    // what the client pays
    "profit":         4152.80,     // price − total_cost
    "margin_pct":     16.7         // profit ÷ price (the margin that markup implies)
  },
  "disclaimer": "Prices are LIVE from a third-party Home Depot pricing API ... budgetary estimate, not a quote ..."
}
```

Notes:
- **Each priced line links the matched product** — `product_url` (a public `www.homedepot.com`
  product page) + `product_title`. Deep-link these from the UI so the contractor can view/buy the item.
- **Both lenses are shown**: `markup_pct` (the input) and `margin_pct` (the implied gross margin).
- **Made-to-measure lines** (cabinets, countertop, vanity) are priced per LF/sqft as a **rough budget**
  and carry `field_estimate: true` — never a quote.
- A price-service outage or unmatched line **never fails the request**: those lines land in
  `unpriced_lines`, `fully_priced` goes `false`, and the rest still totals.
- Fixtures (plumbing/electrical rough-in) are **not** individually priced — they're the install
  scope covered by the labor line.

```bash
# priced takeoff, premium tier, 25% markup, labor = 90% of materials
curl -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff \
  -H "Content-Type: application/json" \
  -d '{"projectType":"kitchen_remodel","kitchenSqft":200,"price":true,"tier":"best","markupPct":25,"laborPct":90}'
```

---

## 5. Errors

Bad/missing input returns **HTTP 400** with a clear JSON message (never a 200 with garbage).

| Case | Status | `error` |
|---|---|---|
| Missing/invalid `kitchenSqft`, bad enum, negative number | `400` | `invalid_input` |
| Missing `projectType` | `400` | `missing_project_type` |
| Unsupported `projectType` (e.g. `"bathroom"`) | `400` | `unsupported_project_type` |
| Malformed JSON body | `400` | `invalid_json` |
| Unknown route | `404` | `not_found` |
| Too many requests (per-client rate limit) | `429` | `rate_limited` |

**Rate limiting:** requests are limited **per client IP** (default **120 / 60s**; `/health` is
exempt). Over the limit returns **HTTP 429** `{ "ok": false, "error": "rate_limited", "retry_after_s": N }`
with a `Retry-After` header. Every response also carries `X-RateLimit-Limit` / `-Remaining` / `-Reset`
so a client can self-throttle. **Back off and retry after `Retry-After` seconds on a 429.**

```jsonc
// POST {"projectType":"kitchen_remodel"}  →  HTTP 400
{ "ok": false, "error": "invalid_input",
  "message": "Missing required field \"kitchenSqft\" (Kitchen FLOOR area in square feet. ...)" }
```

Always branch on `ok` and check the HTTP status.

---

## 6. Integration examples

**JavaScript / BuildSuite frontend (fetch):**

```js
const BASE = "https://house-intelligence-production-f7f6.up.railway.app";

async function getTakeoff(input) {
  const res = await fetch(`${BASE}/material-takeoff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectType: "kitchen_remodel", ...input }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.message || "takeoff failed");
  return data; // { materials, fixtures_checklist, derived, disclaimer, ... }
}

// usage
const t = await getTakeoff({ kitchenSqft: 200, tileLayout: "diagonal", floorTile: false });
t.materials.forEach(m => console.log(m.label, "→", m.order_qty, m.order_unit));
```

**Rendering with pricing (defensive — handles the provider being unavailable):**

```js
// Request pricing by adding price=true (+ tier/markupPct/laborPct). Everything else is the same.
const t = await getTakeoff({
  kitchenSqft: 200,
  price: true, tier: "better", markupPct: 20, laborPct: 100,
});

// ALWAYS render quantities — they're always present.
renderMaterials(t.materials);
renderChecklist(t.fixtures_checklist);

// Render pricing ONLY when it succeeded. Right now (provider outage) this will be false —
// your UI should show a "pricing unavailable" state, NOT an error. No code change needed
// when pricing turns back on.
if (t.pricing?.ok) {
  renderProfitLayout(t.pricing.profit_layout);      // materials/labor/cost/markup/price/profit/margin
  renderPricedLines(t.pricing.lines);               // per-line unit_price + line_cost
  if (!t.pricing.fully_priced) {
    // Some lines couldn't be matched — show them as "price n/a", still total the rest.
    flagUnpriced(t.pricing.unpriced_lines);
  }
} else {
  showPricingUnavailable(t.pricing?.reason);        // e.g. "pricing_unavailable"
}
```

> Key rule: **quantities and pricing are independent.** A `price=true` call never fails because of
> pricing — you still get `t.ok === true` with full quantities; only `t.pricing.ok` reflects whether
> prices came through.

**Build the input form dynamically:**

```js
const { project_types } = await (await fetch(`${BASE}/material-takeoff/project-types`)).json();
const kitchen = project_types.find(p => p.id === "kitchen_remodel");
// kitchen.required_inputs + kitchen.optional_inputs  → render fields with types/defaults
```

**curl (the validation check — should be 400):**

```bash
curl -i -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff \
  -H "Content-Type: application/json" -d '{"projectType":"kitchen_remodel"}'
```

---

## 7. Limitations (what it does NOT do — yet)

1. **Two project types** — `kitchen_remodel` and `bathroom_remodel`. Any other `projectType` → 400.
   (More types are data-driven to add; see the roadmap.)
2. **Estimates, not measurements.** Quantities are derived from floor area. The wall-perimeter model
   is now **shape-aware** (`roomShape`: square → u_shaped, plus kitchen `island`), but it's still an
   estimate — for accuracy pass the known-measurement overrides (`cabinetLF`, `countertopSqft`,
   `wallPerimeterLF`) whenever you have them; an exact `wallPerimeterLF` always wins over `roomShape`.
3. **Cabinets & countertops are made-to-measure.** Their LF/sqft are scoping numbers only —
   **field-verify before ordering** (the API flags these with `field_verify: true`).
4. **Cabinet model is calibrated for typical ~80–300 sqft kitchens** (0.20 LF/sqft). Very large
   kitchens or island-heavy layouts should use the `cabinetLF` override.
5. **Pricing is opt-in and estimate-grade.** Add `price=true` (§4b) for live Home Depot prices +
   a profit layout — but it needs a `HOMEDEPOT_API_KEY` (no key → no prices), prices are matched to
   a per-tier **search term, not your exact SKU**, and labor defaults to a rough rule of thumb. It's
   a budgetary estimate, not a quote.
6. **Tile & countertop default to sqft — pass the pack size to get boxes/slabs.** Provide
   `floorTileBoxSqft` / `backsplashTileBoxSqft` / `wallTileBoxSqft` (and `countertopSlabSqft` /
   `vanityTopSlabSqft`) and those lines round to whole **boxes/slabs** (`pack_round`) and **price per
   box/slab** (which fixes the per-case pricing over-count). Without a pack size, tile stays in sqft.
   Consumables (thinset/grout/compound/tape/screws) are always in whole purchasable units.
7. **Conservative by design ("no shortage" > "no waste").** It rounds up and uses the high end of
   waste bands / low end of coverage — so it may slightly over-order on purpose.
8. **One `tileLayout` for both floor and backsplash.** Can't yet specify different layouts per
   surface, and grout adjusts only for `mosaic` (not arbitrary tile sizes/joint widths).
9. **The rough-in checklist is a checklist, not a code-compliance tool.** It uses NEC/standard
   rules of thumb; actual permits and local code vary. Romex footage is a rough estimate, and the
   range circuit assumes electric (gas not yet an input).
10. **Extra scope is opt-in (§3.D).** Demolition, subfloor, paint, trim and hardware are available as
    add-on groups but default to **off** — turn them on per job. Still **not** covered: appliances,
    permits, and labor as line items (labor appears only as a rough % in the pricing profit layout).
11. **Drywall assumes a full re-rock** of walls (perimeter × height − openings). Patch-only jobs
    will be over-estimated — use `wallPerimeterLF`/`includeCeiling` to tune.
12. **No auth or persistence yet** (rate limiting IS in place — per-client IP, HTTP 429 over the
    limit; see §5). Still stateless and public — add API-key auth + persistence before billing it as a
    paid add-on. Note the limiter is in-memory per process, so a multi-instance deploy multiplies the
    effective limit (move the counter to Redis/Supabase when you scale out).

The output always carries a `disclaimer` field restating that it's an order-ready *starting point*,
not a substitute for field measurement.

---

## 8. Next steps (roadmap)

**Product**
- **More project types** — **bathroom remodel shipped ✅.** Next: flooring-only, whole-room drywall,
  whole-home. The engine now dispatches per-type via pluggable builders (`builders/<type>.js`) driven
  by a `project_type` block in `material_dataset.json` — a new type is a dataset block + a builder.
- **Pricing layer — shipped (§4b):** live Home Depot pricing (third-party API), good/better/best
  tiers, and a markup+margin profit layout with a labor line. Next: exact-SKU pinning, price
  caching/refresh, and a per-line vendor-pack-size mapping so tile prices are per-box not per-sqft.
- **Vendor pack-size rounding** — return tile boxes / slab counts, not just sqft.
- **Per-surface tile layout** + a tile-size input feeding grout/thinset more precisely.
- **Appliance inputs** (gas vs electric range, microwave type) to branch the electrical checklist.
- **PDF / printable order sheet** for the contractor and the supplier.

**Platform / productionization (before charging for it inside BuildSuite)**
- **Auth (API key) + rate limiting + request logging.**
- **Persistence** — save takeoffs per project/customer (currently stateless).
- **Custom domain** for the Railway service (cosmetic; rename in Settings → Networking).
- **Calibration loop** — feed back actual ordered-vs-used quantities from real jobs to tune the
  waste factors.

**BuildSuite integration**
- Wire the dynamic form off `GET /material-takeoff/project-types`.
- Let contractors enter known `cabinetLF` / `countertopSqft` (the API already accepts them) so the
  made-to-measure lines become real.
- Surface `basis` + `disclaimer` + the `field_verify` flags in the UI for trust.

---

_Engine + API are unit-tested (59 engine + 46 bathroom + 19 room-shape + 23 pack-size + 29 add-ons +
61 pricing + 24 rate-limit + 37 HTTP tests = 298). Standards are sourced in `material_dataset.json`
`_meta`. House Intelligence is untouched — separate service, shared repo._

