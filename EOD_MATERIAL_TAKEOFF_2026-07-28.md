# EOD — Material Takeoff v2 (from-scope, from-proposal, extraction layer)

**Date:** 2026-07-28
**Component:** `material-takeoff/` service
**Time:** ~8h
**Status:** Complete — staged for review, pending deploy. `POST /material-takeoff` unchanged.

---

## Summary

Built out the v2 surface of the takeoff service against the Sing/BuildSuite contract: two new
endpoints (`from-scope` for multi-room jobs, `from-proposal` for free-text proposals), the extraction
layer behind a provider seam, per-line provenance + budget fallback, site-protection materials, the
countertop swatch pricing fix, and a print-ready export. Everything is additive — the existing
single-room endpoint is byte-for-byte compatible. Suite went from 357 → **499 tests, all green**.

---

## Time breakdown (8h)

| # | Block | h | What got done |
|---|---|---|---|
| 1 | Validation / audit | 0.5 | Audited current code against the v2 contract, wrote the EXISTS/GAPS/MISSING matrix, confirmed the 357-test baseline before touching anything. |
| 2 | U4 — countertop price fix | 0.5 | Added a low-side `min_unit_price` floor to the price matcher (mirror of the pallet guard) so a $4 sample swatch stops understating a countertop; retuned the countertop/vanity-top search terms off the swatch match. +8 tests. |
| 3 | U1 — multi-section aggregator | 1.5 | New `scope_engine.js`: `POST /from-scope` takes a `sections[]` array, runs each section's builder, merges into one takeoff, `project_type:"composite"` when >1. `add_ons[]`→toggle mapping, section-id generation/dedup. |
| 4 | U2 — source_type + section_id | 0.75 | Threaded `source_type` (manual/scope/proposal) + per-line `section_id` through the engine and pricing. Refactored the per-line pricer into a shared helper so single + multi-section reuse one code path. |
| 5 | U3 — budget fallback + price_source | 1.0 | Unmatched lines no longer silently drop from the total — they fall back to a budget-derived estimate tagged `price_source:"proposal_budget"`. Kept totals reconciling. +12 tests. |
| 6 | U5 — site protection + passthrough | 1.0 | New `site_protection` add-on group (floor protection, sheeting, tape, dust barriers, HEPA — all area-derived) across all 3 types; dataset rates + search terms + mock prices; `passthroughLine` for long-tail items. +13 tests. |
| 7 | U6/U7 — proposal extraction | 1.75 | `extraction_provider.js`: LLM behind a seam (temp 0, structured, **cached by proposal hash**) with a deterministic heuristic fallback so it works with no key. `POST /from-proposal` → extracted scope → takeoff with per-line `source_quote`/`confidence`. Remove-and-reinstall generates no new item; prefers stated quantities; "no scope" returns ok:false at HTTP 200. +39 tests. |
| 8 | U8 — print/PDF export | 0.5 | `format=html` (a.k.a. print/pdf) on all three routes → self-contained print-ready sheet the browser saves as PDF. No server-side PDF engine (keeps the zero-dependency guarantee). |
| — | Docs + regression + stage | (in blocks) | v2 sections in `API_GUIDE.md`, new `MATERIAL_TAKEOFF_v2.md`, full regression, staged the diff. |

---

## Shipped

- **`POST /material-takeoff/from-scope`** — whole-job takeoff from a `sections[]` array; one merged
  response, one labor line, one profit layout; every line stamped with its `section_id`.
- **`POST /material-takeoff/from-proposal`** — free-text proposal → extracted scope → takeoff, with
  `extracted_scope`, per-line `source_quote` + `confidence`, and the LLM/heuristic behind a seam.
- **`format=html`** print-ready export on every route.
- **New fields** everywhere: `source_type`, per-line `section_id`, `price_source`, plus
  `source_quote`/`confidence` on proposal responses.
- **Budget-derived pricing fallback** so a missed price never silently understates a job.
- **Site-protection materials** + long-tail passthrough lines.
- **Countertop/vanity-top swatch pricing fix.**

## Testing

- **499 passing, 0 failing** (was 357). New coverage: add-ons 40, pricing 75, scope 63, proposal 39,
  HTTP 58 — plus the LLM seam exercised with an injected transport (no network).
- House Intelligence's 186 tests untouched and green — separate service, shared repo.
- Everything degrades instead of crashing: bad price, unmatched line, extraction miss, or bad section
  all return a clean `ok:false` / fallback, never a 500.

## Decisions / notes

- **PDF = print-ready HTML, not a server-side binary.** A real PDF engine would break the
  zero-dependency rule; the browser owns the paper.
- **Extraction defaults to a deterministic heuristic** when no LLM key is present, so `from-proposal`
  works today; the real LLM switches on with `EXTRACTION_API_KEY`. This is the open "who owns the LLM"
  question — the code is ready either way.
- **`order_discount`** (volume pricing) left as a documented seam in the profit layout, not yet applied.
- **Plan gating stays a BuildSuite concern** — the API always returns the full payload.

## Tomorrow / next

- Get the "who owns the LLM extraction" call so `from-proposal` can run at full fidelity in prod.
- Wire the `order_discount` step into the profit layout.
- Add the new room types from the huddle (drywall-only, bedroom, living room) — small per-type builders;
  the composite aggregator already handles them once they exist.
- Deploy v2 + smoke the two new endpoints against prod.
