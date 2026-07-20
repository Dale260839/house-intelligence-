# House Intelligence × BuildSuite — Integration Guide

**Base URL:** `https://house-intelligence-production.up.railway.app`
**The endpoint BuildSuite calls:** `POST /intelligence`

> This guide is for **BuildSuite developers wiring House Intelligence in**. For the raw engine /
> `/scope` reference (all scope fields, `/rows`, the year path), see [API_GUIDE.md](API_GUIDE.md).
> House Intelligence is the sibling of [Material Takeoff](material-takeoff/API_GUIDE.md): one says
> what to **inspect**, the other what to **buy**.

---

## 1. What is House Intelligence, and what is it for?

**The pitch:** a contractor gets matched to a homeowner's project. Before they've driven to the
site, House Intelligence looks at the **home's address**, derives its **build year + region**, and
returns the **era-specific things that home is likely to have** and should be inspected for —
knob-and-tube wiring, aluminum branch wiring, asbestos, lead paint, polybutylene supply, old panel
types, seismic concerns, and so on. _"The contractor looks like an expert before they ever visit
the site."_

**Why it exists inside BuildSuite:**
- It makes the contractor's proposal/scope-of-work **smarter and more credible** automatically —
  the right inspection line items appear based on the home's era, not the contractor's memory.
- It's a **differentiator competitors can't easily copy** and a foundation for later paid tiers.
- It feeds the **matched-clients view**: each matched homeowner is enriched with era-inspection
  detail the contractor can act on.

**What it is NOT:**
- Not a guarantee. Output is always *"likely / inspect for"*, never *"guaranteed present"* — a home
  may have been re-wired or re-piped. Every response carries a `disclaimer`; **surface it.**
- Not a pricing or scheduling tool. It produces **inspection scope only.** (Material Takeoff handles
  materials + cost.)
- Not called by end users. **Only BuildSuite calls it, server-to-server.**

---

## 2. How it fits — the integration flow

```
Homeowner project  ─┐
                    │  (matched to a contractor by service)
BuildSuite match ───┤
                    │  BuildSuite already has the client's ADDRESS + the match ids
                    ▼
        POST /intelligence  { address, project_id, contractor_id, client_id, contact_id }
                    │
     House Intelligence  ── resolves address → build year → era scope (+ property details)
                    │      ── APPENDS one row to Supabase (house_intelligence_requests)
                    ▼
        returns { ok, scope, property, lead_links, stored }
                    │
BuildSuite ─────────┘  reads the Supabase table (joined to `matches`) to render the
                       contractor's matched-clients view.
```

Two things happen on every call: House Intelligence **returns the scope inline** (so BuildSuite can
use it immediately) **and persists a row** (so BuildSuite can query it later without recomputing).
BuildSuite **passes the address in** — House Intelligence never reads BuildSuite's `clients` or
`matches` tables.

---

## 3. The call: `POST /intelligence`

### Request body

```jsonc
{
  "address":       "1730 Minor Ave, Seattle, WA 98101",  // REQUIRED
  "project_id":    "…",     // BuildSuite match keys — carried through to the stored row
  "contractor_id": "…",
  "client_id":     "…",     // contacts.id (uuid)
  "contact_id":    "…",     // GHL ghl_contact_id (joins to matches.contact_id)
  "profile_id":    "…",     // optional; only stored if you send it
  "metro":         "SEA"    // optional; otherwise inferred from the address
}
```

| Field | Required | Meaning |
|---|---|---|
| `address` | **yes** | The homeowner's full address. String (`"123 Main St, City, ST 00000"`) or object `{ line1, city, state, zip }`. Missing → **400 `missing_address`**. |
| `project_id`, `contractor_id`, `client_id`, `contact_id` | no* | The match context. Not required by the API, but **send them** — they're what lets BuildSuite join the stored row back to the right match. |
| `profile_id` | no | Pre-existing column; only written if supplied. |
| `metro` | no | Override the metro inferred from the city (affects the blueprint row id/label). |

\* The API only hard-requires `address`; the ids are optional to the endpoint but essential to *your*
join. Send everything you have.

### Response (HTTP 200)

