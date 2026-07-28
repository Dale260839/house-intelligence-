# Material Takeoff — v2 (Proposal-Driven) Gap Analysis

**Our current system vs. two source docs:** Sing's `Material_Takeoff_v2_Handover_for_Dale.md` and the
`Huddle_Summary_Jul25_Jul28.md` (Chris + Sing). Prepared: 2026-07-28.
Scope: what aligns, what's a discrepancy, what's missing, what to upgrade — as a build ticket.
**Cross-checked against the huddle in §11 (expanded project types, assigned tickets, urgency, gating).**

---

## 0. Verdict (TL;DR)

**We are aligned on the *engine*, not yet on the *input model*.**

- ✅ **Everything in the doc's "What stays / What is NOT changing" (§7) is already built, live, and
  verified** — quantity math, waste/coverage rules, the auditable `basis` field, the rough-in
  checklist, the pricing block + tiers + profit layout, rate limiting, graceful degradation, and the
  existing `POST /material-takeoff` endpoint. No rework needed there.
- ⚠️ **The doc describes our v1 as "kitchen only." That's out of date.** Since then we shipped
  **`bathroom_remodel`**, **`flooring_only`**, **add-on groups** (demolition/subfloor/paint/trim/
  hardware), **room shapes**, **pack-size rounding**, and a **pricing outlier fix**. Several of the
  doc's structural complaints are *already partially closed*. **Sing should be briefed on this — it
  changes what's left to build.**
- 🔴 **The core v2 ask is essentially unbuilt:** a `from-proposal` endpoint, an **extraction /
  intelligence layer** that reads proposal text, **multi-section single-call** takeoffs, per-line
  **provenance** (`section_id` + `source_quote`), and a **budget-derived pricing fallback**. None of
  that exists today.
- 🧭 **One real architectural decision blocks everything:** the extraction layer needs an **LLM**,
  which conflicts with our current **deterministic, zero-runtime-dependency** design. This is the
  crux of open question Q1 in *both* docs ("the main scoping decision") and needs an explicit call
  before build (see §5, §11-D).
- ⏱️ **On the critical path and time-boxed.** Per the Jul 28 huddle, Sing's v2 front end is **blocked
  on our endpoint** (~1 day for him once received), Chris wants it **this week**, and he asked to
  **escalate rather than idle**. Fastest unblock: **settle Q1** and ship the deterministic
  **`from-scope` first cut**. Separately, **"fix countertop mispricing" is already an assigned Dale
  ticket** (status: *Reported*) that ships independently of the v2 decision — see **U4** / §11-B.

**Bottom line:** the "engine" half of v2 is done and battle-tested; the "read the proposal" half is a
new capability with a genuine design decision in front of it. Two things move now regardless of that
decision: **U4 (countertop fix)** and the **deterministic `from-scope` groundwork**.

---

## 1. Important context: the doc's picture of our v1 is stale

Sing wrote this against "v1 = kitchen only, single `kitchenSqft` input." We've moved well past that.
This materially changes the gap list.

| Doc's complaint (§1) | Reality in our current system |
|---|---|
| "It only understands a kitchen, sized by floor area." | We have **3 project types** (`kitchen_remodel`, `bathroom_remodel`, `flooring_only`), each with its own inputs. |
| "It has no idea what the job includes" beyond a kitchen. | **Add-on groups** already model demolition, subfloor, paint, trim, and hardware — opt-in per takeoff. |
| The `1400` "mansion kitchen" bug. | Still a real input-model problem for a *single manual call*, but `flooring_only` already handles a 1400 sqft floor correctly, and a proposal-driven multi-section call is the real fix. |
| "Three line types." | We now have **four** — `pack_round` was added (tile→boxes, countertop→slabs). |

The huddle goes **further on scope** than the handover doc: beyond kitchen/bathroom/flooring it names
**drywall, bedroom, and living room** as wanted project types, plus a **whole-project takeoff with
per-room breakdowns**. We have 3 of these; the rest are new (small) builders on the existing pluggable
architecture — a "bedroom"/"living room" is essentially a composition of drywall + paint + trim +
flooring, which we already model as pieces. See §11-A.

