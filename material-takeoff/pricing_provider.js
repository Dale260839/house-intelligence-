/**
 * Material Takeoff — Home Depot pricing provider
 * ----------------------------------------------
 * The takeoff engine says WHAT and HOW MUCH to buy. This module answers HOW MUCH IT
 * COSTS by fetching a live unit price per material line, per quality tier
 * (good / better / best), from a third-party Home Depot pricing service.
 *
 * WHY third-party: Home Depot has NO official public pricing API. Live prices come
 * from a service like SerpApi's Home Depot engine or BigBox, activated by
 * HOMEDEPOT_API_KEY. There is NO baked price catalog — that is deliberate (the
 * product owner chose "live only"): without a key, pricing is simply unavailable.
 *
 * Same seams as the rest of the repo:
 *   - zero runtime dependencies (Node core `https` shim, like supabase_store.js);
 *   - a provider interface with an injectable `fetchImpl` so tests never hit the net;
 *   - a `selectPricingProvider(env)` auto-selector mirroring `selectStore()`.
 *
 * Provider interface:
 *   provider.id                         -> 'homedepot_live' | 'mock'
 *   await provider.lookup({ key, query, tier, priceUnit })
 *       -> { ok:true,  unit_price, currency, product_title, product_url, source }
 *        | { ok:false, reason }
 */

const https = require('https');
const { URL } = require('url');

const round2 = n => Math.round(n * 100) / 100;

// ─── zero-dependency HTTPS JSON client (same contract as supabase_store.js) ────
function httpsRequestJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers },
    };
    if (data != null) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(opts, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          async json() { return buf ? JSON.parse(buf) : null; },
          async text() { return buf; },
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request_timeout')));
    if (data != null) req.write(data);
    req.end();
  });
}

