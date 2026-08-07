# Material Takeoff — What Changed Today (Reliability)

**From:** Dale
**To:** Sing (BuildSuite)
**Date:** 2026-08-04
**Re:** your note on the two SerpApi failure modes + "cap total pricing time, ping me before you push"

---

## 0. TL;DR

- **SerpApi recovered.** Its Home Depot engine was hanging (55–90s/search); it's back to ~4–8s now,
  so prices are flowing again — a live prod kitchen call returned **8/11 lines with real prices**
  (only the slowest few timed out). Still a bit **intermittent** (I saw 0.2s, 8s, and 16s across runs).
- **I addressed both failure modes you named** — the genuine timeouts *and* the "HTTP 200 but no price
  on half the lines." Details below.
- **Response shape is unchanged** — everything new is additive, so your integration keeps working.
- **Not deployed yet.** You asked me to ping before pushing (your pending `material_takeoff.py`), so
  the 3 commits are staged and waiting on your go-ahead.

---

## 1. Root cause (confirmed)

You were right that it's the SerpApi side. I proved it by calling SerpApi **directly** (bypassing our
service): searches were taking 55–90s, and one returned `status: "Error"` after 90s. Our per-lookup
timeout is 10s, so every line gave up long before SerpApi answered. **Quota/credits were never the
issue** — I checked, 989→997 searches left. It was purely SerpApi's Home Depot engine being throttled
by Home Depot. It has since recovered.

---

## 2. What changed today — mapped to your two failure modes

### (a) Genuine timeouts / hanging → **total-time budget + partial results + a flag** (your explicit ask)

> *"cap total pricing time and return partial results with a flag rather than hanging. No contractor is
> going to sit through a 3-minute wait."*

Done. A **total-time budget** (default **20s**, env `PRICING_MAX_TOTAL_MS`) caps the whole pricing pass.
Past it, the remaining lines return as partial with `reason: "pricing_timeout"`, and the block sets:

```jsonc
"pricing": { "timed_out": true, ... }   // present ONLY when the pass was cut short
```

Plus a **circuit breaker**: if the provider is down, after a few consecutive failures we stop calling it
and fail the rest fast (`reason: "provider_unavailable"`) — no waiting out a dead provider.

On your point that **"retries with backoff will make it slower, not faster"** — you're right that a
naive retry would. So it's bounded on both ends: the circuit breaker aborts retries during an outage,
and the total-time budget is a hard ceiling. And given SerpApi's own caching (I watched a 16s search
become **0.2s** on the very next call), a retry usually lands on their warm cache and *speeds a line up*
rather than slowing it. Net: capped worst case, faster typical case.

### (b) "HTTP 200 but no price on half the lines" → **treated as transient, not silently dropped**

That case is SerpApi returning a 200 whose body says the scrape errored (`search_metadata.status:
"Error"` / an `error` field). We were reading that as a genuine `no_match` and dropping it silently.
Now it's a **transient `provider_error`** — it retries and counts toward the breaker, so those lines get
a second chance (often the cache-warm 0.2s hit) instead of vanishing from the total.

### (c) Structural: **persistent price cache**

Our search terms are a small fixed set, so each successful price is now **cached and reused across
requests** (TTL 24h). Effect: instant + far cheaper after warm-up, and a cache warmed before an outage
keeps serving prices *through* the next one. This is also the real answer to credit burn — we stop
re-scraping the same terms every takeoff.

---

## 3. New response fields (all additive — nothing removed or renamed)

| Field | Where | Meaning |
|---|---|---|
| `pricing.priced_count` / `pricing.unpriced_count` | pricing block | counts, so you don't walk two arrays |
| `pricing.ok` → `false` | pricing block | now flips false with `reason: "pricing_degraded"` when >25% of lines fail — **one signal to hide the profit layout** (you asked for exactly this last round) |
| `pricing.timed_out: true` | pricing block | present only when the time budget/breaker cut the pass short |
| line `reason` values | unpriced line | `pricing_timeout`, `provider_unavailable`, `provider_error`, `not_retail_sku` (distinct from `network_error` / `no_match`) |
| `assumptions[]` | top level (proposals) | sections whose area was assumed |

`unit_price` / `line_cost` / `materials_cost` **values** are corrected (per-unit, not per-case; budget
scaled by a materials share), but the **shape is identical**. Guarding on `pricing.ok` is enough.

---

## 4. Env knobs (so you/Chris can tune without a code change)

`PRICING_MAX_TOTAL_MS` (20s) · `PRICING_TIMEOUT_MS` (12s per lookup) · `PRICING_MAX_RETRIES` (2) ·
`PRICING_BREAKER_THRESHOLD` (5) · `PRICE_CACHE_TTL_MS` (24h).

---

## 5. What this means for you

- **Nothing to change on your side to keep working** — shape is compatible.
- **Recommended:** hide the profit layout when `pricing.ok === false` (covers degraded *and* timed-out),
  and optionally show "prices still loading / partial" when `pricing.timed_out` is set. Your existing
  >25% guard can move to `pricing.ok`.
- Quantities/takeoffs are unaffected and always return.

---

## 6. Coordination — I have NOT pushed

Per your note (*"ping me before you push, I have pending changes in material_takeoff.py"*), the three
commits are staged and **not deployed**:

- `8ee7013` — Aug-1 fixes (pack pricing, budget units, scope-of-work, labels)
- `ccd7d5d` — circuit breaker + persistent price cache
- `6e06acf` — total-time budget + 200-error handling

**Give me the go-ahead when your `material_takeoff.py` changes are in a safe state and I'll push** (it
auto-deploys). Since SerpApi is healthy again, deploying will make pricing both work *and* stay stable
through the next slow patch.

— Dale
