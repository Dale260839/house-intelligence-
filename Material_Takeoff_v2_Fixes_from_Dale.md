# Material Takeoff v2 — Fixes for the Issues You Found

**From:** Dale
**To:** Sing (BuildSuite)
**Date:** July 29, 2026
**Re:** `Material_Takeoff_v2_Issues_for_Dale.md`

---

## 0. Status

**All three issues + the smaller items are fixed, deployed to production, and verified.**
The **JSON response shape is unchanged** — I only corrected values and added fields. Nothing was
removed or renamed, so your integration keeps working as-is. Suite is at **524 tests, 0 failing**.

**One thing for you:** you can now **remove the `## Scope of Work` slicing workaround** — the service
handles the full proposal itself (details in §5). That also unblocks you sending the **cost breakdown
table**, which feeds the budget fallback (§6).

---

## 1. Issue 1 — pack/case-size pricing (the blocker) — FIXED

Two layers, so a unit mismatch can't produce a 5×–25× price again:

**(a) Pack/case normalization.** The matcher now parses the pack size out of the product title and
divides the listed price down to the line's unit *before* costing:

| Product title | Listed | Normalized | Line (your repro) |
|---|---|---|---|
| `... LVP Flooring (23.95 sq ft/case)` | $42.87 | **$1.79 / sqft** | 1400 sqft → **~$2,681** (was $64,219) |
| `... Baseboard Moulding (5-Pack — 80 Total Linear Feet)` | $128 | **$25.60 / stick** | 10 sticks → **~$256** (was $1,280) |

Handles `(N sqft/case)`, `(5-Pack)`, `Case of N`, `Pack of N`, `(N Total Linear Feet)`, `(N-Piece)`.
If a title has no parseable pack size, the price is left as-is and layer (b) is the backstop.

**(b) Per-line sanity bands.** Exactly your suggestion — a plausible range per line key, applied to the
*normalized* price. Anything outside the band is a unit mismatch, not a real price, so the line is
**dropped to `unpriced_lines`** rather than shipped as a wrong number. Current bands:

| Line | Band (per its unit) |
|---|---|
| LVP / laminate | $1–8 / sqft |
| engineered / hardwood | $3–18 / sqft |
| tile (floor/wall/backsplash) | $1–30 / sqft |
| countertop / vanity top | $8–150 / sqft |
| baseboard | $8–70 / 16 ft stick |
| drywall | $8–40 / sheet |
| dumpster | ≥ $200 (floors out the consumer bag) |

Bands live in code (`PRICE_BANDS` in `pricing_engine.js`); a per-line `min/max_unit_price` in the
dataset overrides them. Easy to tune — send me any you want adjusted.

**(c) The dumpster.** You were right that it's a search-term problem. I retuned it off "bagster … in a
bag" to a rental term **and** floored it at $200. Net effect: **Home Depot genuinely doesn't rent 20-yard
dumpsters, so this line now returns `unpriced` (with a reason) instead of a wrong $89.85.** Show it as a
"get a local quote" line, or send a budget line for it and the fallback will estimate it (§6).

---

## 2. Issue 2 — extraction only captured one trade — FIXED

The service now understands your proposal structure. When a **`## Scope of Work`** heading is present,
its **`### N.` subsections** are the work areas. Phase subsections (Pre-Con/Site Protection, Demolition,
Rough Plumbing, Flooring…) are classified and **merged into one job with their add-ons**.

Your flooring proposal now returns exactly what you'd expect:

```
1 section  →  flooring_only, 1400 sqft
add_ons    →  ["demolition", "subfloor", "trim", "site_protection"]
```

