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

// Pull the first usable product { title, url, price } out of whatever the service
// returned. Covers SerpApi (home_depot: `products`/`product_results`), BigBox
// (`search_results[i].product`), and a flat `{ price, title, link }`.
function extractProduct(json) {
  if (!json || typeof json !== 'object') return null;

  const candidates =
    (Array.isArray(json.products) && json.products) ||
    (Array.isArray(json.product_results) && json.product_results) ||
    (Array.isArray(json.search_results) && json.search_results.map(r => r.product || r)) ||
    (Array.isArray(json.results) && json.results) ||
    (json.product ? [json.product] : null) ||
    [json];

  for (const c of candidates) {
    if (!c) continue;
    const price = parsePrice(c.price ?? c.current_price ?? c.pricing);
    if (price != null) {
      return {
        price,
        title: c.title || c.name || c.product_title || null,
        url: c.link || c.url || c.product_url || c.offer_url || null,
      };
    }
  }
  return null;
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
    async lookup({ query }) {
      if (!query) return { ok: false, reason: 'no_search_term' };
      if (cache.has(query)) return cache.get(query);

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
          const product = extractProduct(json);
          result = product
            ? { ok: true, unit_price: product.price, currency: 'USD',
                product_title: product.title, product_url: product.url, source: 'homedepot_live' }
            : { ok: false, reason: 'no_match' };
        }
      } catch (err) {
        result = { ok: false, reason: 'network_error', detail: String((err && err.message) || err) };
      }
      cache.set(query, result);
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
  extractProduct,
  buildSearchUrl,
  createHomeDepotProvider,
  createMockPricingProvider,
  selectPricingProvider,
  MOCK_UNIT_PRICES,
};
