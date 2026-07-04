# House Intelligence — Project Knowledge Base

_Single-source reference for the House Intelligence product. Compiled 2026-06-23 from the
codebase + project history. Keep this updated as the project evolves._

---

## 1. What it is (in one line)

A contractor enters a job **address**, and the system automatically adds the right **inspection
items** to the scope of work based on the home's **build year + region** — so the contractor
"looks like an expert before they ever visit the site."

It is a **capability for BuildSuite**, the scope-of-work / proposal generator on the
**Alliance for Contractors** platform. Internally tracked as **"Priority #2."**

---

## 2. Why it matters (business case)

- **Differentiator:** nobody else in the space auto-scopes inspections from a build year. Hard
  for competitors to copy because the value is in the **researched dataset + logic**, not the wiring.
- **Sales surface:** sold as a paid capability inside BuildSuite; later potential for a
  **commercial or even government** sale (drives the licensing constraints in §8).
- **Foundation:** it's the base for a planned **Material Takeoff** add-on (#5 spin-off, already
  prototyped — see §7).

### The spec (Chris's words)
> We create a dataset of construction eras by region — knob and tube wiring, cast iron plumbing,
> aluminum wiring years, panel types — and load it into the knowledge base. Then when a contractor
> enters a job address, the scope of work automatically includes the right inspection items based
> on the year the house was built. The contractor looks like an expert before they ever visit the
> site. Nobody else in this space has that.

---

## 3. People & ecosystem

| Who / what | Role |
|---|---|
| **Chris** | Product owner — names the product, sees commercial + government potential ("Intelligence" branding). |
| **JC** | Authored the "Dataset Blueprint (#2)" (2026-06-12) that the engine aligns to (categories, severity, region+era rows). |
| **Sing** | Maintains **BuildSuite** — the integration target for proposal output. |
| **Kairo** | Produces the proposals that the inspection items must flow into. |
| **Alliance for Contractors** | The platform. **BuildSuite** is its scope-of-work / proposal generator. |

**Product name:** TBD — Chris's call. Placeholders seen: **SiteIQ** / **House Intelligence**.

---

## 4. Architecture at a glance

The hard part is the **data + the logic**, not the plumbing. Both are built and tested.

```
address ──► address_provider.js ──► build year ──► lookup_engine.js ──► scope of work
            (vendor-agnostic seam)                  (era_dataset.json)    (inspection items,
                                                                           categories, severity,
                                                                           high-priority flags,
                                                                           region+era row)
```