No headings, no LLM, no dependency — deterministic. (The LLM path is still there behind the seam for
arbitrary formats when you want it; that's the open ownership call.)

---

## 3. Issue 3 — every heading became a section — FIXED

Two guards:

1. **Only Scope-of-Work subsections count.** Executive Summary, Exclusions, Warranty, Permits, etc. live
   *outside* `## Scope of Work`, so they're never treated as work areas.
2. **Denylist backstop** for proposals with no Scope-of-Work wrapper: executive summary, exclusions,
   warranty, permits, investment/payment, timeline, materials, assumptions, allowances, etc. are dropped.

Your exact repro (`## Executive Summary` + `## Scope of Work → ### 1. Bathroom` + `## Exclusions` +
`## Warranty` + `## Permits`) now returns **1 section** (the bathroom, 75 sqft) — not 3, not 12. The
skipped headings are listed in `notes` for transparency. **Exclusions no longer generates a kitchen.**

Related: a section with no stated area is no longer silently sized to a full room — it's flagged in
`notes` ("… no area stated — assumed N sqft (verify)").

---

## 4. Smaller items — FIXED

- **`extracted_scope.sections[].id`** — now populated (matches the line-level `section_id`).
- **`extracted_scope.sections[].area_sqft`** — now populated (e.g. `1400`), so your UI panel isn't blank.
- **`source_quote`** — now a sentence from the section **body** (a measurement or trade line), not the
  heading.
- **`notes`** — now populated: skipped non-work headings, assumed-area flags, and remove-and-reinstall
  decisions. This is your trust layer, so it's no longer empty.
- **Deployment status in the reference doc** — corrected to "live in production."

---

## 5. You can remove the Scope-of-Work slicing workaround

The service now does the filtering itself, so **send the whole proposal** — Executive Summary,
Exclusions, Warranty, Permits and all. It will pull only the Scope-of-Work subsections. I verified a
full 12-heading proposal collapses to the correct single section.

Removing the slice is what lets you send me the **cost breakdown table** again → §6.

---

## 6. Cost breakdown → budget fallback (how to send it)

Send the breakdown as **`budget_sections`** (and/or `budget_total`) on the `from-proposal` call:

```jsonc
{
  "proposal_markdown": "…the full proposal…",
  "budget_total": 18000,
  "budget_sections": [
    { "label": "Flooring", "amount": 9000 },
    { "label": "Bathroom", "amount": 6000 }
  ],
  "price": true, "tier": "better"
}
```

- Each `budget_sections` label is matched to a section by trade keyword (`flooring`/`bathroom`/`kitchen`)
  and becomes that section's materials budget. A single-section job can just use `budget_total`.
- When a line can't be live-priced (e.g. the dumpster rental), the **remaining budget after the priced
  lines is spread across the unmatched lines**, tagged `price_source: "proposal_budget"`, so the total
  never silently understates. Totals still reconcile (`materials + labor = total`, `price − total =
  profit`).
- **Semantics to know:** the fallback *tops up* — it fires when a section's budget is **≥ its
  live-priced materials**. If a budget line is smaller than what the priced lines already come to, the
  unmatched line stays in `unpriced_lines` (visible as "price n/a") rather than inventing cost. So send
  the section's **full materials budget**, not a sub-line, for the top-up to work. With the Issue-1
  pricing fixes in place, most lines price directly and the fallback is now an edge case (mainly the
  dumpster).

---

## 7. Shape compatibility (so you can deploy without re-checking)

I diffed the response keys before/after. **All existing keys are unchanged**; the only additions are:

- `extracted_scope.sections[]`: **+`id`, +`area_sqft`** (plus `section_id`, kept alongside)
- material lines already carried `section_id` / `source_quote` / `confidence` from the last release

Top-level keys, `pricing` keys, and `pricing.lines[]` keys are identical. `unit_price` / `line_cost`
values are now correct (per-unit, not per-case), which is the fix — not a shape change.

---

## 8. Deploy + turnaround

- **Live in production now** (pushed to `main`, auto-deployed).
- **524 tests passing**, including new coverage for pack normalization, the sanity bands, Scope-of-Work
  parsing, and the denylist.

Please re-run your real generated proposals against it and send me anything that still looks off —
especially any pack-title format the normalizer misses or any sanity band you want retuned. Same-day
turnaround on my side. Thanks for the detailed repros; they made this fast.

— Dale
