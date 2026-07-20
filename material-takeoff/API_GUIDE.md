# Material Takeoff API — Usage Guide

**Base URL:** `https://house-intelligence-production-f7f6.up.railway.app`

Give it a kitchen's scope + size, get back an **order-ready material list** — quantities that
already include standard waste factors, with the raw measurement and waste % shown so the math
is auditable. JSON in / JSON out, **CORS enabled** (callable from the browser). No API key.

> Sibling of the House Intelligence API (`/scope`, `/rows`), deployed as a separate service from
> the same repo. **v1 supports one project type: `kitchen_remodel`.**

---

## ⚠️ Current status — read first

- ✅ **Quantities are LIVE and stable.** `POST /material-takeoff` reliably returns the full material
  list + rough-in checklist. **Build the core UI against this now** — it won't change.
- 🟡 **Pricing (`price=true`) — the response contract is FINAL, but the live pricing provider is
  temporarily unavailable.** The third-party Home Depot pricing service (BigBox) is in an extended
  outage on their end; a switch to an alternate provider (SerpApi) is in progress. Until it's
  restored, a `price=true` call still returns **HTTP 200 with the full quantities**, but the
  `pricing` block comes back `{ "ok": false, "reason": ... }` (or with lines in `unpriced_lines`).
- 👉 **What this means for you:** build the pricing UI **defensively** — always render the quantities,
  and render the pricing/profit block **only when `data.pricing?.ok === true`**; otherwise show a
  graceful "pricing unavailable" state. **No frontend change will be needed when pricing turns back
  on** — the shape in §4b is already the final one. See the pricing-aware example in §6.

---

## 1. Quick start

```bash
curl -X POST https://house-intelligence-production-f7f6.up.railway.app/material-takeoff \
  -H "Content-Type: application/json" \
  -d '{"projectType":"kitchen_remodel","kitchenSqft":200}'
```

Or open the query form straight in a browser (human-readable text):

```
https://house-intelligence-production-f7f6.up.railway.app/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&format=text
```

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

## 3. Inputs

**Required**

| Field | Type | Unit | Notes |
|---|---|---|---|
| `projectType` | string | — | Must be `"kitchen_remodel"` (v1). |
| `kitchenSqft` | number | sqft | Kitchen **floor** area. Drives every derived quantity. Must be ≥ 1. |

**Optional** (sensible defaults; override when you know the real number)

| Field | Type | Default | Notes |
|---|---|---|---|
| `ceilingHeight` | number (ft) | `8` | Wall height for drywall. |
| `tileLayout` | enum | `straight` | `straight` (7%), `diagonal` (15%), `herringbone` (20%), `mosaic` (20%) — sets tile waste. |
| `floorTile` | boolean | `true` | Whether the floor is tiled. Set `false` for LVP / wood / existing floor. |
| `countertopType` | enum | `solid` | `solid` (+15% slab waste) or `veined` (+25%, pattern-matched). |
| `backsplashHeight` | number (in) | `18` | Backsplash height; `0` = no backsplash. |
| `openings` | number | `2` | Door/window openings, deducted from drywall (~15 sqft each). |
| `includeCeiling` | boolean | `false` | Add the ceiling to the drywall quantity. |
| `cabinetLF` | number (LF) | derived | Known **total** cabinet LF. Overrides the floor-area estimate; split 60/40 base/upper. |
| `baseCabinetLF` | number (LF) | derived | Known base LF (also drives countertop + backsplash). |
| `upperCabinetLF` | number (LF) | derived | Known upper LF (drives under-cabinet lighting length). |
| `countertopSqft` | number (sqft) | derived | Known **finished** countertop area. |
| `wallPerimeterLF` | number (LF) | derived | Known wall perimeter (else estimated as 4·√area). |

> **Always pass the known-measurement overrides when you have them** (`cabinetLF`,
> `countertopSqft`, `wallPerimeterLF`). The derived values are scoping estimates from a
> square-room model; real measurements make the takeoff accurate.

`GET /material-takeoff/project-types` returns this same list programmatically, so a UI can build
the form without hardcoding it.

---

## 4. Response shape

