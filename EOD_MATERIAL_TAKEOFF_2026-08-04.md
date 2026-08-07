# EOD — Material Takeoff: pricing reliability + SerpApi outage response

**Date:** 2026-08-04
**Component:** `material-takeoff/` service
**Time:** ~8h
**Status:** Complete — committed, **not deployed** (coordinating with the frontend dev before push). JSON response shape kept compatible.

---

## Summary

Contractor pricing was returning inconsistent and failing prices in production. Spent the morning
diagnosing it to an **upstream SerpApi Home Depot outage** (searches taking 55–90s, some returning a
200-with-error body) — not our code, not credits. Then built the resilience layer so the service
**degrades gracefully and stays stable through provider slowness** instead of hanging: a circuit
breaker, a persistent price cache, a total-time budget with partial results, and handling for SerpApi's
"200 but no price" responses. SerpApi recovered by end of day and prod is pricing again. Suite
547 → **559**, response shape additive-only.

---

## Time breakdown (8h)

| # | Block | h | What got done |
|---|---|---|---|
| 1 | Prod + SerpApi diagnosis | 1.5 | Reproduced the failures against prod, then called SerpApi **directly** to isolate it: Home Depot searches taking 55–90s (one erroring at 90s) vs our 10s timeout → every line drops. Ruled out key/credits/account (checked quota, tested two different keys — both still 55–90s). Confirmed it's an upstream SerpApi engine outage. |
| 2 | Circuit breaker + fail-fast | 1.25 | After N consecutive transient failures within a request, stop calling the dead provider and fail the rest fast (`provider_unavailable`) → budget fallback, instead of hanging 10–15s per line. Retry loop aborts once the breaker trips. Env `PRICING_BREAKER_THRESHOLD`. |
| 3 | Persistent price cache | 1.25 | Module-level TTL cache (default 24h) shared across requests via the provider selector; per-instance in tests so no state leaks. Scrape each fixed search term once, reuse it — instant + far cheaper after warm-up, and a warm cache carries prices *through* the next outage. Env `PRICE_CACHE_TTL_MS`. |
| 4 | Total-time budget → partial results | 1.0 | Whole pricing pass capped (default 20s, env `PRICING_MAX_TOTAL_MS`); past it, remaining lines return `reason: "pricing_timeout"` and the block sets `pricing.timed_out: true`. Each in-flight lookup's own timeout is capped to the remaining budget. (The frontend dev's explicit ask — "no contractor sits through a 3-minute wait.") |
| 5 | SerpApi 200-with-error handling | 0.5 | A 200 whose body says the scrape errored (`search_metadata.status: "Error"` / `error` field) is now a transient `provider_error` — retried + counted by the breaker — instead of a silent `no_match`. Fixes the "200 but no price on half the lines" mode. |
| 6 | Tests | 1.0 | Circuit breaker trips + fast-fail, one flaky line doesn't trip, cross-request cache reuse, TTL expiry, failures not cached, partial-on-budget + `timed_out`, 200-error is transient/retried. +12 today. |
| 7 | Docs + handoffs | 1.0 | v2 reference + API_GUIDE (reliability + new fields), and two handoff docs for the frontend dev (the SerpApi diagnosis, and today's changes point-by-point against his asks). |
| 8 | Recovery verify + commits | 0.5 | Re-tested SerpApi (recovered to ~4–8s; prod pricing 8/11 with real prices again), and staged 3 commits. |

---

## Shipped (committed, not deployed)

- **Circuit breaker** — fail fast when the provider is down, no more per-line hangs.
- **Persistent price cache** — scrape once, reuse; cheaper, faster, outage-surviving.
- **Total-time budget** — partial results + `pricing.timed_out` flag instead of a long wait.
- **200-with-error handling** — transient, not silently dropped.

3 commits ready: `8ee7013` (prior pricing/budget fixes) · `ccd7d5d` (breaker + cache) · `6e06acf`
(time budget + 200-error).

## Testing

- **559 passing, 0 failing** (+12 today).
- **Response shape verified additive-only** — new fields (`priced_count`, `unpriced_count`, `timed_out`)
  are omitted unless set; existing keys/line shape unchanged, so the frontend integration keeps working.

## Decisions / notes

- **Root cause was upstream (SerpApi), not our code or credits** — proven by direct calls from a
  separate network. Nothing on our side makes a hung scraper faster; the work was about degrading
  cleanly and staying stable when a provider misbehaves.
- **Retry is bounded on both ends** (circuit breaker + total-time budget), so it can't turn a slow
  provider into a longer hang — and given SerpApi's own cache-warm behavior (a 16s search became 0.2s on
  the retry), it usually speeds a line up.
- **Held the deploy** — the frontend dev has pending changes in his integration file and asked to be
  pinged before any push.

## Tomorrow / next

- Get the frontend dev's go-ahead, then push all three commits (auto-deploys).
- Watch the first live takeoffs post-deploy: confirm the cache warms and `pricing.timed_out` behaves.
- Consider a lower default time budget if 20s feels long once the cache is warm, and revisit whether a
  second pricing provider is worth adding so one provider's outage can't take pricing down.
