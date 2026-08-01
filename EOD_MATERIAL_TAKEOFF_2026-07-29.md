# EOD — Material Takeoff v2: integration fixes from BuildSuite testing

**Date:** 2026-07-29
**Component:** `material-takeoff/` service
**Time:** ~8h
**Status:** Complete — shipped to production. JSON response shape unchanged (values corrected, fields additive).

---

## Summary

BuildSuite (Sing) wired the proposal page to `from-proposal` end to end and ran real generated proposals
through it. Integration testing surfaced three issues — one a hard blocker (pricing off by 5×–25×) — plus
some field-population gaps. Fixed all of them today, keeping the response shape byte-compatible so the
BuildSuite integration keeps working as-is. Suite went from 499 → **524 tests, 0 failing**, and it's live.

---

## Time breakdown (8h)

| # | Block | h | What got done |
|---|---|---|---|
| 1 | Triage + repro | 1.0 | Reproduced the two bad behaviors against the live service: a 1400 sqft LVP floor quoting **$166k** (case price read as per-sqft), and a real proposal producing **12 sections** (every `##` heading — Exclusions, Warranty, Permits — got its own takeoff). Pinned the exact mechanisms. |
| 2 | Pack/case price normalization | 1.5 | `normalizePackPrice()`: parse the pack size out of the product title (`23.95 sqft/case`, `5-Pack — 80 Total Linear Feet`, `Case of N`, `(N-Pack)`) and divide to the line's unit. Reworked `extractProduct` to normalize each candidate **before** the guards; threaded `price_unit` through the live provider + cache key. LVP $42.87 → $1.79/sqft; baseboard $128 → $25.60/stick. |
| 3 | Per-line sanity bands + dumpster | 0.75 | `PRICE_BANDS` table (per line key; dataset `min/max_unit_price` overrides). A normalized price outside its band is a unit mismatch → dropped to `unpriced_lines` instead of a wrong number. Retuned the demolition search off the consumer "bag" + a $200 floor. |
| 4 | Pricing tests | 0.5 | Pack normalization, the bands, live-provider case-price path, and a full `priceTakeoff` run on a 1400 sqft floor (sane line, not $64k). Pricing suite 75 → 89. |
| 5 | Scope-of-Work extraction | 1.5 | Rewrote the block splitter (`parseNodes` + `selectBlocks`): when `## Scope of Work` is present, its `### N.` subsections are the work areas. Classify + **merge phase subsections into one job** (union add-ons, prefer a stated area); collect job-wide add-ons from non-room phases. |
| 6 | Denylist + no-invent-area + notes | 0.75 | Denylist for non-work headings (Executive Summary, Exclusions, Warranty, Permits, Investment, …) as a backstop. Assumed-area flagged in `notes` after the merge (no stray flags). Ignored/skipped headings reported in `notes`. |
| 7 | `extracted_scope` field population | 0.5 | Scope-level `id` + `area_sqft` populated; `source_quote` now a **body** sentence (not the heading); `notes` no longer empty. |
| 8 | Extraction tests | 0.5 | The Issue 2 (phase subsections → 1 job) and Issue 3 (12 headings → 1 section) repros, the denylist, and the new provenance fields. Proposal suite 39 → 50. |
| 9 | Shape-compat verify + regression | 0.5 | Diffed the `from-proposal` response keys before/after — only additive. Full regression green; end-to-end HTTP check on a full proposal + pricing. |
| 10 | Docs + deploy | 0.5 | API guide pricing note + counts; v2 reference changelog + corrected deployment status; wrote the point-by-point fixes doc back to Sing; pushed to `main`. |

---

## Shipped

- **Pack/case-size price normalization** — the blocker. Flooring/trim no longer quote 5×–25× high.
- **Per-line sanity bands** — a unit mismatch degrades to `unpriced` instead of a wrong number.
- **Dumpster** — floored off the consumer-bag mismatch (now honestly `unpriced` — HD doesn't rent 20-yd
  dumpsters; the budget fallback covers it when a budget is supplied).
- **Scope-of-Work subsection extraction** — matches BuildSuite's proposal format; phases merge into one job.
- **Non-work heading denylist** — Exclusions/Warranty/Permits/Exec-Summary never become takeoffs.
- **`extracted_scope`** — `id`, `area_sqft`, body-level `source_quote`, and populated `notes`.

## Testing

- **524 passing, 0 failing** (was 499): pricing 75→89, proposal 39→50.
- **Response shape verified unchanged** — existing keys identical; only `id`/`area_sqft` added on
  `extracted_scope.sections`. `unit_price`/`line_cost` values corrected (per-unit, not per-case).
- House Intelligence's 186 tests untouched and green.

## Decisions / notes

- **Kept the JSON shape identical on purpose** — BuildSuite is already integrated; correcting values +
  adding fields keeps them working with no changes on their side.
- **Bands live in code** (`PRICE_BANDS`), dataset overrides per line — cheap to tune as real-proposal
  data comes in.
- **Dumpster returns `unpriced`** (honest) rather than a wrong-low bag price. Open question for Sing:
  keep it `unpriced` for a local quote, or add a per-locality placeholder.
- **Budget fallback tops up** — fires when a section's budget ≥ its live-priced materials; documented for
  Sing so the cost-breakdown table feeds it correctly once they remove their slicing workaround.

## Tomorrow / next

- BuildSuite re-tests real proposals against the deploy — retune any pack-title format the normalizer
  misses or any sanity band, same-day.
- Confirm the dumpster placeholder-vs-`unpriced` call with Sing.
- "Who owns the LLM extraction" (Q1) still gates full arbitrary-format proposal fidelity; the deterministic
  path covers the BuildSuite format now.
