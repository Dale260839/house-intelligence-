# House Intelligence API — Usage Guide

**Base URL:** `https://house-intelligence-production.up.railway.app`

Give it a property's **build year** (or an address) and it returns the **era-based scope of work** —
the inspection items a contractor should include, grouped into 6 categories, each flagged
High / Medium / Low, with the high-priority hazards called out. _"The contractor looks like an
expert before they ever visit the site."_

JSON in / JSON out, **CORS enabled** (callable from the browser). No API key.

> Sibling of the [Material Takeoff API](../material-takeoff/API_GUIDE.md) — House Intelligence says
> what to **inspect**, Material Takeoff says what to **buy**. Separate services, shared repo.

---

## 1. Quick start

By known build year:

```bash
curl "https://house-intelligence-production.up.railway.app/scope?year=1945&state=WA&metro=SEA"
```

By address (see the **mock-provider caveat** in §7 — only seeded demo addresses resolve today):

```bash
curl "https://house-intelligence-production.up.railway.app/scope?address=1730%20Minor%20Ave,%20Seattle,%20WA%2098101"
```

Human-readable text block (great for a proposal/email) — add `&format=text`:

```
https://house-intelligence-production.up.railway.app/scope?year=1945&state=WA&format=text
```

---

## 2. Endpoints

| Method & path | Purpose |
|---|---|
| `GET /scope?year=&state=&metro=` | Scope of work for a **known build year**. |
| `GET /scope?address=<full address>` | Resolve **address → year → scope** (via the address provider). |
| `POST /scope` | Same as GET, body-driven: `{ year, state, metro }` **or** `{ address }`. |
| `GET /rows?region=<STATE\|METRO>` | The blueprint region+era grid (one row per era band). |
| `GET /health` | Liveness probe → `{"status":"ok"}`. |
| `GET /` | API index + endpoint list. |

Add `&format=text` (GET) or `"format":"text"` (POST) to a `/scope` call for a rendered text block
instead of JSON.

---

## 3. Inputs

### `/scope` — year path

| Field | Type | Required | Notes |
|---|---|---|---|
| `year` | number | yes (year path) | 4-digit build year, e.g. `1945`. |
| `state` | string | optional | 2-letter code, e.g. `WA`. **Enables regional modifiers** (seismic, gulf, cold-climate, …). |
| `metro` | string | optional | Metro code for the blueprint row id + region label, e.g. `SEA`. A metro implies its state. |

Known metro codes: `SEA, PDX, SF, LA, SD, NYC, CHI, HOU, DAL, PHX, MIA, ATL, BOS`.

### `/scope` — address path

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string **or** object | yes (address path) | `"1730 Minor Ave, Seattle, WA 98101"` or (POST only) `{ line1, city, state, zip }`. |
| `metro` | string | optional | Override the inferred metro. (Metro is otherwise inferred from the city.) |

The address path resolves the year via the provider, then runs the exact same engine as the year
path. State + metro are inferred from the address.

### `/rows`

| Field | Type | Required | Notes |
|---|---|---|---|
| `region` | string | **yes** | A 2-letter state (`WA`) **or** a metro code (`SEA`). Auto-detected. |

---

## 4. Response shape — `/scope`

```jsonc
{
  "ok": true,
  "year": 1945,
  "state": "WA",
  "metro": "SEA",
  "era":   { "id": "1930_1949", "label": "1930–1949", "range": [1930, 1949] },
  "regions_applied": [
    { "id": "pacific_nw",   "label": "Pacific Northwest (WA, OR, N. ID)" },
    { "id": "seismic_west", "label": "Seismic West (CA, WA, OR, NV, AK)" }
  ],
  "severity": "High",                       // row-level rollup (highest item severity)
  "categories": {                           // the 6 blueprint buckets
    "Electrical": [ { "item": "Remaining knob-and-tube", "severity": "High", "source": "era:1930_1949" }, ... ],
    "Plumbing":   [ ... ], "Structural": [ ... ], "HVAC": [ ... ], "Hazards": [ ... ], "Envelope": [ ... ]
  },
  "high_priority_flags": [ "Remaining knob-and-tube", "Lead-based paint (assume present)", ... ],  // every High item
  "inspection_items":          [ "...", ... ],   // flat de-duped list of item strings
  "inspection_items_detailed": [ { "system": "...", "item": "...", "category": "...", "severity": "...", "source": "..." }, ... ],
  "region_specific_items":     [ "...", ... ],   // just the items added by regional modifiers
  "systems": { "electrical": { "likely": [...], "inspect_for": [...] }, ... },
  "row":     { "id": "SEA-1930", "region": "Seattle, WA", "era_start": 1930, "era_end": 1949,
               "electrical": "...; ...", "plumbing": "...", "structural": "...", "hvac": "...",
               "hazards": "...", "envelope": "...", "inspection_items": "...", "severity": "High" },
  "summary":    "Home built in the 1930–1949 era with Pacific Northwest + Seismic West regional factors: 37 inspection items added (overall severity High). 16 high-priority items flagged.",
  "disclaimer": "These are probabilistic era patterns for scoping inspections, NOT a guarantee ..."
}
```