// ─── price / product extraction (provider-agnostic) ────────────────────────────
// Third-party APIs disagree on JSON shape. Parse the common ones rather than lock to
// a single vendor: a raw number, a "$12.98" string, {value}, {raw}, {extracted_value}.
function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'object') {
    return parsePrice(v.extracted_value ?? v.value ?? v.amount ?? v.raw ?? v.price);
  }
  // Extract the FIRST monetary number in the string. We intentionally do NOT strip
  // all non-digits: a Home Depot price RANGE like "$10 - $20" would collapse to
  // "1020" and parse as $1,020. Matching the first "1,299.00"-style token and then
  // dropping the thousands commas is range-safe and keeps the decimal intact.
  const m = String(v).match(/[0-9][0-9,]*(?:\.[0-9]+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// PACK / CASE NORMALIZATION (Issue 1): Home Depot lists flooring by the CASE, trim by the
// PACK, tile by the box — and the LISTED price is the whole-package price, with the pack size
// stated in the product title. Read as a per-unit price it over-charges by the pack size (a
// $42.87 "(23.95 sq ft/case)" LVP read as $/sqft is 24× too high; a $128 "(5-Pack — 80 Total
// Linear Feet)" baseboard read as $/stick is 5× too high). Parse the pack size out of the title
// and divide down to the LINE's unit. If nothing parses, the price is returned unchanged and the
// per-line sanity band (min/max_unit_price) is the backstop. Never returns 0/NaN.
function normalizePackPrice(price, priceUnit, title) {
  if (!(price > 0) || !title || !priceUnit) return price;
  const t = String(title);
  const unit = String(priceUnit).toLowerCase();

  // 1) area per package -> per sqft.  "(23.95 sq. ft./case)", "23.95 sqft / case", "covers 23.95 sq ft"
  if (/sq\s*\.?\s*ft|sqft/.test(unit)) {
    const m = t.match(/([\d.]+)\s*sq\.?\s*ft\.?\s*(?:\/|per\s+)?\s*(?:case|carton|box|pallet|bundle|pack|piece|pc)/i)
           || t.match(/covers?\s*(?:up to\s*)?([\d.]+)\s*sq\.?\s*ft/i);
    if (m) { const per = parseFloat(m[1]); if (per > 0) return round2(price / per); }
    return price;
  }

  // 2) linear-foot total -> per LF or per N-ft stick.  "(80 Total Linear Feet)"
  if (/\blf\b|linear|ft\s*stick|stick|molding|moulding|trim|baseboard/.test(unit)) {
    const lfm = t.match(/([\d.]+)\s*(?:total\s*)?(?:linear\s*(?:feet|ft)|lin\.?\s*ft|lf)\b/i);
    if (lfm) {
      const totalLF = parseFloat(lfm[1]);
      if (totalLF > 0) {
        const stick = unit.match(/(\d+(?:\.\d+)?)\s*ft/);
        if (stick) return round2(price / (totalLF / parseFloat(stick[1])));  // per stick
        return round2(price / totalLF);                                       // per LF
      }
    }
    // else fall through to the generic count rule
  }

  // 3) generic count per package.  "Case of 12", "Pack of 6", "(5-Pack)", "2-Pack", "(6-Piece)"
  const pk = t.match(/(?:case of|pack of|box of|set of|bundle of)\s*(\d+)/i)
          || t.match(/\((\d+)\s*[-\s]?(?:pack|piece|pieces|count|ct|pk)\b/i)
          || t.match(/\b(\d+)\s*[-\s]?(?:pack|pieces)\b/i);
  if (pk) { const n = Number(pk[1]); if (n > 1) return round2(price / n); }

  return price;
}

// Make a matched product URL publicly usable. SerpApi returns Home Depot links on the
// `apionline.homedepot.com` API host; the customer-facing product page is on `www`.
function normalizeProductUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url.replace(/:\/\/apionline\.homedepot\.com/i, '://www.homedepot.com');
}

// Pull the first usable product { title, url, price } out of whatever the service
// returned. Covers SerpApi (home_depot: `products`/`product_results`), BigBox
// (`search_results[i].product`), and a flat `{ price, title, link }`.
// OUTLIER GUARD (important): retailers list bulk/pallet SKUs alongside single units and
// they sometimes rank FIRST — a real "cement backer board" search returned a $19,275
// pallet ahead of the $15 sheet, which turned a 400 sqft floor into a $580k quote. So
// rather than blindly taking the first priced result, compare against the MEDIAN price of
// the result set and skip anything wildly above it. Self-tuning (no per-line price tables
// to maintain); opts.maxPrice adds an optional hard ceiling on top.
//
// The SAME failure exists on the LOW side: countertop / vanity-top searches surface 4x4in
// SAMPLE SWATCHES (~$3-5) beside the real slabs, and a swatch read as a per-sqft price
// turns a 40 sqft counter into a ~$160 line — a silent UNDER-statement (the mirror of the
// pallet over-statement). opts.minPrice sets a floor that drops swatch/sample prices.
//   opts.maxPrice      — absolute ceiling for a unit price (drop pallet/bulk SKUs)
//   opts.minPrice      — absolute floor for a unit price (drop sample swatches)
//   opts.outlierFactor — multiple of the median to allow (default 12)
function extractProduct(json, opts = {}) {
  if (!json || typeof json !== 'object') return null;

  const candidates =
    (Array.isArray(json.products) && json.products) ||
    (Array.isArray(json.product_results) && json.product_results) ||
    (Array.isArray(json.search_results) && json.search_results.map(r => r.product || r)) ||
    (Array.isArray(json.results) && json.results) ||
    (json.product ? [json.product] : null) ||
    [json];

  const titleOf = (c) => c.title || c.name || c.product_title || null;

  // Normalize each candidate's LISTED price to the line's unit (pack/case aware — Issue 1)
  // BEFORE any guard runs, so the guards compare real per-unit prices, not case prices.
  let priced = [];
  for (const c of candidates) {
    if (!c) continue;
    const raw = parsePrice(c.price ?? c.current_price ?? c.pricing);
    if (raw == null) continue;
    priced.push({ c, price: normalizePackPrice(raw, opts.priceUnit, titleOf(c)) });
  }
  if (!priced.length) return null;

  // PER-LINE SANITY BAND (Issue 1): a unit mismatch that slips past pack-parsing (a $4 swatch
  // below the floor, a case/pallet above the ceiling) is caught here on the NORMALIZED price.
  // Prefer NO price (-> unpriced_lines / budget fallback) over a wildly wrong one.
  if (opts.minPrice > 0) priced = priced.filter(x => x.price >= opts.minPrice);
  if (opts.maxPrice > 0) priced = priced.filter(x => x.price <= opts.maxPrice);
  if (!priced.length) return null;

  // Median outlier guard (self-tuning; still catches bulk SKUs on lines with no explicit band).
  const sorted = priced.map(x => x.price).slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cap = median * (opts.outlierFactor || 12);

  // First non-outlier; if everything is an outlier (e.g. a single-result search) fall back to
  // the cheapest — a unit price beats a pallet price.
  const pick = priced.find(x => x.price <= cap)
            || priced.slice().sort((a, b) => a.price - b.price)[0];
  const c = pick.c;
  return {
    price: pick.price,
    title: titleOf(c),
    url: normalizeProductUrl(c.link || c.url || c.product_url || c.offer_url || null),
  };
}

/**
 * Build the search URL. If HOMEDEPOT_API_URL contains `{query}` / `{key}` tokens we
 * substitute into it; otherwise we default to SerpApi's Home Depot engine and append
 * the query + key. Keeping this configurable lets a BigBox/RapidAPI user point
 * elsewhere without a code change.
 */
function buildSearchUrl(baseUrl, apiKey, query) {
  const q = encodeURIComponent(query);
  if (baseUrl && (baseUrl.includes('{query}') || baseUrl.includes('{key}'))) {
    return baseUrl.replace(/\{query\}/g, q).replace(/\{key\}/g, encodeURIComponent(apiKey));
  }
  const base = baseUrl || 'https://serpapi.com/search.json?engine=home_depot';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}q=${q}&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Live provider. Hits the configured third-party endpoint once per (line, tier) and
 * returns the first matched product's price. Never throws — a miss/outage degrades to
 * { ok:false, reason } so one un-priceable line can't sink the whole takeoff.
 *
 *   opts.apiKey    — HOMEDEPOT_API_KEY (required)
 *   opts.apiUrl    — HOMEDEPOT_API_URL (optional; SerpApi Home Depot by default)
 *   opts.fetchImpl — inject a fake transport in tests
 */
function createHomeDepotProvider(opts = {}) {
  const apiKey = opts.apiKey || process.env.HOMEDEPOT_API_KEY || '';
  const apiUrl = opts.apiUrl || process.env.HOMEDEPOT_API_URL || '';
  if (!apiKey) throw new Error('createHomeDepotProvider: missing HOMEDEPOT_API_KEY.');
  const fetchImpl = opts.fetchImpl || httpsRequestJson;
  const timeoutMs = opts.timeoutMs || 10000;

  // Within one takeoff the same query can repeat; cache so we bill one call per query.
  const cache = new Map();

  return {
    id: 'homedepot_live',
    source: 'homedepot_live',
    async lookup({ query, minPrice, maxPrice, priceUnit }) {
      if (!query) return { ok: false, reason: 'no_search_term' };
      // Key the cache on the guards + unit too: the same term with a different floor/ceiling or
      // price unit is a different question and must not return a cached answer from another config.
      const cacheKey = `${query}|${minPrice || ''}|${maxPrice || ''}|${priceUnit || ''}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey);

      let result;
      try {
        const res = await fetchImpl(buildSearchUrl(apiUrl, apiKey, query), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          timeoutMs,
        });
        if (!res || !res.ok) {
          const status = res && res.status;
          const reason = (status === 401 || status === 403) ? 'auth_error'
                       : status === 429 ? 'rate_limited'
                       : 'http_' + (status || 'error');
          result = { ok: false, reason, status };
        } else {
          let json;
          try { json = await res.json(); } catch { json = null; }
          const product = extractProduct(json, { minPrice, maxPrice, priceUnit });
          result = product
            ? { ok: true, unit_price: product.price, currency: 'USD',
                product_title: product.title, product_url: product.url, source: 'homedepot_live' }
            : { ok: false, reason: 'no_match' };
        }
      } catch (err) {
        result = { ok: false, reason: 'network_error', detail: String((err && err.message) || err) };
      }
      cache.set(cacheKey, result);
      return result;
    },
  };
}

// ─── mock provider — TEST / LOCAL DEV ONLY, never a production price source ─────
// Deterministic unit prices so the engine + tests have stable numbers WITHOUT a paid
// key or the network. NOT a fallback: it is only ever selected when PRICING_MOCK is
// explicitly set (see selectPricingProvider). These are round, plausible figures, not
// real Home Depot prices.
const MOCK_UNIT_PRICES = {
  base_cabinets:  { good: 120, better: 200, best: 350 },  // per LF
  upper_cabinets: { good: 90,  better: 150, best: 260 },  // per LF
  countertop:     { good: 15,  better: 55,  best: 90  },  // per sqft
  backsplash_tile:{ good: 4,   better: 8,   best: 18  },  // per sqft
  floor_tile:     { good: 2,   better: 4,   best: 9   },  // per sqft
  thinset:        { good: 12,  better: 18,  best: 30  },  // per bag
  grout:          { good: 15,  better: 22,  best: 40  },  // per bag
  drywall_sheets: { good: 12,  better: 16,  best: 22  },  // per sheet
  joint_compound: { good: 15,  better: 18,  best: 24  },  // per bucket
  drywall_tape:   { good: 6,   better: 8,   best: 12  },  // per roll
  drywall_screws: { good: 7,   better: 9,   best: 13  },  // per box
  // bathroom_remodel additions
  wall_tile:              { good: 3,   better: 7,   best: 16  },  // per sqft
  waterproofing_membrane: { good: 45,  better: 110, best: 180 },  // per roll/kit
  cement_backer_board:    { good: 12,  better: 15,  best: 20  },  // per sheet
  vanity:                 { good: 180, better: 320, best: 600 },  // per LF (rough budget)
  vanity_top:             { good: 25,  better: 55,  best: 95  },  // per sqft
  // add-on groups (Phase 4) — all optional, off unless toggled on
  demolition_dumpster:    { good: 130, better: 160, best: 200 },  // per dumpster / bag
  subfloor:               { good: 18,  better: 32,  best: 45  },  // per sheet
  primer:                 { good: 18,  better: 26,  best: 38  },  // per gal
  paint:                  { good: 24,  better: 38,  best: 62  },  // per gal
  baseboard:              { good: 9,   better: 14,  best: 26  },  // per 16 ft stick
  cabinet_hardware:       { good: 2,   better: 5,   best: 12  },  // per pull
  // site_protection add-on group (U5)
  floor_protection:       { good: 22,  better: 40,  best: 75  },  // per roll
  plastic_sheeting:       { good: 15,  better: 24,  best: 45  },  // per roll
  masking_tape:           { good: 5,   better: 8,   best: 13  },  // per roll
  dust_barrier:           { good: 30,  better: 60,  best: 120 },  // per kit
  hepa_filter:            { good: 35,  better: 65,  best: 130 },  // per filter
  // flooring_only lines (Phase 5)
  flooring_tile:          { good: 2,   better: 4,   best: 9   },  // per sqft
  flooring_lvp:           { good: 2,   better: 4,   best: 7   },  // per sqft
  flooring_laminate:      { good: 1,   better: 3,   best: 5   },  // per sqft
  flooring_engineered:    { good: 4,   better: 7,   best: 12  },  // per sqft
  flooring_hardwood:      { good: 5,   better: 9,   best: 15  },  // per sqft
  underlayment:           { good: 20,  better: 35,  best: 60  },  // per roll
  fasteners:              { good: 28,  better: 42,  best: 65  },  // per box
  transitions:            { good: 12,  better: 22,  best: 38  },  // per strip
};

function createMockPricingProvider(opts = {}) {
  const table = opts.prices || MOCK_UNIT_PRICES;
  return {
    id: 'mock',
    source: 'mock',
    async lookup({ key, tier }) {
      const row = table[key];
      const price = row && row[tier];
      if (price == null) return { ok: false, reason: 'no_match' };
      return {
        ok: true, unit_price: price, currency: 'USD',
        product_title: `[mock ${tier}] ${key}`, product_url: null, source: 'mock',
      };
    },
  };
}

/**
 * Auto-select a pricing provider from the environment (mirrors selectStore()):
 *   HOMEDEPOT_API_KEY set          → live Home Depot provider
 *   else PRICING_MOCK truthy       → deterministic mock (dev/test ONLY)
 *   else                           → null  (pricing unavailable — "live only")
 * Returns { provider, label }. A null provider is expected and handled upstream.
 */
function selectPricingProvider(env = process.env) {
  const key = String(env.HOMEDEPOT_API_KEY || '').trim();
  if (key) {
    return {
      provider: createHomeDepotProvider({ apiKey: key, apiUrl: env.HOMEDEPOT_API_URL }),
      label: 'homedepot (live) via HOMEDEPOT_API_KEY',
    };
  }
  // Enable the mock ONLY on an explicitly truthy flag. Treat the usual "off" spellings
  // (0/false/no/off) as disabled so a stray PRICING_MOCK=false in a deploy env can't
  // silently serve fake prices.
  const mockFlag = String(env.PRICING_MOCK || '').trim().toLowerCase();
  if (mockFlag && !['0', 'false', 'no', 'off'].includes(mockFlag)) {
    return { provider: createMockPricingProvider(), label: 'mock (PRICING_MOCK — dev/test only)' };
  }
  return { provider: null, label: 'none — set HOMEDEPOT_API_KEY to enable live pricing' };
}

module.exports = {
  httpsRequestJson,
  parsePrice,
  normalizePackPrice,
  extractProduct,
  buildSearchUrl,
  createHomeDepotProvider,
  createMockPricingProvider,
  selectPricingProvider,
  MOCK_UNIT_PRICES,
};