```jsonc
{
  "ok": true,                       // = scope.ok (see the graceful-false rule below)
  "scope": {                        // the full era scope — same shape as GET /scope
    "ok": true,
    "year": 1945, "state": "WA", "metro": "SEA",
    "era": { "id": "1930_1949", "label": "1930–1949", "range": [1930, 1949] },
    "severity": "High",             // overall row rollup: High | Medium | Low
    "categories": {                 // the 6 buckets, each an array of items
      "Electrical": [ { "item": "Remaining knob-and-tube", "severity": "High", "source": "era:1930_1949" }, … ],
      "Plumbing": [ … ], "Structural": [ … ], "HVAC": [ … ], "Hazards": [ … ], "Envelope": [ … ]
    },
    "high_priority_flags": [ "Remaining knob-and-tube", "Lead-based paint (assume present)", … ],
    "inspection_items": [ "…", … ],
    "row": { "id": "SEA-1930", "region": "Seattle, WA", "severity": "High", … },
    "address": { "line1": "1730 Minor Ave", "city": "Seattle", "state": "WA", "zip": "98101", "freeform": "…" },
    "build_year_source": { "source": "rentcast", "confidence": "exact", "resolved_year": 1945, "ok": true },
    "summary": "Home built in the 1930–1949 era … 37 inspection items … overall severity High.",
    "disclaimer": "These are probabilistic era patterns … NOT a guarantee …"
  },
  "property": {                     // present when the provider returned property detail
    "source": "rentcast", "propertyType": "Single Family", "squareFootage": 1820,
    "bedrooms": 3, "bathrooms": 2, "lotSize": 5000, "floorCount": 2, "roomCount": 7,
    "features": { "heatingType": "Forced Air", "cooling": false, … }
  },
  "lead_links": { "redfin": "https://www.redfin.com/…search…" },   // a quick human lookup link
  "stored": {                       // the persistence outcome (see §4)
    "ok": true, "stored": true, "record": { "id": "…", "requested_at": "…", … }
  }
}
```

**What BuildSuite typically renders from this:** `scope.severity` (a badge), `scope.high_priority_flags`
(the headline callouts), `scope.categories` (the grouped checklist), `scope.summary` + `disclaimer`
(the trust text), and `property` (home facts). Each item's `source` (`era:…` / `region:…`) is there
if you want to show provenance.

### The graceful `ok:false` rule — read this

> **`POST /intelligence` returns HTTP 200 even when it can't produce a scope.** If the address can't
> be resolved to a build year, you get **`200` with `ok:false`** (and `scope.reason:"no_valid_year"`
> + a helpful `scope.message`) — by design, so a proposal flow never hard-fails. **Branch on the
> `ok` field, not the HTTP status.**

| Situation | HTTP | Body |
|---|---|---|
| Address resolved, scope produced | `200` | `ok:true` + full scope |
| Address given but no build year found | `200` | `ok:false`, `scope.reason:"no_valid_year"` |
| `address` missing/blank | `400` | `ok:false`, `error:"missing_address"` |
| Malformed JSON body | `400` | `ok:false`, `error:"invalid_json"` |

The persistence outcome is **independent** of the scope outcome: a scope can succeed while the DB
write fails (or vice versa). Inspect `stored.ok` separately — see §4.

---

## 4. What gets persisted, and how BuildSuite reads it back

Every call **appends one row** to the Supabase table **`house_intelligence_requests`** (an append
log — one row per request, `requested_at` defaults to `now()`; it is never an upsert). House
Intelligence's store is **INSERT-ONLY into that single hardcoded table** — it never updates, deletes,
or touches any other table (a deliberate safety guarantee).

**Columns written** (from the request + resolved scope):

| Column | From |
|---|---|
| `project_id`, `contractor_id`, `client_id`, `contact_id`, `profile_id` | the match keys you sent |
| `address` | the address you sent |
| `year_built` | `scope.build_year_source.resolved_year` |
| `state` | resolved state |
| `year_source` | how the year was resolved (`rentcast` / `mock` / …) |
| `resolved` | boolean — did it resolve to a year? |
| `severity` | overall scope severity |
| `scope` | full scope object (jsonb) |
| `property` | property details (jsonb) |
| `requested_at` | DB default `now()` |