```jsonc
{
  "ok": true,
  "project_type": "kitchen_remodel",
  "inputs": { ...echoed inputs with defaults applied... },
  "derived": {                       // the geometry the estimate was built from
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

Every line is self-describing. There are three line `type`s, distinguished by how the order
quantity is reached:

| `type` | Means | Order math |
|---|---|---|
| `made_to_measure` | Cabinets — cut to fit | `order_qty = raw` (no waste factor); **`field_verify: true`** |
| `waste_factor` | Countertop, tile, drywall | `order_qty = raw × (1 + waste_pct/100)` |
| `coverage` | Thinset, grout, compound, tape, screws | `order_qty = ceil(raw ÷ coverage)` in whole purchasable units |

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
> **As of now the provider is being switched (BigBox outage → SerpApi), so `price=true` will return
> an unavailable/partial `pricing` block. Treat pricing as optional and degrade gracefully — the
> shape below is final and won't change when the provider is restored.**

**Pricing inputs** (all optional, sent alongside the normal takeoff inputs):

| Field | Type | Default | Notes |
|---|---|---|---|
| `price` | boolean | `false` | Turn pricing on. Everything below is ignored unless this is set. |
| `tier` | enum | `better` | `good` (builder grade), `better` (mid), `best` (premium). Picks which product/price per line. |
| `markupPct` | number (%) | `20` | Markup on total cost: `price = cost × (1 + markupPct/100)`. |
| `laborPct` | number (%) | `100` | Labor as a **percent of material cost**. Default 1:1 is a rough rule of thumb — override per job. |
| `laborCost` | number ($) | — | Explicit labor dollars. **Overrides `laborPct`** when given. |

**Pricing response** (`takeoff.pricing`):

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
- **Both lenses are shown**: `markup_pct` (the input) and `margin_pct` (the implied gross margin).
- **Made-to-measure lines** (cabinets, countertop) are priced per LF/sqft as a **rough budget** and
  carry `field_estimate: true` — never a quote.
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

1. **One project type.** v1 is `kitchen_remodel` only. Any other `projectType` → 400.
2. **Estimates, not measurements.** Quantities are derived from floor area via a square-room
   geometry model (`perimeter ≈ 4·√area`). Galley/L-shaped kitchens, islands, and odd layouts
   differ — pass the known-measurement overrides (`cabinetLF`, `countertopSqft`, `wallPerimeterLF`)
   when you have them.
3. **Cabinets & countertops are made-to-measure.** Their LF/sqft are scoping numbers only —
   **field-verify before ordering** (the API flags these with `field_verify: true`).
4. **Cabinet model is calibrated for typical ~80–300 sqft kitchens** (0.20 LF/sqft). Very large
   kitchens or island-heavy layouts should use the `cabinetLF` override.
5. **Pricing is opt-in and estimate-grade.** Add `price=true` (§4b) for live Home Depot prices +
   a profit layout — but it needs a `HOMEDEPOT_API_KEY` (no key → no prices), prices are matched to
   a per-tier **search term, not your exact SKU**, and labor defaults to a rough rule of thumb. It's
   a budgetary estimate, not a quote.
6. **Tile & countertop are returned in sqft, not vendor boxes/slabs.** Consumables
   (thinset/grout/compound/tape/screws) ARE in whole purchasable units; tile you still divide by
   your chosen tile's box coverage.
7. **Conservative by design ("no shortage" > "no waste").** It rounds up and uses the high end of
   waste bands / low end of coverage — so it may slightly over-order on purpose.
8. **One `tileLayout` for both floor and backsplash.** Can't yet specify different layouts per
   surface, and grout adjusts only for `mosaic` (not arbitrary tile sizes/joint widths).
9. **The rough-in checklist is a checklist, not a code-compliance tool.** It uses NEC/standard
   rules of thumb; actual permits and local code vary. Romex footage is a rough estimate, and the
   range circuit assumes electric (gas not yet an input).
10. **Materials scope is limited to the listed categories.** No demolition, subfloor, paint, trim,
    hardware, appliances, permits, or labor.
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
- **More project types** — bathroom remodel, flooring-only, whole-room drywall, etc. The engine is
  data-driven: add a `project_type` block to `material_dataset.json` (no engine rewrite).
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

_Engine + API are unit-tested (57 engine + 60 pricing + 24 rate-limit + 37 HTTP tests). Standards are
sourced in `material_dataset.json` `_meta`. House Intelligence is untouched — separate service, shared repo._

