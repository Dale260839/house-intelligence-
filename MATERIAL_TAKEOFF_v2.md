# Material Takeoff — v2 Reference

_Supersedes the stale `EOD_MATERIAL_TAKEOFF_2026-07-11.md` context file. Written 2026-07-28._

The Material Takeoff service maps a renovation **scope + size** to an **order-ready material list**
(quantities with waste baked in), optional **live Home Depot pricing + a profit layout**, and now — in
v2 — **multi-section jobs**, **proposal-driven extraction**, and a **print-ready export**. It is a
deterministic, zero-runtime-dependency Node service (Node core only) with pluggable provider seams for
everything external (pricing, extraction).

---

## 1. The three ways in

| Endpoint | Input | `source_type` | Use it for |
|---|---|---|---|
| `POST /material-takeoff` | one `{ projectType, ...inputs }` | `manual` | a single room, form-driven. **Unchanged from v1.** |
| `POST /material-takeoff/from-scope` | `{ sections:[…] }` | `scope` | a whole job (kitchen + bath + floor) in one call → merged takeoff, `project_type:"composite"`. |
| `POST /material-takeoff/from-proposal` | `{ proposal_markdown }` | `proposal` | a free-text proposal → extracted scope → takeoff, with provenance. |

All three accept opt-in pricing (`price=true` + `tier/markupPct/laborPct/laborCost`) and the render
formats `format=text` and `format=html` (print-ready → save as PDF). Full request/response shapes live
in `material-takeoff/API_GUIDE.md` (§4c–§4f).

---

## 2. Architecture — "Hybrid C" (deterministic core + LLM at the edge)

```
 proposal_markdown ─▶ [extraction_provider]  ─┐   (LLM behind a seam, or a deterministic
                        (llm | heuristic)      │    heuristic fallback — cached by proposal hash)
                                               ▼
 sections[] ────────▶ [scope_engine] ─▶ [takeoff_engine] ─▶ per-type [builders/*] ─▶ materials[]
   (from-scope)          merge +            validate +          (deterministic,          (each line
                         stamp section_id   dispatch            zero-dep)                 .section_id)
                                               │
 price=true ─────────▶ [pricing_engine] ◀──────┘   per-line lookup via [pricing_provider]
                        one labor + one            (SerpApi/BigBox live | mock),
                        profit layout              outlier + swatch guards, budget fallback
                                               │
                                               ▼
                        JSON  |  format=text  |  format=html (print → PDF)
```

**The core stays deterministic.** The only fuzzy step — turning prose into a scope — is isolated
behind `extraction_provider.js`, exactly like pricing is isolated behind `pricing_provider.js`. That
is the whole point of Hybrid C: an LLM improves extraction without leaking non-determinism into the
quantity math or the tests.

**Files**

| File | Role |
|---|---|
| `takeoff_engine.js` | single-type dispatcher; validates inputs, stamps `source_type`/`section_id`. |
| `builders/*.js` | per-type quantity derivation (kitchen, bathroom, flooring) + shared `addons.js`. |
| `line_builders.js` | shared line constructors incl. `passthroughLine` (long-tail items). |
| `scope_engine.js` | `buildScopeTakeoff` (merge sections) + `buildProposalTakeoff` (extract → scope). |
| `pricing_engine.js` | `priceTakeoff` (single) + `priceScopeTakeoff` (multi) + budget fallback. |
| `pricing_provider.js` | live (SerpApi/BigBox) + mock; outlier (pallet) + floor (swatch) guards. |
| `extraction_provider.js` | LLM seam + deterministic heuristic + proposal-hash cache. |
| `pdf_export.js` | zero-dep print-ready HTML render. |
| `server.js` | Node-core HTTP front door; routes, CORS, rate limiter. |

---

## 3. Project types & add-on catalog

**Project types (live):** `kitchen_remodel`, `bathroom_remodel`, `flooring_only`.
Discover inputs at runtime via `GET /material-takeoff/project-types`.

**Add-on groups** (booleans on the single endpoint; an `add_ons:[]` array per section on v2):

| add_on | Lines | Basis |
|---|---|---|
| `demolition` | `demolition_dumpster` | floor area × debris rate → dumpsters |
| `subfloor` | `subfloor` | floor area +10% → 4×8 panels |
| `paint` | `primer` + `paint` | wall area × coats ÷ 350 sqft/gal |
| `trim` | `baseboard` | perimeter − openings → 16 ft sticks |
| `hardware` | `cabinet_hardware` | cabinet/vanity LF × 0.9 |
| `site_protection` **(v2/U5)** | `floor_protection`, `plastic_sheeting`, `masking_tape`, `dust_barrier`, `hepa_filter` | **all area-derived** (floor area + openings) |

**Passthrough (v2/U5):** long-tail items a ruleset can't derive from geometry (pot filler, range hood)
become `type:"passthrough"`, `calculation:"estimated"` lines carrying their `source_quote`.

---

## 4. Pricing & fallback model