For the **address path**, the response additionally includes:

```jsonc
{
  "address": { "line1": "1730 Minor Ave", "city": "Seattle", "state": "WA", "zip": "98101", "freeform": "..." },
  "build_year_source": { "source": "mock", "confidence": "exact", "resolved_year": 1945, "ok": true }
  // ...plus all the scope fields above
}
```

**The 6 categories:** Electrical · Plumbing · Structural · HVAC · Hazards · Envelope.
**Severity:** `High` / `Medium` / `Low` per item; the top-level `severity` is the row rollup.
**Each item carries a `source`** (`era:<id>` or `region:<id>`) so you can show provenance.

> The 1945/WA/SEA example returns **37 inspection items, 16 high-priority flags, overall severity
> High, row `SEA-1930`** — verified against the live deploy.

---

## 5. Response shape — `/rows`

```jsonc
{
  "ok": true,
  "region": "SEA",
  "count": 8,
  "rows": [
    { "id": "SEA-pre1900", "region": "Seattle, WA", "era_start": 0, "era_end": 1899,
      "electrical": "...; ...", "plumbing": "...", "structural": "...", "hvac": "...",
      "hazards": "...", "envelope": "...", "inspection_items": "...", "severity": "High" },
    { "id": "SEA-1930", ... }, ...
  ]
}
```

One row per construction-era band for that region — the flat "Layer-1" grid (semicolon-joined item
strings per category). Handy for building a reference table or seeding a spreadsheet. The CLI can
also emit this as CSV (`node lookup_engine.js --rows SEA`).

---

## 6. Status codes & the graceful-`ok:false` rule

> ⚠️ **Important — different from Material Takeoff.** `/scope` returns **HTTP 200 even when it
> can't produce a scope.** A missing/unknown year or unresolved address comes back as **`200` with
> `ok:false`** plus a `reason` and a helpful `message`, *by design* — so a proposal flow never
> hard-fails. **Callers must branch on the `ok` field, not just the HTTP status.**

| Case | Status | Body |
|---|---|---|
| Valid scope produced | `200` | `ok:true` + full scope |
| No/invalid year, or address year not found | `200` | `ok:false`, `reason:"no_valid_year"`, helpful `message` |
| `/rows` with no `region` | `400` | `ok:false`, `error:"missing_region"` |
| Malformed JSON body (POST) | `400` | `ok:false`, `error:"invalid_json"` |
| Unknown route | `404` | `ok:false`, `error:"not_found"` |

```jsonc
// GET /scope?address=999 Nowhere Rd, Faketown, ZZ   →   HTTP 200
{ "ok": false, "reason": "no_valid_year",
  "message": "Enter a valid build year (e.g. 1948) to generate era-based inspection items. ...",
  "build_year_source": { "source": "mock", "confidence": "unknown", "resolved_year": null, "ok": false, "reason": "not_found" } }
```

---

## 7. Limitations (read this before demoing the address path)