| File | What it is |
|---|---|
| `era_dataset.json` | **The knowledge base.** 9 era bands × 10 systems + 5 regional modifiers. Has `_meta` with sources + disclaimer. |
| `lookup_engine.js` | **The brain.** `buildScope({ year, state, metro })` → structured scope. Has a CLI + CSV export. |
| `address_provider.js` | **The address layer.** Vendor-agnostic `resolveBuildYear(address)` seam + mock adapter + **live RentCast adapter** (`createRentcastProvider`) + cache + `resolveScopeForAddress()`. |
| `server.js` | **Zero-dependency HTTP API** (Node core `http` only). Wraps the engine for BuildSuite to call. |
| `test_engine.js`, `test_address_provider.js`, `test_alignment.js`, `test_server.js` | **149 tests, all passing.** |
| `Dockerfile`, `Procfile`, `.env.example` | Deploy/run config. |
| `material-takeoff/` | **Sibling module** (#5 spin-off) — separate folder, own server/dataset/tests. See §7. |

Stack: **Node ≥14, zero npm dependencies** (no framework, no `npm install`). License: `UNLICENSED` / private.

---

## 5. The dataset (`era_dataset.json`)

- **Scope:** `national_us`. Top-level keys: `_meta`, `era_bands`, `regional_modifiers`.
- **9 era bands:** pre-1900 → 2010-present. For each band, across **10 systems**, it records
  what's *likely present* and what to *inspect for*.
- **10 systems:** electrical, plumbing_supply, plumbing_waste, panel, hazards, foundation,
  heating, insulation, roofing, windows.
- **6 categories** (the blueprint's Layer 2, via `category_map`):
  - Electrical ← electrical, panel
  - Plumbing ← plumbing_supply, plumbing_waste
  - Structural ← foundation
  - HVAC ← heating
  - Hazards ← hazards
  - Envelope ← insulation, windows, roofing
- **5 regional modifiers:** Pacific NW, Seismic West, Gulf/Southeast, Cold Northeast/Midwest,
  Arid Southwest — add location-specific items on top of the national era pattern.
- **Severity:** every item carries **High / Medium / Low**; each region+era row rolls up to its
  highest item severity. Assigned by the engine's `classifySeverity()` classifier so it stays
  consistent across eras without hand-tagging.

### Era boundaries were researched, not guessed (with sources)
- Knob-and-tube fading by ~1930s
- Aluminum branch wiring ~1965–1973
- Polybutylene late-1970s → mid-1990s
- Lead paint banned **1978** (CPSC)
- Lead pipe/solder banned **1986** (Safe Drinking Water Act / EPA Lead & Copper Rule)
- Chinese drywall 2001–2009

**Sources in `_meta`:** InspectAPedia (old electrical wiring history); ASHI "A Brief History of
Pipes"; UL / David Dini wiring history; EPA Lead & Copper Rule + SDWA 1986; CPSC lead paint ban
1978; field-practice timelines (Mike Holt / IAEI forums) for transition years.
`_meta.last_reviewed`: 2026-06-12.

---

## 6. The engine + API

### `lookup_engine.js` returns a structured scope
`buildScope({ year, state, metro })` →
- `inspection_items` — deduped list
- `categories` — items grouped into the 6 blueprint categories
- `severity` — per item + overall row severity
- `high_priority_flags` — every High item (knob-and-tube, aluminum wiring, Federal Pacific/Zinsco
  panels, lead service line, lead paint, asbestos, polybutylene, Chinese drywall, unreinforced
  masonry, buried oil tanks, seismic)
- `row` — blueprint-style region+era row (e.g. `SEA-1930`, `LA-1965`)
- `systems` — the likely-present systems

CLI: `node lookup_engine.js 1945 WA` · `node lookup_engine.js --rows SEA` (CSV grid).

### Canonical worked example — **1945 WA** (1940s Seattle)
Era 1930–1949 + Pacific NW + Seismic West → **37 inspection items, 16 high-priority, overall
severity High, blueprint row `SEA-1930`.** Surfaces remaining knob-and-tube, galvanized supply at
end-of-life, lead solder, possible lead service line, lead paint, asbestos, plus regional seismic
items (foundation bolting, cripple-wall bracing, unreinforced masonry, buried oil tanks).

### HTTP API (`server.js`, deployable)
Zero-dependency; CORS open (`*`) so a browser frontend can call it. `npm start` → `:3000`
(hosts inject `PORT`).

| Method & path | Purpose |
|---|---|
| `GET /` | API index + usage (JSON) |
| `GET /health` | liveness → `{ status: "ok" }` |
| `GET /scope?year=1945&state=WA&metro=SEA` | scope for a known build year |
| `GET /scope?address=<full address>` | resolve address → year → scope (via provider) |
| `POST /scope` | JSON `{ year, state, metro }` **or** `{ address }` |
| `GET /rows?region=SEA` | blueprint Layer-1 region+era grid (JSON) |

Add `&format=text` / `"format":"text"` for the rendered scope block. **Provider auto-selects:**
set `RENTCAST_API_KEY` → live RentCast adapter; unset → bundled MockProvider (API still runs
end-to-end). No code change to go live; `GET /` reports the active adapter under `vendor_adapter`.
Deploy via `Dockerfile`/`Procfile` (Render/Railway/Fly/Heroku read `PORT`).

### Alignment with JC's Dataset Blueprint (#2)
| Blueprint | Where it lives |
|---|---|
| Layer 1 — region+era row | `buildEraRow()` / `scope.row`; grid via `buildRegionGrid()` / `--rows` |
| Layer 2 — 6 categories | `CATEGORY_OF` + `scope.categories` + `_meta.category_map` |
| Layer 2 — High/Med/Low severity | `classifySeverity()` + `scope.severity` |
| Layer 3 — sample rows | `SEA-1930` / `LA-1965` (band-based ids; content matches `SEA-1940`/`LA-1968`) |
| Layer 4 — address → year → era → items | `address_provider.js` |

**Deliberate design choice:** store the national era pattern **once** and layer regional modifiers
on top, then **generate** the blueprint's flat per-region rows on demand — JC still gets the exact
Layer-1 table/CSV, with no hand-copied duplication.

**Two known band-vs-blueprint notes:** (1) era bands are research-driven (e.g. 1930–1949) so row
ids use the band start (`SEA-1930`) not the decade label (`SEA-1940`) — content matches.
(2) **Regional items aren't yet era-gated** — a new Seattle build still shows seismic items and
reads "High." Era-gating regional modifiers is the clean next refinement.

---

## 7. Material Takeoff (#5 spin-off — `material-takeoff/`)

A **fully separate** sibling module in the same repo: own folder, `server.js`, `package.json`,
tests. Same engine pattern (JSON rules + deterministic engine + tests), pointed at a different
question.

| | House Intelligence | Material Takeoff |
|---|---|---|
| Question | What to **inspect**? | What to **buy**? |
| Input | property → build year | project scope + size |
| Output | era-based inspection items | a quantified material order list |

- **Business goal:** a paid BuildSuite add-on telling a contractor exactly what materials to order
  — **no waste, no shortage** — as an auditable starting point.
- **v1 covers one project type: `kitchen_remodel`.**
- **API** (default port **3100**, so it runs next to House Intelligence's 3000):
  - `GET /material-takeoff/project-types` — fields/types/defaults so BuildSuite renders the form
  - `POST /material-takeoff` — body `{ projectType, kitchenSqft, ...optional }` → per-material
    **order qty + raw measurement + waste %** (auditable) + fixtures/rough-in checklist
  - Bad input → **HTTP 400** with clear JSON (never a 200 with garbage)
  - `test-page.html` — standalone browser form for demos
- **Estimating standards** live in `material_dataset.json` (sourced in `_meta`): cabinets
  `0.20 LF/sqft` split 60% base / 40% upper (made-to-measure → field-verify); countertop +15%
  solid / +25% veined; tile waste straight 7% / diagonal 15% / herringbone-mosaic 20%; thinset
  75 sqft/bag (conservative); drywall 15% kitchen waste; etc.
- **Same principles:** order-ready **starting point, not a substitute for field measurement**;
  cabinets + countertops are made-to-measure (always field-verify); **show the math.**

---

## 8. Address → build-year: the data-source decision

The spec hinges on "contractor enters a job **address**" — but the engine takes a *year*. Turning
address → build year needs a property-data API.

**Constraints (user's, as of 2026-06-12):** nationwide US · low volume (<1k lookups/mo) ·
**licensed paid API** with clean ToS for commercial + possible government resale · **build year
only** for now (richer fields later for Material Takeoff).

**Key insight:** the blocker is almost never coverage or price — nearly every vendor has
nationwide `yearBuilt` cheaply. The deciding factor is the **license**: can you surface the data
inside a *paid product* to customers? Two distinct asks:
- **(A)** embed build-year in BuildSuite for contractor customers — near-term
- **(B)** resell raw data to a government agency — later, bigger

**Recommendation: RentCast.** The only self-serve license that *explicitly* permits "display,
resale and distribution… to third parties." Nationwide; `response[0].yearBuilt`; `X-Api-Key`
header; `GET https://api.rentcast.io/v1/properties?address=<Street, City, State, Zip>`. Free
50/mo, then ~$74/mo (1,000 calls). **Gap:** ToS is silent on government end-use — get it in
writing before (B).

| Vendor | Verdict |
|---|---|
| **RentCast** | ✅ Recommended — only self-serve license explicit on resale/distribution. |
| **Smarty US Property** | Best gov-ready alt — explicitly licenses to US Gov as "Commercial Items"; `attributes.year_built`; ~$350/yr. |
| **ATTOM** | Gold-standard data, but evaluation-only default terms, no self-serve, **forbids caching >24h** — reserve for enterprise/scale. |
| BatchData / Estated / CoreLogic-ICE-FirstAmerican | Ruled out for low-volume self-serve. |

**Current state (2026-06-24):** RentCast picked, and the **live adapter is now built and tested.**
`address_provider.js` ships `resolveBuildYear(address)` + deterministic MockProvider + **`createRentcastProvider`
(live)** + `withCache` decorator + `resolveScopeForAddress`. The adapter is zero-dependency (built-in
HTTPS shim, so it runs on Node ≥14 without a global `fetch`), maps RentCast's array/`yearBuilt`/`state`
response to the `BuildYearResult` contract, and turns auth/rate-limit/network failures into graceful
`ok:false` reasons (never throws). `server.js` **auto-activates it when `RENTCAST_API_KEY` is set**,
else falls back to the mock. The verified Smarty/ATTOM contracts remain documented in the adapter guide
for later. **Remaining to go fully live:** (1) add a real `RENTCAST_API_KEY` to `.env`; (2) per the
standing rule, make one real call to confirm the live response shape matches the adapter's assumptions
(`response[0].yearBuilt`) before relying on it in production — **don't guess the schema.**

---

## 9. Roadmap (priority order)

| # | Item | Status |
|---|---|---|
| 1 | **Address → build year** via property-data API (RentCast) | ✅ Live adapter built & tested — activates on `RENTCAST_API_KEY`; pending a real key + one live-schema confirmation call |
| 2 | **Wire engine output into BuildSuite** scope-of-work / proposal generator (Sing + Kairo) | ⬜ Needs Sing |
| 3 | **Product name** (Chris's "Intelligence" branding) | ⬜ Chris's call |
| 4 | **Data depth pass** — deepen high-value regions (esp. Pacific NW / Seattle, the home market); era-gate regional items | ⬜ Additive, anytime |
| 5 | **Material Takeoff** spin-off | Prototyped (kitchen_remodel v1) |

### Status snapshot (built ✅)
Era dataset (9 bands × 10 systems) · 5 regional modifiers · lookup engine · blueprint alignment
(6 categories, severity, region+era rows, CSV grid) · spec example (1940s Seattle) · 149/149 tests ·
zero-dep HTTP API + Docker/Procfile (deployable) · address provider interface + mock + live RentCast adapter.

---

## 10. Standing principles (preserve these)

- **"Likely / inspect for", NEVER "guaranteed present."** Keep the disclaimer in every output —
  homes get re-piped, re-wired, renovated. Use to *prompt* inspection, not assert condition.
- **"National" = documented era patterns with regional shading**, not one downloadable database.
  There is no single file that says "house built year X has system Y." Codify well-documented
  national era norms; that's the honest, defensible v1.
- **Era boundaries are approximate and overlapping** — adoption was gradual and regional. Frame
  bands as "transition" where appropriate.
- **Confirm live schemas before writing vendor adapters** — don't guess request/response shapes.
- **(Material Takeoff) Show the math + field-verify** made-to-measure items; output is an
  order-ready starting point, not a substitute for field measurement.

---

## 11. Quick facts / cheat-sheet

- **Repo:** `c:\Users\John\ProgrammingProjects\house-intelligence-`
- **Run engine:** `node lookup_engine.js 1945 WA`
- **Run address flow:** `node address_provider.js "1730 Minor Ave, Seattle, WA 98101"`
- **Run API:** `npm start` → `http://localhost:3000` (Material Takeoff: `cd material-takeoff && npm start` → `:3100`)
- **Test:** `npm test` (149 tests)
- **Go live:** put a real key in `.env` as `RENTCAST_API_KEY=...` → server auto-uses the live RentCast adapter (no code change)
- **Canonical example:** 1945 WA → 37 items, 16 high-priority, severity High, row `SEA-1930`
- **Dependencies:** none (Node ≥14 core only)
- **License posture:** RentCast = self-serve resale OK; Smarty = gov-ready; ATTOM = no caching >24h
```