**None of this satisfies v2 on its own** (still no proposal ingestion, still one project type per call),
but it means less of the "structurally incomplete" concern remains, and the engine is richer than the
doc assumes.

---

## 2. Alignment scorecard

Legend: ✅ have · 🟡 partial · 🔴 missing.

### The response contract the doc wants back

| Field / behavior | Status | Note |
|---|---|---|
| Same top-level shape as `POST /material-takeoff` | ✅ | `ok, project_type, inputs, derived, materials, fixtures_checklist, summary, field_verify_items, disclaimer, pricing`. |
| `materials[]` with `key`, `basis`, `field_verify` | ✅ | Stable `key` per line already (BuildSuite needs it for edits — §6.3 covered). |
| `pricing` block (tiers, labor, profit_layout) | ✅ | Live via SerpApi; math verified (matches the doc's $47,259 example). |
| `product_url` on priced lines | ✅ | Kept + normalized to public `www.homedepot.com` (doc §6.6 — don't drop it). |
| `source_type: "proposal"` | 🔴 | Trivial to add. |
| `extracted_scope { sections[], notes[] }` | 🔴 | Requires the extraction layer. |
| Per-line `section_id` | 🔴 | Requires multi-section support. |
| Per-line `source_quote` | 🔴 | Requires extraction. |
| Per-line `price_source` (`homedepot_live` vs `proposal_budget`) | 🔴 | We expose `source` at the **block** level only, not per line. |

### The new endpoint & inputs (§2)

| Item | Status |
|---|---|
| `POST /material-takeoff/from-proposal` | 🔴 Does not exist. |
| Accept `proposal_markdown` / `proposal_text` | 🔴 |
| Accept `budget_total` / `budget_sections` | 🔴 |
| Accept `location` hint | 🔴 (unused today; pricing is national) |
| `tier`, `markupPct`, `laborPct`, `laborCost`, `price` | ✅ Already supported identically. |

### The intelligence layer (§3–4)

| Requirement | Status |
|---|---|
| Extract sections / rooms from proposal | 🔴 No NLP/LLM anywhere. |
| Extract trades per section | 🔴 |
| Pull **stated** quantities, prefer over derived | 🟡 The *engine can consume* explicit numbers (e.g. `floorSqft`, `wallPerimeterLF`, `cabinetLF`); the *extraction that produces them* is 🔴. |
| remove / reinstall / replace distinction | 🔴 No concept of it. |
| Non-obvious materials (floor protection, plastic, tape, HEPA) | 🔴 Engine has **no rules** for site-protection consumables (see §4). |
| Multiple rooms in one call, per-section breakdown | 🔴 One project type per call today. |
| `confidence: stated / inferred / assumed` | 🔴 |
| `no_scope_extracted` graceful failure | 🔴 (pattern exists — House Intelligence does exactly this — just not wired here). |

### Pricing fallback (§5)

| Requirement | Status |
|---|---|
| Gap 1 — unmatched lines fall back to `budget_sections` estimate + `price_source` | 🔴 Today unmatched lines go to `unpriced_lines` and are **excluded from the total** (confirmed: `materials_cost` sums priced lines only). |
| Gap 2 — made-to-measure mispricing (countertop $4/sqft) | 🟡 **Known + partially mitigated.** We already flag this caveat and added a **high-side outlier guard** (rejects pallet SKUs; `max_unit_price`). The countertop case is a **low-side** miss (matched a sample swatch) — **no min-price floor yet**, and the search term is still the swatch-prone one. |

### What stays (§7) — the "don't touch" list

| Item | Status |
|---|---|
| Quantity math, waste, coverage | ✅ Live, verified. |
| Line types + `basis` | ✅ (four types now). |
| Rough-in checklist | ✅ |
| Pricing block shape, tiers, profit math | ✅ Matches the doc's verified numbers. |
| Rate limiting + graceful degradation | ✅ |
| Existing `POST /material-takeoff` endpoint stays live | ✅ Unchanged; we'd add `from-proposal` alongside it. |

---

## 3. Discrepancies (where our reality differs from the doc's assumptions)

1. **"Three line types" → we have four.** `pack_round` was added. Not a conflict, but Sing's rendering
   should handle it (it carries `covered_qty` + `pack_size`; order is in boxes/slabs).
2. **`project_type` is singular in our response.** A multi-section proposal takeoff has no single
   project type. We'll need to either set `project_type: "composite"` (or `"proposal"`) or drop it in
   favor of `extracted_scope.sections`. Minor contract wrinkle to agree on.
3. **Our world is organized by *project type*, the doc's is organized by *section + trades*.** For the
   rooms we support these line up (a "section" ≈ a project type), but the doc also expects *trade-level*
   and *protection/consumable* materials our engine doesn't produce (see §4). The mapping isn't 1:1.
4. **Doc §5 says pricing "went live" is pending a key — also stale.** Pricing is **live in prod via
   SerpApi** now (the doc even verified it end-to-end, so this is just wording).
5. **Determinism assumption.** The doc (§8 Q3) rightly worries about re-runs returning different
   numbers. Our engine is **fully deterministic today**; introducing LLM extraction is what would break
   that. So the concern is real and lands squarely on the new layer, not the engine.

---

## 4. The material-coverage gap (easy to miss, important)

The doc says "your quantity math stays" — but its own example output asks for materials our engine
**cannot generate**: floor protection, plastic sheeting, tape, HEPA vacuum filters, and a standalone
"3/4 inch MDF underlayment across 1400 sqft." Our engine only knows the material categories baked into
the three project types.

- **We DO model:** cabinets, countertops, tile (floor/wall/backsplash) + thinset/grout, drywall +
  compound/tape/screws, waterproofing + backer board, vanity + top, flooring (tile/LVP/laminate/
  engineered/hardwood) + underlayment + fasteners + transitions, and add-ons (demolition dumpster,
  subfloor, paint, baseboard, cabinet hardware).
- **We do NOT model:** site protection (floor protection, plastic, tape, HEPA filters, dust barriers),
  standalone consumables outside a project type, or arbitrary "whatever the proposal lists."

**Implication:** even with a perfect extraction layer, the deterministic engine will under-produce
versus the doc's example unless we either (a) add "site protection / consumables" material rules, or
(b) let the extraction emit some lines **directly** (a proposal-line → material-line passthrough with
its own `basis`/`source_quote`, priced live) rather than routing everything through the geometry
engine. **(b) is likely the pragmatic answer** for the long tail of proposal-specific items.

---

## 5. The one decision that gates everything: where does extraction live? (doc Q1)

Our services are deliberately **deterministic and zero-runtime-dependency** (Node core only; House
Intelligence and pricing both use clean *provider seams*). Proposal extraction needs an **LLM**, which
introduces an external dependency, an API key + per-call cost, latency, and **non-determinism**. Three
options:

| Option | What it means | Pros | Cons |
|---|---|---|---|
| **A. Extraction inside our service** (Sing's stated preference) | We own `from-proposal`; it calls an LLM, produces structured scope, feeds the engine. | One call, one contract for BuildSuite. | Breaks zero-dep/deterministic model; we own LLM cost, keys, prompt, determinism. |
| **B. Extraction in BuildSuite** | Sing runs the LLM, sends us **structured scope**; our engine stays pure + deterministic. | Cleanest separation; engine stays testable/deterministic; no LLM in our stack. | Two owners; the doc warns against "neither owning it" (mitigated by a firm structured contract). |
| **C. Hybrid (recommended)** | We ship **two endpoints**: `from-scope` (structured sections → deterministic multi-section takeoff, **no LLM**) *and* `from-proposal` (thin LLM orchestration → `from-scope`), with the LLM behind a **provider seam** like our pricing/address adapters. | Deterministic core is reusable and testable on its own; LLM is swappable/mocked; satisfies "one call" while keeping the engine pure; matches how we already structure providers. | Slightly more surface than A. |

**Recommendation: C.** Build the deterministic **multi-section aggregator + `from-scope`** first (pure
engine work, fully testable, immediately useful, and it's the thing every acceptance criterion except
raw extraction depends on). Then add `from-proposal` as a thin LLM layer on top, behind a provider seam
so it mocks in tests and its model/temperature are controllable (answers Q3 directly).

---

## 6. Upgrades to our current version (from this comparison)

Some are prerequisites for v2; several are worth doing regardless.

| # | Upgrade | Why | Depends on LLM? | Rough effort |
|---|---|---|---|---|
| U1 | **Multi-section aggregator + `POST /material-takeoff/from-scope`** — accept `sections[]`, run the right builder per section, merge into one response with `section_id` on every line. | The backbone of v2; deterministic; unblocks most acceptance criteria. | No | 2–3 d |
| U2 | **`source_type` + per-line `section_id`** on all responses (default `"manual"` / single section). | Cheap, forward-compatible, needed by v2. | No | 0.5 d |
| U3 | **Budget-derived pricing fallback + per-line `price_source`** (`homedepot_live` \| `proposal_budget` \| `mock`); unmatched lines estimate from `budget_sections` so the total never silently understates. | Doc §5 Gap 1; useful even for manual takeoffs. | No | 1–1.5 d |
| U4 | **Price sanity floor + fix countertop search term** — add `min_unit_price` alongside the existing `max_unit_price`; retune the countertop/vanity-top terms off the sample-swatch match. | Doc §5 Gap 2 **and an explicitly assigned Dale ticket** (huddle, status *Reported*). **No dependency on the v2 decision — ship now.** | No | 0.5 d |
| U5 | **Site-protection / consumables material rules** (or an extraction line-passthrough) — floor protection, plastic, tape, HEPA, dust barriers. | Doc §3/§4 non-obvious materials; the example output needs them. | No (rules) / yes (passthrough) | 1–2 d |
| U6 | **`extracted_scope` schema + `source_quote` per line** (populated by whoever owns extraction). | Doc's trust layer; §9 acceptance. | Contract only | 0.5 d |
| U7 | **`from-proposal` endpoint + LLM extraction** behind a provider seam (mockable, low-temp, structured output). | The headline v2 capability. | **Yes** | 3–5 d |
| U8 | **PDF export of a takeoff** (doc §6.4 — shared with House Intelligence). | Both products need it. | No | 1–2 d |

Independent quick wins we can ship now regardless of the v2 decision: **U2, U3, U4** (and U8 if
prioritized).

---

## 7. Answers to the doc's open questions (§8), from our side

- **Q1 (where extraction lives):** Prefer **Hybrid (C)** — deterministic `from-scope` in our service +
  a thin, seam-isolated LLM `from-proposal` on top. If you'd rather own the LLM in BuildSuite, we'll
  take **structured scope** and skip the LLM entirely on our side (send us the `from-scope` shape we
  define in U1). Either way, one side owns it clearly.
- **Q2 (structured budget vs raw markdown):** **Send `budget_sections` structured.** We'll use it for
  the pricing fallback (U3) and to sanity-check section sizing; parsing the cost table out of markdown
  ourselves is avoidable work and more fragile.
- **Q3 (model / determinism):** Real concern — our engine is deterministic; the LLM layer must be
  **low-temperature + structured-output** and ideally **cache by proposal hash** so a re-run returns
  identical numbers. Putting it behind a provider seam lets us pin/swap the model and mock it in tests.
- **Q4 (timing):** The **deterministic half (U1–U4, U6 schema) is ~4–6 dev-days** and delivers a
  working `from-scope` + all the response fields + pricing fallback. The **LLM half (U7) adds ~3–5
  days** and the extraction-quality decision. So a credible first cut this week is *`from-scope` +
  fallback + fields*, with `from-proposal` following once Q1 is settled.

---

## 8. Acceptance-criteria readiness (doc §9)

| Acceptance criterion | Can we meet it? |
|---|---|
| Bathroom proposal → bathroom materials, not kitchen defaults | 🟡 Engine yes (`bathroom_remodel` exists); needs extraction to route to it. |
| Two-area proposal (bathroom + 1400 sqft flooring) → both sections sized | 🟡 Needs U1 (multi-section) + extraction. Engine can produce both today via separate calls. |
| Demo/protection materials appear (protection, plastic, tape, filters) | 🔴 Needs U5 (we don't model these). |
| "Remove & reinstall existing cabinets" → NO new cabinet lines | 🔴 Needs extraction (remove/reinstall/replace logic). |
| Every line has `section_id` + a real `source_quote` | 🔴 Needs U1 (`section_id`) + extraction (`source_quote`). |
| `extracted_scope.notes` names every assumption | 🔴 Needs extraction. |
| Pricing totals reconcile (`materials+labor=total`, `price-total=profit`) | ✅ Already true and tested. |
| Unpriceable lines fall back to budget estimate (don't vanish) | 🔴 Needs U3. |
| Unparseable proposal → `ok:false`, HTTP 200, no crash | 🟡 Pattern exists (House Intelligence); needs wiring in U7. |
| Existing `POST /material-takeoff` still works | ✅ Untouched. |

**Score:** 2 met today, 3 need deterministic work only (U1/U3), 5 need the extraction layer (U5/U7).

---

## 9. Suggested phasing

1. **Brief Sing** that v1 already has bathroom/flooring/add-ons (changes the plan).
2. **Settle Q1** (recommend Hybrid C).
3. **Phase A — deterministic, no LLM (~4–6 d):** U1 `from-scope` + multi-section aggregation, U2
   `source_type`/`section_id`, U3 budget fallback + `price_source`, U4 price floor + countertop fix,
   U6 `extracted_scope`/`source_quote` schema. Ship — BuildSuite can integrate against structured scope
   immediately, and every non-extraction acceptance criterion is met.
4. **Phase B — extraction (~3–5 d):** U7 `from-proposal` behind an LLM provider seam, remove/reinstall
   logic, non-obvious-material handling (with U5), `no_scope_extracted`.
5. **Phase C — shared:** U8 PDF export; later the "Order now" Home Depot path (product_url already
   preserved).

---

## 10. Questions back to Sing

1. **Own the LLM where?** (Q1) — our recommendation is Hybrid C; if you own it, we define the
   `from-scope` structured contract and skip the LLM entirely on our side.
2. **Send the 3–5 real generated proposals** (offered in §10) — we need them to define the extraction
   contract and to test `from-scope` sizing against real numbers.
3. **Confirm the `project_type` handling** for multi-section responses (`"composite"`? drop it for
   `extracted_scope`?).
4. **Scope of "non-obvious materials"** — do you want the engine to model site protection as first-class
   rules (U5), or is an extraction line-passthrough acceptable for the long tail?
5. **Is `from-scope` (structured, deterministic) an acceptable first deliverable this week**, with
   `from-proposal` following? It unblocks your UI immediately and de-risks the LLM piece.

---

## 11. Additional context & deltas from the Jul 25/28 huddle (second source)

Cross-checking the gap list against `Huddle_Summary_Jul25_Jul28.md`. New or reinforcing points:

**A. More project types are wanted than the handover doc lists.** Beyond kitchen/bathroom/flooring the
huddle names **drywall, bedroom, living room**, and eventually a **whole-project takeoff with per-room
breakdowns**. Status vs. us:

| Type | Us |
|---|---|
| kitchen · bathroom · flooring | ✅ shipped |
| drywall (standalone) | 🔴 new builder — small (we already model drywall + compound/tape/screws + paint/trim inside other types) |
| bedroom / living room | 🔴 new — but ~= drywall + paint + trim + flooring composed; cheap on the pluggable architecture |
| whole-project, per-room | 🔴 = the multi-section aggregator (U1) + these room types |

Each new single-room type is a dataset block + a small builder + tests (the flooring type took one
pass). The real lift is the **multi-section aggregation (U1)**, not the individual rooms.

**B. The countertop fix is an explicitly ASSIGNED, standalone Dale ticket.** The huddle action list has
"**Fix countertop mispricing on made-to-measure lines** — Reported" as a Dale item, *separate* from the
v2 endpoint. This is our **U4**, it has **no dependency on the v2 ownership decision, and it should ship
now.** (Reminder: our high-side outlier guard rejects pallet SKUs but does **not** catch this low-side
miss — the countertop matched a $4 sample swatch. Fix = a `min_unit_price` floor + a better search
term.)

**C. Critical path & urgency.** Sing's v2 front end is **blocked on our endpoint** ("roughly a day once
received"). Chris: **don't sit blocked — escalate**, and he's asking about **this week**. → Unblock
fastest by (1) getting a **decision on Q1** and (2) shipping the deterministic **`from-scope`** so
BuildSuite integrates against a real contract while the LLM piece follows.

**D. Q1 is confirmed as THE scoping decision — in both docs.** The huddle's open-question #1 is verbatim
"who owns the proposal-reading intelligence — Dale's service or BuildSuite? … the main scoping decision
and it changes the size of Sing's build." Our recommendation stands (**Hybrid C**; or BuildSuite-owns
with a firm `from-scope` contract we define).

**E. Future pricing — volume discounts.** Chris floated Home-Depot volume discounts (**5% over $2,000,
10% over $5,000**) once the "Order now" path lands. Out of scope now, but the **profit layout should be
designed to apply an order-level discount** later — cheap to leave room for (an optional
`order_discount` step between `materials_cost` and `total_cost`).

**F. Plan gating / teaser.** Takeoff usage counts against plan limits; the **intro plan sees a teaser
with the rest blurred**. Gating/blurring is BuildSuite-side, but we should **confirm the API always
returns the full payload** and BuildSuite does the blur (recommended), rather than the endpoint
returning a truncated teaser.

**G. Order path reconfirmed.** Keep **`product_url`** on priced lines (we do, normalized to `www`) for
the future Home Depot "Order now" flow.

**H. Not-material-takeoff Dale items (for awareness, tracked elsewhere):** portals work (with Sing +
Chris), and sourcing school training content — both from the huddle's Dale action list, out of scope
for this analysis.

### Updated committed-ticket view (Dale, Material Takeoff)

| Ticket | Source | Blocking? | Depends on Q1? | Ship |
|---|---|---|---|---|
| **U4 — countertop / made-to-measure price fix** | Huddle (assigned) + doc §5 | No | No | **Now** |
| **U1–U3, U6 — deterministic `from-scope` + fields + budget fallback** | Doc §2–5 | Unblocks Sing | No | **This week (first cut)** |
| **U7 — `from-proposal` + LLM extraction** | Doc §3 | Yes (front end waits) | **Yes — decide first** | After Q1 |
| U5 — site-protection / consumables | Doc §3–4 | Partial | No (rules) | With Phase B |
| U8 — PDF export | Huddle + doc §6 | No | No | Shared w/ House Intelligence |
| Later — more room types (drywall/bedroom/living room), volume discounts | Huddle | No | No | Roadmap |

---

_Cross-refs: current capabilities in `MATERIAL_TAKEOFF_KB.md`; the frontend contract in
`material-takeoff/API_GUIDE.md`; the internal roadmap in `MATERIAL_TAKEOFF_PLAN.md` (this v2 work maps
to its Phase 9 "whole-home / multi-room" plus a new extraction phase). Source docs:
`Material_Takeoff_v2_Handover_for_Dale.md`, `Huddle_Summary_Jul25_Jul28.md`._