1. **Address → year is LIVE via RentCast in production** (confirmed 2026-07-09). Pass a **real, full
   street address** — `<house# street>, city, ST zip` — and it resolves against RentCast, e.g.
   `9415 Lexington Ave SW, Tacoma, WA 98499` → year **1949** (`confidence:"exact"`) with a `property`
   block. Non-resolutions still return `build_year_source.source:"rentcast"` (the integration is
   fine — the input was): an **incomplete** address (city/zip only) → `reason:"http_400"`; a parcel
   RentCast has **no record** for → `reason:"not_found"`.

   **Local/offline (no `RENTCAST_API_KEY`)** the server falls back to the bundled MockProvider, which
   knows only these **fabricated fixture addresses** — test data, NOT real RentCast records:

   | Mock fixture address | Mock resolves to |
   |---|---|
   | `1730 Minor Ave, Seattle, WA 98101` | **1945** |
   | `233 S Wacker Dr, Chicago, IL 60606` | **1968** |
   | `1 Infinite Loop, Cupertino, CA 95014` | **2022** |
   | `500 UnknownYear Rd, Austin, TX 78701` | *found, no year* → `ok:false` |

   The provider seam is identical either way; `RENTCAST_API_KEY` selects live-vs-mock. **The year
   path works regardless of the provider.**

2. **Probabilistic, not factual.** Output is *"likely / inspect for"*, never *"guaranteed present"*.
   A home may have been re-piped, re-wired, or renovated. The `disclaimer` field says so — surface it.
3. **National era boundaries + 5 regional modifiers** (Pacific NW, Seismic West, Gulf/Southeast,
   Cold Northeast/Midwest, Arid Southwest). Region granularity is **state-level** (+ a few metros for
   row IDs). Local code adoption varies; boundaries are norms, not hard cutoffs.
4. **US-only.**
5. **`/scope` returns 200 on `ok:false`** (see §6) — easy to mishandle if you only check the HTTP
   status. Always check `ok`.
6. **Severity is rule-based** (a deterministic classifier), consistent across eras but not a
   substitute for an inspector's judgment.
7. **Scope only.** It produces inspection items — **no pricing, scheduling, or labor estimates.**
8. **No auth, persistence, or rate limiting.** Stateless and public; fine for pilot, add a key +
   quota before billing it.

The dataset's era boundaries are researched and corroborated — sources are listed in
`era_dataset.json` `_meta.sources` (InspectAPedia, ASHI, UL/David Dini, EPA, CPSC, IAEI/Mike Holt).

---

## 8. Integration examples

**JavaScript / frontend (fetch), year path:**

```js
const BASE = "https://house-intelligence-production.up.railway.app";

async function getScope({ year, state, metro }) {
  const qs = new URLSearchParams({ year, ...(state && { state }), ...(metro && { metro }) });
  const res = await fetch(`${BASE}/scope?${qs}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || data.reason || "no scope");  // 200 can still be ok:false!
  return data; // { era, categories, high_priority_flags, severity, row, summary, disclaimer, ... }
}

const s = await getScope({ year: 1945, state: "WA", metro: "SEA" });
console.log(s.severity, "—", s.high_priority_flags.length, "high-priority flags");
Object.entries(s.categories).forEach(([cat, items]) =>
  console.log(cat, items.map(i => `[${i.severity}] ${i.item}`)));
```

**POST (body-driven), address path:**

```bash
curl -X POST https://house-intelligence-production.up.railway.app/scope \
  -H "Content-Type: application/json" \
  -d '{"address":"233 S Wacker Dr, Chicago, IL 60606"}'
```

**Rendered text for a proposal:**

```bash
curl "https://house-intelligence-production.up.railway.app/scope?year=1968&state=IL&format=text"
```

---

## 9. Next steps (roadmap)

**The #1 unlock**
- **Wire a real address → build-year vendor** (RentCast recommended) into `address_provider.js` so
  arbitrary addresses resolve — turning the address path from demo-only into the real product. The
  vendor-agnostic seam is already built.

**Data**
- Deeper regional data pass (+ era-gate regional items); finer granularity (county/city) beyond the
  current state-level modifiers.
- Confidence scoring on the resolved year; surface vendor confidence in the response.

**Productionization (before charging)**
- Auth (API key) + rate limiting + request logging.
- Persistence — save scopes per property/customer (currently stateless).
- Custom domain (cosmetic; rename in Railway → Settings → Networking).

**Integration**
- Proposal / PDF export and GHL/BuildSuite hooks off the `categories` + `high_priority_flags` + `row`.
- Pair with **Material Takeoff** so one property flows from "what to inspect" → "what to buy".

---

_Engine + address layer + HTTP API are unit-tested (138 tests). Output is deterministic and
dependency-free. Era sources are listed in `era_dataset.json` `_meta`._
