# EOD — Material Takeoff (Pricing & Profit Layer)

**Date:** 2026-07-09
**Module:** `material-takeoff/` (sibling of House Intelligence, same repo)
**Scope of the day:** Add live pricing + a profit layout on top of the existing quantity engine.

---

## Summary

Built a complete **pricing & profit layer** for the kitchen-remodel takeoff. The takeoff previously
returned quantities only; it now (opt-in) prices every material line at a chosen quality tier from a
**live Home Depot third-party API**, adds a labor line, and produces a **profit layout** showing cost
→ markup → client price → profit + margin. The quantity engine and all its existing tests were left
untouched — pricing is a separate, additive, async layer.

**Result:** all tests green — **57 engine + 48 pricing + 33 server = 138 passing.** Verified
end-to-end over HTTP.

---

## What was delivered

**1. Pricing tiers (good / better / best)**
- Each material line maps to a Home Depot search term per quality grade (builder / mid / premium).
- Configured in `material_dataset.json` for all 11 material lines + defaults + disclaimers.

**2. Live Home Depot pricing**
- `pricing_provider.js` — third-party API adapter over the repo's zero-dependency HTTPS shim.
- Provider-agnostic: SerpApi default, `HOMEDEPOT_API_URL` template supports BigBox/RapidAPI.
- Robust price/product parser (handles multiple JSON response shapes), per-request caching, graceful
  degradation (a miss/outage never fails the request), and an env-based auto-selector.
- Deterministic mock provider for dev/tests (no key, no network).
- Design decision: **live-only, no baked price catalog** — no key → pricing unavailable, quantities
  still return.

**3. Profit layout**
- `pricing_engine.js` — per-line cost (unit price × order qty), a labor line (default 100% of
  materials, overridable), and a profit layout showing **both markup % and implied margin %**.
- Handles tiers, unpriced-line reporting, and text rendering.

**4. API + UI + docs**
- `server.js` — opt-in `price=true` (async), tier/markup/labor params; backwards compatible.
- `test-page.html` — pricing controls (tier, markup, labor) + a profit-layout table.
- `test_pricing.js` — 48 new tests; server pricing tests added; `package.json` wired.
- Docs updated: `README.md`, `API_GUIDE.md` §4b, repo-root `.env.example`.

**Files:** +3 new (`pricing_provider.js`, `pricing_engine.js`, `test_pricing.js`),
~6 modified (`material_dataset.json`, `server.js`, `test_server.js`, `test-page.html`, `README.md`,
`API_GUIDE.md`, `package.json`).

---

## Status / next steps
- ✅ Built, tested, working locally.
- ⚠️ **Not yet committed or deployed** — production still serves quantities only.
- 🔜 To ship: commit → redeploy → set `HOMEDEPOT_API_KEY` → make one real call to confirm the live
  third-party response shape parses (recommended vendor: BigBox API, free 100-request trial).

---

## Estimated professional developer effort

_Realistic hours for a competent mid-level developer to produce this from scratch — design, build,
test, and document (excludes the final paid-API live verification, which is blocked on the key)._

| Task | Hours |
|---|---|
| Requirements + design decisions (tier model, live-only vs. catalog, markup+margin, labor basis) | 1.5 – 2.5 |
| Pricing dataset config (research realistic Home Depot search terms per line, tiers, defaults) | 2.0 – 3.0 |
| `pricing_provider.js` — third-party API integration, provider-agnostic parser, mock, selector, error handling | 4.0 – 6.0 |
| `pricing_engine.js` — tier selection, per-line costing, labor, markup/margin layout, text render | 3.0 – 4.0 |
| Server wiring (opt-in, async, param coercion, backwards-compat) | 1.0 – 1.5 |
| Tests (48 pricing incl. fake-transport live-provider parsing + server route tests) | 3.0 – 4.0 |
| Docs + test-page pricing UI (README, API_GUIDE §4b, .env, HTML controls + profit table) | 2.0 – 3.0 |
| Manual testing, debugging, iteration | 2.0 – 3.0 |
| **Total** | **~18.5 – 27 hours** |

**Point estimate: ~22 hours (≈ 3 working days).**

Notes on the range:
- **Senior dev** familiar with the codebase: closer to the low end (~16–18 hrs).
- **Mid-level dev** or first-time in this repo: closer to the high end (~26–28 hrs).
- **API integration is the biggest variable** — third-party Home Depot APIs vary in response shape and
  reliability; making the parser robust and handling failure modes is where hours accumulate.
- Add **~2–4 hrs** later for live-API verification + tuning once a paid key is in hand.
