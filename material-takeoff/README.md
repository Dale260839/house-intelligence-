# Material Takeoff

_A sibling module to **House Intelligence**, living in the same repo. Same engine pattern
(a JSON dataset of rules + a deterministic lookup engine + tests) and the same zero-dependency
Node HTTP stack — pointed at a different question._

| | House Intelligence | **Material Takeoff** |
|---|---|---|
| Question | What to **inspect**? | What to **buy**? |
| Input | property → build year | project scope + size |
| Output | era-based inspection items | a quantified material order list |

**Business goal:** a paid add-on inside **BuildSuite** that tells a contractor exactly what
materials to order for a project — **no waste, no shortage** — as an auditable starting point.
BuildSuite calls this over HTTP (JSON in/out, CORS enabled). **v1 covers one project type:
`kitchen_remodel`.**

> This module is **fully separate** from House Intelligence: its own folder, its own
> `server.js`, its own `package.json`. It shares the repo, not the other module's files.
> House Intelligence is untouched.

---

## Files

| File | What it is |
|---|---|
| `material_dataset.json` | The knowledge base: rates, waste factors, coverage rates, the input form contract, and the fixtures checklist — with `_meta` sources + disclaimer. |
| `takeoff_engine.js` | The brain: takes a project type + measurements, returns the order-ready quantities (raw + waste % + final order) and the rough-in checklist. Deterministic, dependency-free, unit-tested. Has a CLI. |
| `server.js` | Thin HTTP layer over the engine — **same pattern/stack as House Intelligence's `server.js`** (Node core `http`, manual CORS, JSON errors). |
| `test_engine.js` | Engine tests (leads with the canonical 200 sqft example). |
| `test_server.js` | HTTP API tests over the wire. |
| `test-page.html` | Standalone browser test page (a form that calls `POST /material-takeoff`). |
| `Procfile`, `Dockerfile`, `.gitignore`, `package.json` | Deploy/run config, mirroring House Intelligence. |

---

## Run it

Zero dependencies — no `npm install` needed.

```bash
cd material-takeoff

# engine, as text (the canonical example)
node takeoff_engine.js 200

# engine, as JSON
node takeoff_engine.js 200 --json

# tests
npm test            # node test_engine.js && node test_server.js

# the API (defaults to port 3100 so it can run next to House Intelligence's 3000)
npm start           # node server.js
```

Then open **`test-page.html`** in a browser (it defaults to `http://localhost:3100`) to demo
the form, or call the API directly (below).

---

## API

JSON in / JSON out. **CORS is enabled** (`Access-Control-Allow-Origin: *`) so BuildSuite can call
it from the browser. Errors come back as clean JSON with a proper status code.

### `GET /material-takeoff/project-types`

Returns the supported project types and, for each, the **required + optional input fields with
types and defaults** — so BuildSuite can render a form dynamically.

```bash
curl http://localhost:3100/material-takeoff/project-types
```

```jsonc
{
  "ok": true,
  "count": 1,
  "project_types": [
    {
      "id": "kitchen_remodel",
      "label": "Full Kitchen Remodel",
      "summary": "...",
      "required_inputs": [
        { "name": "kitchenSqft", "type": "number", "unit": "sqft", "min": 1, "description": "..." }
      ],
      "optional_inputs": [
        { "name": "ceilingHeight",   "type": "number",  "default": 8,          "unit": "ft",  "description": "..." },
        { "name": "tileLayout",      "type": "enum",    "default": "straight", "allowed": ["straight","diagonal","herringbone","mosaic"], "description": "..." },
        { "name": "floorTile",       "type": "boolean", "default": true,       "description": "..." },
        { "name": "countertopType",  "type": "enum",    "default": "solid",    "allowed": ["solid","veined"], "description": "..." },
        { "name": "openings",        "type": "number",  "default": 2,          "unit": "count", "description": "..." }
        // ...also: cabinetLF, baseCabinetLF, upperCabinetLF, countertopSqft, backsplashHeight, wallPerimeterLF, includeCeiling
      ]
    }
  ]
}
```

### `POST /material-takeoff`

Body: `{ "projectType": "kitchen_remodel", "kitchenSqft": 200, ...optional }`.
Returns the full takeoff: per-material **order quantity + raw measurement + waste %** (auditable),
plus the **fixtures / rough-in checklist**.