1. Each material line is priced against **its own project type's** search term at the chosen tier
   (a composite job mixes configs correctly).
2. **Guards** in the matcher: reject **pallet/bulk outliers** (> 12× the result-set median) and
   **sample swatches** (below a per-line `min_unit_price` floor — the U4 fix for the $4 countertop
   swatch). Everything else falls back to the cheapest plausible result, never a pallet.
3. **Budget fallback (U3):** an unmatched line no longer silently drops from the total. If the section
   has a `budget_hint`, the remaining budget is spread across unmatched lines, tagged
   `price_source:"proposal_budget"`.
4. **One labor line + one profit layout** over the merged scope. Totals reconcile:
   `materials + labor = total_cost`, `price = total_cost × (1+markup)`, `profit = price − total_cost`,
   `margin = profit/price`.
5. **`price_source`** per line: `homedepot_live` | `mock` | `proposal_budget`.
6. **`order_discount` seam** (documented, not yet applied): volume discounts slot between
   `materials_cost` and `total_cost` without moving other fields.

---

## 5. Determinism guarantees

- The engine + builders are pure and synchronous — same inputs, same output, every time.
- Pricing and extraction are the only async/external steps and are both **seam + mock**; the whole
  test suite runs with no network and no keys.
- **Extraction is cached by proposal hash** (sha256): identical `proposal_markdown` → identical result
  (the LLM is called at temperature 0; the heuristic is pure). Re-running a proposal never re-bills or
  drifts.
- Nothing throws a request to the client: a bad price, an unmatched line, an extraction miss, or a bad
  section all **degrade** (`ok:false` / `unpriced_lines` / budget fallback), never crash.

---

## 6. Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| A1 | Existing `POST /material-takeoff` unchanged (additive fields only) | ✅ MET — 59 engine + 37→58 HTTP tests green |
| A2 | Engine deterministic; suite runs with no network/keys | ✅ MET |
| A3 | `from-scope` accepts `sections[]`, runs per-type builder, merges, stamps `section_id`, `composite` when >1 | ✅ MET (U1) |
| A4 | `source_type` on all responses; `section_id` on every line | ✅ MET (U2) |
| A5 | Budget-derived fallback; per-line `price_source`; totals reconcile | ✅ MET (U3) |
| A6 | Countertop/vanity-top swatch guard (`min_unit_price`) | ✅ MET (U4) |
| A7 | `site_protection` add-on, area-derived; passthrough for long-tail | ✅ MET (U5) |
| A8 | `extracted_scope{sections,notes}` + per-line `source_quote`/`confidence` | ✅ MET (U6) |
| A9 | `from-proposal` + LLM seam (temp 0, structured, **cached by hash**); heuristic fallback | ✅ MET (U7) |
| A10 | Remove+reinstall → no new item; prefer stated qty (confidence) | ✅ MET (U7) |
| A11 | `no_scope_extracted` → `ok:false`, HTTP 200, no crash | ✅ MET (U7) |
| A12 | Bad price / failed extraction never crashes a request | ✅ MET |
| A13 | PDF export path | ✅ MET as **`format=html`** print-ready export (U8). Server-side binary PDF intentionally **not** built (would break zero-dep). |

**Test count: 499 passing, 0 failing** (`npm test`).

---

## 7. CHANGELOG (U1–U8)

- **U1** — `POST /from-scope`: multi-section aggregator (`scope_engine.js`), `project_type:"composite"`.
- **U2** — `source_type` (manual/scope/proposal) + per-line `section_id` everywhere.
- **U3** — budget-derived fallback + per-line `price_source`; totals reconcile.
- **U4** — `min_unit_price` swatch floor + retuned countertop/vanity-top search terms.
- **U5** — `site_protection` add-on group (area-derived) + `passthroughLine` for long-tail items.
- **U6** — `extracted_scope` schema + per-line `source_quote`/`confidence` fields.
- **U7** — `POST /from-proposal` + `extraction_provider.js` (LLM seam + heuristic + hash cache);
  remove/reinstall + stated-over-inferred handling; `no_scope_extracted` → 200.
- **U8** — `format=html` print-ready export (`pdf_export.js`), zero-dependency.

---

## 8. Outstanding / decisions

- **Q1 — who owns the LLM?** Extraction ships with a deterministic heuristic default; the real LLM path
  is wired behind the seam but needs a key + the ownership decision (BuildSuite vs this service). This
  is the single gating call for full proposal fidelity. See `MATERIAL_TAKEOFF_V2_GAP_ANALYSIS.md`.
- **`order_discount`** — seam documented, not yet applied to the profit layout.
- **Heuristic multi-section** needs markdown headings; a heading-less blob mixing trades captures only
  the top-priority one (an LLM handles the rest). Fine as a fallback.
- **New room types** from the huddle (drywall-only, bedroom, living room) — each is a small new builder
  + dataset block; the composite aggregator already handles them once added.
- **Not deployed yet** — this change is staged for review; v2 endpoints go live on the next deploy.
