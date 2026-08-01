# Material Takeoff — Pricing Stability & Budget Units, Fixed

**From:** Dale
**To:** Sing (BuildSuite)
**Date:** August 1, 2026
**Re:** `Material_Takeoff_Pricing_Issues_for_Dale.md`

---

## 0. Status

**All three issues + the smaller items + the §4 format ask are fixed and tested** (suite 524 → **547**,
0 failing). **JSON response shape unchanged** — values corrected, fields added additively, so your
integration keeps working. Staged for deploy.

Quick root-cause note on Issue 1: it was **not** the pack-size change. The `lookup` had **no retry** and
a 10s timeout, so under concurrency a *different* subset of lines timed out each run (`network_error`).
A bathroom proposal (~22 lines) doubled the odds vs a single kitchen, which is why it surfaced now.

---

## 1. Issue 1 — pricing stability — FIXED

Three parts:

1. **Retry.** Transient failures (network/timeout/rate-limit) are now retried with backoff before giving
   up. A genuine `no_match` / `auth_error` is not retried. This alone removes most of the per-run
   variance you saw.
2. **One degrade signal.** The `pricing` block now carries **`priced_count`** and **`unpriced_count`**,
   and **`pricing.ok` flips to `false`** with `reason: "pricing_degraded"` once more than **25%** of
   lines fail. That guard now lives in the payload — you can hide the profit layout off `pricing.ok`
   instead of the >25% check on your side.
3. **The budget makes it deterministic.** With a materials budget supplied (see Issue 2), the fallback
   fills any still-unpriced lines, so the total is budget-anchored and stable even when SerpApi drops a
   few lines. `ok` stays `true` because nothing is left unpriced.

Tune knob if you want: `PRICING_MAX_RETRIES` (env, default 2).

---

## 2. Issue 2 — budget-fallback units — FIXED

You were right: `budget_total` is the **client price**, and spreading it across materials only was the
$36k bug. The fallback now scales client-price budgets by a **materials share** before using them.

**My call on the contract (you deferred it):** keep sending `budget_total` — no payload change — and the
API applies a **0.35 materials share** (materials are ~30–45% of a line item). Override per call with
`materialsShare`. If you'd rather send the already-split number, use `materials_budget` and it's applied
as-is.

| Field you send | Unit | What we do |
|---|---|---|
| `budget_total` | client price | × `materialsShare` (default **0.35**) |
| `budget_sections[].amount` | client price | × `materialsShare`, matched to a section by trade |
| `materials_budget` | materials | used as-is (bypasses the share) |
| `materialsShare` | ratio | override the 0.35 default |

**Your San Antonio bathroom, re-run** (provider deliberately missing ~half the lines, `budget_total:
15000`):

| | materials_cost | client price |
|---|---|---|
| Before (the bug) | ~$15,000 | ~$36,000 |
| **After** | **~$4,100** | **~$9,800** |

Reconciles cleanly, and it no longer explodes. Send me the cost table whenever you're ready — trade
labels are matched to sections automatically.

---

## 3. Issue 3 — merged section label — FIXED

A merged section is now named by its resolved trade:
`"Bathroom Remodel — merged from 7 scope subsections"` — not the first subsection's "Pre-Construction /
Site Protection" heading. Quantities were already right; now the name matches.

---

## 4. Smaller items — FIXED

- **`demolition_dumpster` reason.** It now short-circuits the live call and returns
  **`reason: "not_retail_sku"`** (distinct from `network_error`), so you can render it as a "local
  quote" line with confidence.
- **Assumed area.** The bathroom default dropped **100 → 50 sqft** (closer to a real 40–60 sqft bath),
  and every proposal response now carries a top-level **`assumptions[]`** listing each section whose
  area was assumed (`{ section_id, area_sqft, message }`) — surfaced at the response level, not just in
  `notes`. Keep sending area explicitly where the SOW has it and this won't fire.

---

## 5. §4 — your proposal's bolded-bullet format — SUPPORTED (delete your transform)

The extractor now accepts **`- **Title**: body`** bullets under `## Scope of Work` as subsections, so
you can **delete the rewrite step** — send the proposal as your renderer writes it. Verified: a kitchen
+ flooring bulleted SOW comes back as 2 sections; a bathroom comes back as 1.

**Bonus fix I found while testing your Issue 1 repro:** that bathroom was splitting into a `composite`
(bathroom + a spurious `flooring_only @ 300 sqft`) because the "Backer Board, Waterproofing & Tile"
phase says "floor tile" but has no bathroom keyword. In a bathroom scope, floor tile *is* the bathroom —
so a weak "floor tile" phase now folds into the dominant room. Your repro now returns **one
`bathroom_remodel`**. A real LVP/hardwood flooring job still splits out (it has a strong signal).

---

## 6. Shape compatibility

Existing keys unchanged. New (additive) fields: `pricing.priced_count`, `pricing.unpriced_count`,
`pricing.reason` (only when degraded), top-level `assumptions[]` on proposal responses. `unit_price` /
`line_cost` / `materials_cost` values are corrected, not reshaped.

---

## 7. What I need from you

Nothing blocking — just a heads-up on the budget contract: **keep sending `budget_total` and we apply
0.35**, or send `materials_budget` / a `materialsShare` if you'd rather control the split. Tell me if
0.35 is off for your typical jobs and I'll retune the default.

Re-test whenever the deploy lands; same-day turnaround on anything still off, especially any pack-title
format the normalizer misses or a sanity band you want adjusted. Thanks again for the crisp repros.

— Dale