```bash
curl -X POST http://localhost:3100/material-takeoff \
  -H "Content-Type: application/json" \
  -d '{"projectType":"kitchen_remodel","kitchenSqft":200}'
```

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
  "materials": [
    { "key": "base_cabinets", "label": "Base cabinets", "type": "made_to_measure",
      "raw": 24, "raw_unit": "LF", "waste_pct": 0, "order_qty": 24, "order_unit": "LF",
      "field_verify": true, "basis": "0.2 LF/sqft total x 60% base", "note": "..." },

    { "key": "countertop", "label": "Countertop slab (solid)", "type": "waste_factor",
      "raw": 24, "raw_unit": "sqft", "waste_pct": 15, "order_qty": 28, "order_unit": "sqft",
      "field_verify": true, "basis": "1 sqft per base LF (24 LF)", "note": "..." },

    { "key": "thinset", "label": "Thinset mortar", "type": "coverage",
      "raw": 236, "raw_unit": "sqft", "coverage": 75, "coverage_unit": "sqft/bag",
      "order_qty": 4, "order_unit": "50 lb bag", "waste_pct": null, "basis": "...", "note": "..." }
    // ...upper_cabinets, backsplash_tile, floor_tile, grout, drywall_sheets, joint_compound, drywall_tape, drywall_screws
  ],
  "fixtures_checklist": {
    "plumbing":   [ { "item": "Kitchen sink", "qty": 1, "unit": "ea", "note": "..." }, ... ],
    "electrical": [ { "item": "GFCI counter receptacles", "qty": 6, "unit": "ea", "note": "..." }, ... ]
  },
  "summary": "Full Kitchen Remodel — 200 sqft: 11 material lines quantified ...",
  "field_verify_items": ["base_cabinets","upper_cabinets","countertop"],
  "disclaimer": "This is an order-ready STARTING POINT ... NOT a substitute for field measurement ..."
}
```

A `GET /material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&...` form is also available
(handy from a browser). Add `&format=text` (GET) or `"format":"text"` (POST) for a rendered text block.

### Validation / errors

Bad or missing input returns **HTTP 400** with a clear JSON message — never a 200 with garbage.

```bash
curl -i -X POST http://localhost:3100/material-takeoff \
  -H "Content-Type: application/json" -d '{"projectType":"kitchen_remodel"}'
# HTTP/1.1 400 Bad Request
# { "ok": false, "error": "invalid_input",
#   "message": "Missing required field \"kitchenSqft\" (Kitchen FLOOR area in square feet. ...)" }
```

| Case | Status | `error` |
|---|---|---|
| Missing/invalid `kitchenSqft`, bad enum, negative number | `400` | `invalid_input` |
| Missing `projectType` | `400` | `missing_project_type` |
| Unsupported `projectType` | `400` | `unsupported_project_type` |
| Invalid JSON body | `400` | `invalid_json` |
| Unknown route | `404` | `not_found` |

Other routes: `GET /` (index + usage), `GET /health` (liveness probe).

---

## How the quantities are derived (the estimating standards)

Every line reports its **raw** measurement and the **waste %** (or **coverage rate**) so the
order quantity is auditable. Rates live in `material_dataset.json` and are sourced in its `_meta`.

| Material | Basis | Waste / coverage |
|---|---|---|
| **Base / upper cabinets** | `0.20 LF per sqft` of floor → split **60% base / 40% upper**. Calibrated so 200 sqft → **40 LF** and 100 sqft → 20 LF, and so larger kitchens are **not under-counted** (scales with floor area, not perimeter). | **Made-to-measure → no waste factor.** Always **field-verify**. |
| **Countertop** | `~1.0 sqft finished per base LF`. | Raw slab **+15% solid / +25% veined**. **Field-verify.** |
| **Backsplash tile** | `base LF × backsplash height` (18 in default). | Tile waste by layout. One dye lot. |
| **Floor tile** | `= floor sqft` when `floorTile` is on. | Tile waste by layout. |
| **Tile waste** | — | straight **7%**, diagonal **15%**, herringbone/mosaic **20%** (top of each sourced band, for no-shortage). |
| **Thinset** | substrate set = backsplash + floor sqft. | **75 sqft / 50 lb bag** (the conservative end — _not_ 90+, which risks under-ordering). |
| **Grout** | tiled area. | **100 sqft / 25 lb bag** (50 for mosaic / small tile). |
| **Drywall** | `perimeter × ceiling − openings` (+ ceiling if asked), `/32 sqft` per 4×8 sheet. | **15% kitchen waste** (cutouts). |
| **Joint compound** | `30 lb per 100 sqft` (Level 4). | sold in ~61.7 lb buckets. |
| **Drywall tape** | wall area `/ 2 sqft per LF`. | 250 ft rolls. |
| **Drywall screws** | `32 per sheet`. | ~350 per 1 lb box. |
| **Fixtures / rough-in** | mostly fixed counts; GFCI receptacles scale to counter run (~1 per 4 base LF), under-cabinet lighting = upper LF, Romex estimated from circuit count. | a checklist, not a waste calc. |

### Principles (same as House Intelligence)

- The output is an **order-ready starting point, not a substitute for field measurement.**
- **Cabinets + countertops are made-to-measure — always field-verify before ordering those.**
- **Show the math** (raw + waste % + final order qty) so it is auditable.