**BuildSuite reads it back** by querying `house_intelligence_requests` joined to your `matches`
table — the intended join key is **`contact_id` (= GHL `ghl_contact_id`) → `matches.contact_id`**,
and/or `client_id` (= `contacts.id`). Take the **latest row per (contractor_id, client_id)** for the
matched-clients view (there's an index on `(contractor_id, client_id, requested_at desc)`).

**Reading the `stored` field in the response:**

| `stored` value | Meaning |
|---|---|
| `{ ok:true, stored:true, record:{…} }` | Row persisted; `record` is the stored row. |
| `{ ok:true, stored:false, reason:"no_supabase_credentials", … }` | Persistence not configured (no Supabase env) — scope still returned, nothing saved. |
| `{ ok:false, stored:false, reason:"auth_error" \| "table_not_found" \| … }` | Write failed; scope still valid. Log + optionally retry. |

---

## 5. Auth model

**House Intelligence has no auth of its own — deliberately.** It's only ever called
**server-to-server from BuildSuite**, which is already gated by its **GHL token**. End users never
hit House Intelligence directly.

> **Do not call `POST /intelligence` from the browser / client side.** Call it from BuildSuite's
> backend. It is currently public + unauthenticated + unthrottled (fine for server-to-server pilot);
> add a shared secret / IP allowlist / rate limit before broad production use.

Supabase access uses the **publishable (anon) key**, which is **RLS-gated** — it can only insert into
`house_intelligence_requests` (and read where a policy allows). It is **not** the service_role key.

---

## 6. Going-live checklist

House Intelligence runs end-to-end **without any keys** (mock address data + no-op persistence), so
you can integrate against it today. To make it *real*, set these server env vars (see the repo-root
[.env.example](.env.example)):

- [x] **`RENTCAST_API_KEY`** — **DONE (live in production).** Activates the live address→build-year
      adapter; confirmed resolving real street addresses (see §7). Without it the server falls back to
      the MockProvider (fixture addresses only).
- [ ] **`SUPABASE_URL` + `SUPABASE_KEY`** (publishable/anon key) — turns on persistence. Without both,
      `stored.ok:true` but `stored:false` (nothing saved). Supabase project ref: `bkngicyqgdwzmoeahqdi`.
- [ ] **Run the migration** `supabase/house_intelligence_requests.sql` in Supabase (adds the columns,
      index, and RLS insert/select policies for the anon role).
- [ ] **One real end-to-end call** — POST a real address, confirm the row lands and the column shapes
      match what BuildSuite's matched-clients query expects.

Setting a key is a **config change, not a code change** — the provider/store seams auto-select live
vs. mock from the environment.

---

## 7. Address resolution — RentCast is LIVE in production (use real street addresses)

**Production runs the live RentCast adapter** (`RENTCAST_API_KEY` is set on Railway) — confirmed
2026-07-09: `9415 Lexington Ave SW, Tacoma, WA 98499` → `ok:true`, year **1949** (`confidence:"exact"`),
full `property` block. Pass **real, full street addresses** in the form
**`<house# street>, city, ST zip`**.

> **Give RentCast a complete street address.** Two common non-resolutions — both return
> `build_year_source.source:"rentcast"` (the integration is fine; the *input* was the problem):
> - **Incomplete address** (city/zip only, e.g. `Lakewood, WA 98499`) → `reason:"http_400"`.
>   RentCast needs a street number + street name.
> - **No record** for that parcel (or a non-residential/nonexistent address) → `reason:"not_found"`.

**Local/offline note:** if you run the server **without** `RENTCAST_API_KEY` (e.g. locally, no
`.env`), it falls back to the bundled **MockProvider**, which knows only these **fabricated fixture
addresses** — they are *test data*, not real RentCast records, and will NOT resolve against live
RentCast in production:

| Mock fixture address | Mock resolves to |
|---|---|
| `1730 Minor Ave, Seattle, WA 98101` | **1945** (+ mock property detail) |
| `233 S Wacker Dr, Chicago, IL 60606` | **1968** |
| `1 Infinite Loop, Cupertino, CA 95014` | **2022** |
| `500 UnknownYear Rd, Austin, TX 78701` | *found, no year* → `ok:false` |

The provider seam is identical either way — only the data source (live RentCast vs. mock fixtures)
differs, selected by whether `RENTCAST_API_KEY` is present. The integration contract never changes.

---

## 8. Reference calls

**From BuildSuite's backend (Node fetch):**

```js
const HI_BASE = "https://house-intelligence-production.up.railway.app";

async function enrichMatch({ address, project_id, contractor_id, client_id, contact_id }) {
  const res = await fetch(`${HI_BASE}/intelligence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, project_id, contractor_id, client_id, contact_id }),
  });
  const data = await res.json();               // 200 even on failure — check data.ok
  if (!data.ok) {
    // no build year → still show the disclaimer / a "year unknown" state, don't hard-fail
    return { resolved: false, reason: data.scope?.reason, scope: data.scope };
  }
  if (!data.stored?.ok) console.warn("HI persistence failed:", data.stored?.reason);
  return {
    resolved: true,
    severity: data.scope.severity,
    flags: data.scope.high_priority_flags,
    categories: data.scope.categories,
    property: data.property,
    summary: data.scope.summary,
    disclaimer: data.scope.disclaimer,
  };
}
```

**curl (a seeded demo address):**

```bash
curl -X POST https://house-intelligence-production.up.railway.app/intelligence \
  -H "Content-Type: application/json" \
  -d '{"address":"1730 Minor Ave, Seattle, WA 98101","project_id":"p1","contractor_id":"c1","client_id":"cl1","contact_id":"gh1"}'
```

---

_House Intelligence is deterministic, dependency-free, and unit-tested. Era sources are listed in
`era_dataset.json` `_meta`. Persistence is insert-only into a single hardcoded table. This guide
covers the BuildSuite path (`POST /intelligence`); the full engine reference lives in
[API_GUIDE.md](API_GUIDE.md)._
