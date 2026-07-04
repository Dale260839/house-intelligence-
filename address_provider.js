/**
 * House Intelligence — Address → Build Year provider layer
 * --------------------------------------------------------
 * The lookup engine (lookup_engine.js) needs a YEAR (and optional state). The
 * real product takes an ADDRESS. This module is the vendor-agnostic seam between
 * the two: it defines one contract — `resolveBuildYear(address)` — and an
 * orchestrator, `resolveScopeForAddress(address, { provider })`, that turns an
 * address into a full era-based scope of work by resolving the year and handing
 * it to the existing engine.
 *
 * Design intent:
 *   - Nothing here is tied to any one data vendor. Swap the property-data source
 *     by passing a different provider. The engine never changes.
 *   - It is deterministic and dependency-free; the bundled MockProvider lets the
 *     whole address→scope path be unit-tested with no network and no API key.
 *   - When a year can't be resolved, we degrade gracefully to the engine's
 *     standard "no valid year" scope rather than throwing — the contractor still
 *     gets a proposal, just without era-specific items.
 *
 * IMPORTANT (unchanged product principle): output is "likely / inspect for",
 * never "guaranteed present". This layer only changes how we obtain the year.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROVIDER CONTRACT  (what any real adapter must implement)
 *
 *   provider.id : string            // short source id, e.g. 'rentcast'
 *   async provider.resolveBuildYear(address) -> BuildYearResult
 *
 *   BuildYearResult = {
 *     ok:        boolean,           // true if a usable build year was found
 *     year:      number | null,     // 4-digit build year, or null
 *     state:     string | null,     // 2-letter state if the source returns it
 *     source:    string,            // provider id that answered
 *     confidence:'exact'|'estimated'|'unknown',
 *     reason?:   string,            // when !ok: 'not_found' | 'year_unknown' | 'provider_error' | ...
 *     property?: PropertyDetails,   // OPTIONAL richer "what is this house" record (see below)
 *     raw?:      any                // raw provider payload, for debugging/audit
 *   }
 *
 *   PropertyDetails (optional, vendor-mapped — "more information about the house"
 *   for the proposal/UI; the engine NEVER reads it, it only needs the year+state):
 *   {
 *     propertyType, squareFootage, bedrooms, bathrooms, lotSize,
 *     floorCount, roomCount,        // size / layout
 *     features: { heating, heatingType, cooling, coolingType, garage,
 *                 garageSpaces, pool, roofType, foundationType,
 *                 exteriorType, architectureType },  // null fields dropped
 *     source: string                // provider id the details came from
 *   }
 *   Whatever a source can't supply is simply absent — details are best-effort and
 *   ride alongside the year; they never gate scope generation.
 *
 *   `address` may be a string ("1730 Minor Ave, Seattle, WA 98101") OR an object
 *   ({ line1, city, state, zip }). Use normalizeAddress() to accept both.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

const { buildScope, loadDataset } = require('./lookup_engine.js');

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC'
]);

/** Accept a string or object address and return a normalized shape. */
function normalizeAddress(input) {
  if (input == null) return { line1: '', city: '', state: '', zip: '', freeform: '' };
  if (typeof input === 'object') {
    const line1 = String(input.line1 || input.street || input.address || '').trim();
    const city = String(input.city || '').trim();
    const state = normalizeStateCode(input.state) || parseStateFromText(input.state) || '';
    const zip = String(input.zip || input.zipcode || input.postalCode || '').trim();
    const freeform = [line1, city, [state, zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    return { line1, city, state, zip, freeform };
  }
  // String form: parse the comma-delimited locality so metro inference uses the
  // actual city, not a substring of the whole address (e.g. "100 Chicago Ave,
  // Tucson, AZ" must NOT infer Chicago).
  const freeform = String(input).trim();
  const parts = freeform.split(',').map(s => s.trim()).filter(Boolean);
  const state = parseStateFromText(freeform) || '';
  let city = '';
  if (parts.length >= 2) {
    let stateIdx = -1;
    if (state) for (let i = parts.length - 1; i >= 0; i--) { if (parseStateFromText(parts[i]) === state) { stateIdx = i; break; } }
    city = stateIdx >= 1 ? parts[stateIdx - 1] : parts[parts.length - 2];
  }
  return { line1: parts[0] || freeform, city, state, zip: '', freeform };
}

function normalizeStateCode(s) {
  if (!s) return '';
  const up = String(s).trim().toUpperCase();
  return US_STATES.has(up) ? up : '';
}

/** Best-effort: pull a 2-letter US state code out of free text (last valid match wins). */
function parseStateFromText(text) {
  if (!text) return '';
  const tokens = String(text).toUpperCase().match(/\b[A-Z]{2}\b/g) || [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (US_STATES.has(tokens[i])) return tokens[i];
  }
  return '';
}

/** Stable key for caching / fixture lookup: lowercased, whitespace-collapsed freeform. */
function addressKey(address) {
  const a = normalizeAddress(address);
  return a.freeform.toLowerCase().replace(/\s+/g, ' ').replace(/[.,]/g, '').trim();
}

// Light metro inference so the Seattle pilot (and friends) produce blueprint
// rows like SEA-1930 straight from an address. Extend as regions are piloted.
const CITY_TO_METRO = {
  'seattle': 'SEA', 'portland': 'PDX', 'san francisco': 'SF', 'los angeles': 'LA',
  'san diego': 'SD', 'new york': 'NYC', 'chicago': 'CHI', 'houston': 'HOU',
  'dallas': 'DAL', 'phoenix': 'PHX', 'miami': 'MIA', 'atlanta': 'ATL', 'boston': 'BOS',
};
const METRO_STATE = {
  SEA: 'WA', PDX: 'OR', SF: 'CA', LA: 'CA', SD: 'CA', NYC: 'NY', CHI: 'IL',
  HOU: 'TX', DAL: 'TX', PHX: 'AZ', MIA: 'FL', ATL: 'GA', BOS: 'MA',
};
// Match on the parsed CITY (equality), not a substring of the whole address, and
// only accept the metro when its home state agrees with the address state.
function inferMetro(address) {
  const a = normalizeAddress(address);
  const cityKey = (a.city || '').toLowerCase().trim();
  const code = CITY_TO_METRO[cityKey];
  if (!code) return '';
  if (a.state && METRO_STATE[code] && a.state !== METRO_STATE[code]) return '';
  return code;
}

/**
 * Redfin DEEP-LINK (lead / consumer-context only — explicitly NOT a data source).
 *
 * Redfin has no licensed/public data API, and scraping its listings would violate
 * its ToS — so it can never be the thing that "pulls more info about the house"
 * (that is RentCast's job; see mapRentcastProperty()). What Redfin IS good for is
 * the future homeowner-research / lead-gen angle: a "View on Redfin" hand-off from
 * an address. This builds that link and nothing more — no fetch, no key, no data.
 *
 * CAVEAT: Redfin's address→listing pages are JS-generated from internal region ids
 * and are not stably constructable from a raw address, so we hand off via their
 * search query. Per the same "confirm the live schema before relying on it" rule
 * this project applies to the RentCast response, click this once in a real browser
 * to confirm Redfin still honors it before depending on it in the UI.
 */
function redfinSearchUrl(address) {
  const a = normalizeAddress(address);
  if (!a.freeform) return null;
  return 'https://www.redfin.com/search?location=' + encodeURIComponent(a.freeform);
}

/**
 * MockProvider — deterministic, no network. Drives tests and local dev, and
 * documents exactly the shape a real adapter returns.
 *
 *   fixtures: { [addressKey]: { year:number|null, state?:string, property?:object } }
 *     - year as a number  -> resolves ok with that year
 *     - year === null     -> simulates "property found but no recorded year"
 *     - key absent         -> simulates "address not found"
 *     - property (optional) -> a ready-made PropertyDetails block to surface, so
 *                              the "more info about the house" path is testable
 *                              with no network (mirrors what RentCast returns).
 */
function createMockProvider(fixtures = DEFAULT_FIXTURES, id = 'mock') {
  return {
    id,
    async resolveBuildYear(address) {
      const a = normalizeAddress(address);
      const key = addressKey(address);
      const hit = Object.prototype.hasOwnProperty.call(fixtures, key) ? fixtures[key] : undefined;

      if (hit === undefined) {
        return { ok: false, year: null, state: a.state || null, source: id,
                 confidence: 'unknown', reason: 'not_found' };
      }
      if (hit.year == null) {
        return { ok: false, year: null, state: (normalizeStateCode(hit.state) || a.state) || null,
                 source: id, confidence: 'unknown', reason: 'year_unknown',
                 ...(hit.property ? { property: { source: id, ...hit.property } } : {}), raw: hit };
      }
      return {
        ok: true,
        year: Number(hit.year),
        state: (normalizeStateCode(hit.state) || a.state) || null,
        source: id,
        confidence: 'exact',
        ...(hit.property ? { property: { source: id, ...hit.property } } : {}),
        raw: hit
      };
    }
  };
}

// A few realistic fixtures (keys are normalized addresses). The Seattle one is
// the canonical spec example, now reachable by address instead of raw year.
const DEFAULT_FIXTURES = {
  '1730 minor ave seattle wa 98101': { year: 1945, state: 'WA', // 1940s Seattle
    property: { propertyType: 'Single Family', squareFootage: 1820, bedrooms: 3, bathrooms: 2,
                lotSize: 5000, floorCount: 2, roomCount: 7,
                features: { heating: true, heatingType: 'Forced Air', cooling: false,
                            garage: true, garageSpaces: 1, roofType: 'Asphalt',
                            foundationType: 'Basement', exteriorType: 'Wood' } } },
  '233 s wacker dr chicago il 60606': { year: 1968, state: 'IL' }, // aluminum-wiring era
  '1 infinite loop cupertino ca 95014': { year: 2022, state: 'CA' }, // new build
  '500 unknownyear rd austin tx 78701': { year: null, state: 'TX' }, // found, no year on record
};

/**
 * Cache decorator — wrap any provider so repeated lookups of the same address
 * hit memory instead of the network. This is the "cache the resolved build-year
 * per address" pattern; confirm it's permitted by the chosen vendor's ToS
 * (RentCast's terms allow derivative storage in your systems; ATTOM's default
 * evaluation terms forbid caching beyond 24h — see the eval notes).
 *
 *   opts.max  — max entries (simple FIFO eviction); default 5000
 */
function withCache(provider, opts = {}) {
  const max = opts.max || 5000;
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    id: provider.id,
    async resolveBuildYear(address) {
      const key = addressKey(address);
      if (cache.has(key)) { hits++; return cache.get(key); }
      misses++;
      const result = await provider.resolveBuildYear(address);
      // Only cache successful resolutions; let transient "not found"/errors retry.
      if (result && result.ok) {
        if (cache.size >= max) cache.delete(cache.keys().next().value);
        cache.set(key, result);
      }
      return result;
    },
    stats() { return { hits, misses, size: cache.size }; },
    clear() { cache.clear(); hits = 0; misses = 0; }
  };
}

/**
 * Top-level entry the proposal engine / BuildSuite calls.
 * address -> resolve year (via provider) -> buildScope(year, state).
 *
 * Returns the normal buildScope() object, augmented with `address` and
 * `build_year_source` provenance. On resolution failure it returns the engine's
 * graceful ok:false scope, annotated with why the year was missing.
 */
async function resolveScopeForAddress(address, options = {}) {
  const provider = options.provider || createMockProvider();
  const dataset = options.dataset || loadDataset();
  const a = normalizeAddress(address);

  let resolution;
  try {
    resolution = await provider.resolveBuildYear(address);
  } catch (err) {
    resolution = { ok: false, year: null, state: a.state || null, source: provider.id || 'unknown',
                   confidence: 'unknown', reason: 'provider_error', raw: String(err && err.message || err) };
  }

  // Prefer the state the provider returned; fall back to one parsed from the address.
  const state = (resolution && resolution.state) || a.state || '';

  // Only feed a real year to the engine. A failed resolution leaves year
  // undefined so buildScope() returns its graceful "no valid year" scope —
  // NOT year 0, which would wrongly match the pre_1900 band (year_min: 0).
  const resolvedYear = (resolution && resolution.ok && Number.isFinite(Number(resolution.year)))
    ? Number(resolution.year)
    : undefined;

  // Metro (for the blueprint region+era row id) — explicit option wins, else infer.
  let metro = options.metro || inferMetro(address) || '';
  // Keep the row label and the regional-modifier state consistent: if the metro's
  // home state contradicts the resolved state, trust the state and drop the metro.
  if (metro && METRO_STATE[metro] && state && METRO_STATE[metro] !== state) metro = '';

  const scope = buildScope({ year: resolvedYear, state, metro }, dataset);

  scope.address = a;
  scope.build_year_source = {
    source: (resolution && resolution.source) || (provider.id || 'unknown'),
    confidence: (resolution && resolution.confidence) || 'unknown',
    resolved_year: (resolution && resolution.year) ?? null,
    ok: !!(resolution && resolution.ok),
    reason: resolution && resolution.reason
  };
  // "More information about the house" — the provider's richer property record, if
  // any. Display/proposal context only; it does NOT influence the era scope above.
  scope.property = (resolution && resolution.property) || null;
  // Redfin hand-off (lead/consumer-context only — never a data source). Always
  // available since it's derived from the address, independent of the lookup.
  scope.lead_links = { redfin: redfinSearchUrl(address) };
  return scope;
}

/**
 * Minimal HTTPS GET returning a fetch-like response object. Lets the RentCast
 * adapter stay ZERO-dependency AND run on Node versions without a global `fetch`
 * (fetch only became global in Node 18; package.json supports node >=14). Tests
 * inject their own `fetchImpl`, so this never runs under test.
 */
function httpsGetJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          async json() { return body ? JSON.parse(body) : null; },
          async text() { return body; },
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request_timeout')));
  });
}

// Build an object from [key, value] pairs, dropping null/undefined/'' so the
// payload only ever carries fields the source actually supplied. Returns null if
// nothing survived (so callers can omit an all-empty block entirely).
function compact(pairs) {
  const out = {};
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
const numOrNull = v => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);
const strOrNull = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const boolOrNull = v => (typeof v === 'boolean' ? v : null);

/**
 * Map a RentCast /properties record → PropertyDetails (size/layout + features).
 * This is the "more information about the house" widening: the SAME single API
 * call already made for the build year also carries the property's size, layout,
 * and construction features — we were previously discarding all of it. Vendor
 * field names stay quarantined in here; the engine/orchestrator never see them.
 *
 * Scope is deliberately limited to size/layout + features (the chosen fields).
 * Sale-history / valuation fields are intentionally NOT surfaced.
 * Returns null when there's no record to map.
 */
function mapRentcastProperty(rec, source = 'rentcast') {
  if (!rec || typeof rec !== 'object') return null;
  const f = (rec.features && typeof rec.features === 'object') ? rec.features : {};
  const features = compact([
    ['heating', boolOrNull(f.heating)],
    ['heatingType', strOrNull(f.heatingType)],
    ['cooling', boolOrNull(f.cooling)],
    ['coolingType', strOrNull(f.coolingType)],
    ['garage', boolOrNull(f.garage)],
    ['garageSpaces', numOrNull(f.garageSpaces)],
    ['pool', boolOrNull(f.pool)],
    ['roofType', strOrNull(f.roofType)],
    ['foundationType', strOrNull(f.foundationType)],
    ['exteriorType', strOrNull(f.exteriorType)],
    ['architectureType', strOrNull(f.architectureType)],
  ]);
  const details = compact([
    ['propertyType', strOrNull(rec.propertyType)],
    ['squareFootage', numOrNull(rec.squareFootage)],
    ['bedrooms', numOrNull(rec.bedrooms)],
    ['bathrooms', numOrNull(rec.bathrooms)],
    ['lotSize', numOrNull(rec.lotSize)],
    ['floorCount', numOrNull(f.floorCount)],
    ['roomCount', numOrNull(f.roomCount)],
    ['features', features],
  ]);
  if (!details) return null;
  details.source = source;
  return details;
}

/**
 * RentCast adapter — the live address → build-year source (the recommended MVP
 * vendor). Implements the provider contract above, so wiring it in is a one-line
 * swap in server.js; the engine and orchestrator never learn RentCast's field
 * names. Vendor specifics (verified against RentCast's docs — STILL confirm with a
 * real test call before relying on it; schemas drift):
 *
 *   GET https://api.rentcast.io/v1/properties?address=<Street, City, State, Zip>
 *   Header: X-Api-Key: <key>
 *   Body:   an ARRAY of matches even for one address; build year = [0].yearBuilt
 *   License: explicitly permits display/resale/distribution of data to 3rd parties
 *            (so withCache() is allowed). Free 50/mo, then $74/mo for 1,000 calls.
 *
 * opts:
 *   apiKey    — RentCast key (defaults to process.env.RENTCAST_API_KEY)
 *   fetchImpl — fetch-like (url, { headers }) -> { ok, status, json() }; defaults
 *               to the built-in https shim. Inject a fake in tests.
 *   baseUrl   — override the endpoint (tests / sandbox)
 */
function createRentcastProvider(opts = {}) {
  const apiKey = opts.apiKey || process.env.RENTCAST_API_KEY || '';
  if (!apiKey) {
    throw new Error('createRentcastProvider: missing apiKey (set RENTCAST_API_KEY or pass { apiKey }).');
  }
  const fetchImpl = opts.fetchImpl || httpsGetJson;
  const baseUrl = opts.baseUrl || 'https://api.rentcast.io/v1/properties';
  const id = 'rentcast';

  const fail = (state, reason, raw) =>
    ({ ok: false, year: null, state: state || null, source: id, confidence: 'unknown', reason, ...(raw !== undefined ? { raw } : {}) });

  return {
    id,
    async resolveBuildYear(address) {
      const a = normalizeAddress(address);
      if (!a.freeform) return fail(a.state, 'bad_address');

      const url = baseUrl + '?address=' + encodeURIComponent(a.freeform);

      let res;
      try {
        res = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey, accept: 'application/json' } });
      } catch (err) {
        return fail(a.state, 'provider_error', String((err && err.message) || err));
      }

      if (!res || !res.ok) {
        const status = res && res.status;
        const reason = (status === 401 || status === 403) ? 'auth_error'
                     : status === 429 ? 'rate_limited'
                     : status === 404 ? 'not_found'
                     : 'http_' + (status || 'error');
        return fail(a.state, reason);
      }

      let data;
      try { data = await res.json(); }
      catch (err) { return fail(a.state, 'provider_error', 'bad_json'); }

      // RentCast returns an ARRAY of matches even for a single address.
      const rec = Array.isArray(data) ? data[0] : data;
      if (!rec) return fail(a.state, 'not_found');

      const recState = normalizeStateCode(rec.state) || a.state || null;
      // Map the richer "what is this house" details from the SAME record — these
      // ride alongside whether or not a year was found.
      const property = mapRentcastProperty(rec, id);
      const year = Number(rec.yearBuilt);
      if (!Number.isFinite(year) || year <= 0) {
        const r = fail(recState, 'year_unknown', rec);
        if (property) r.property = property;
        return r;
      }

      return { ok: true, year, state: recState, source: id, confidence: 'exact',
               ...(property ? { property } : {}), raw: rec };
    }
  };
}

module.exports = {
  normalizeAddress,
  normalizeStateCode,
  parseStateFromText,
  addressKey,
  inferMetro,
  redfinSearchUrl,
  mapRentcastProperty,
  createMockProvider,
  createRentcastProvider,
  withCache,
  resolveScopeForAddress,
  DEFAULT_FIXTURES,
};

/* ─────────────────────────────────────────────────────────────────────────────
 * ADAPTER AUTHORING GUIDE — how to add a real vendor (do this once you pick one)
 *
 * Build a module that exports `{ id, async resolveBuildYear(address) }` and
 * returns the BuildYearResult shape above. Keep the vendor's quirks INSIDE the
 * adapter; the engine and orchestrator never learn the vendor's field names.
 *
 * The three contracts below were VERIFIED against live vendor docs during the
 * source evaluation. STILL confirm against the live docs (and a real test call)
 * before shipping — schemas drift.
 *
 *   ── RentCast (recommended MVP source) — ALREADY IMPLEMENTED ───────────────
 *   See createRentcastProvider() above; this is the live adapter, wired into
 *   server.js (auto-activates when RENTCAST_API_KEY is set). Kept here for
 *   reference / parity with the other vendors below.
 *   GET https://api.rentcast.io/v1/properties?address=<Street, City, State, Zip>
 *   Header: X-Api-Key: <key>
 *   Year:   response[0].yearBuilt   (response is an ARRAY even for one address)
 *   License: explicitly permits display/resale/distribution of data to 3rd
 *            parties. Free 50/mo tier, then $74/mo Foundation (1,000 calls).
 *
 *   ── Smarty US Property (best when the government channel matters) ──────────
 *   GET https://us-enrichment.api.smarty.com/lookup/search/property
 *         ?auth-id=<id>&auth-token=<tok>&freeform=<full address>
 *   Year:   response[0].attributes.year_built
 *   License: embedding in your SaaS allowed; US Gov end-users = "Commercial Items".
 *
 *   ── ATTOM (gold-standard data; enterprise/scale phase) ────────────────────
 *   GET https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/detail
 *         ?address1=<street>&address2=<City, ST>
 *   Header: apikey: <key>
 *   Year:   response.property[0].summary.yearbuilt
 *   CAUTION: default terms are EVALUATION-ONLY and forbid caching >24h — needs a
 *            negotiated production license before any commercial use. Do NOT wrap
 *            this one in withCache() under the evaluation terms.
 *
 * Skeleton:
 *   function createRentcastProvider({ apiKey, fetchImpl = fetch }) {
 *     return {
 *       id: 'rentcast',
 *       async resolveBuildYear(address) {
 *         const { freeform } = normalizeAddress(address);
 *         const url = 'https://api.rentcast.io/v1/properties?address=' + encodeURIComponent(freeform);
 *         try {
 *           const res = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey, accept: 'application/json' } });
 *           if (!res.ok) return { ok:false, year:null, state:null, source:'rentcast', confidence:'unknown', reason:'http_' + res.status };
 *           const data = await res.json();
 *           const rec = Array.isArray(data) ? data[0] : data;
 *           const year = rec && Number(rec.yearBuilt);
 *           if (!year) return { ok:false, year:null, state: rec && rec.state || null, source:'rentcast', confidence:'unknown', reason:'year_unknown', raw:rec };
 *           return { ok:true, year, state: rec.state || null, source:'rentcast', confidence:'exact', raw:rec };
 *         } catch (err) {
 *           return { ok:false, year:null, state:null, source:'rentcast', confidence:'unknown', reason:'provider_error', raw:String(err) };
 *         }
 *       }
 *     };
 *   }
 * ───────────────────────────────────────────────────────────────────────────── */

// ---- CLI demo: node address_provider.js "1730 Minor Ave, Seattle, WA 98101" ----
if (require.main === module) {
  const { renderScopeText } = require('./lookup_engine.js');
  const arg = process.argv.slice(2).join(' ').trim();
  const address = arg || '1730 Minor Ave, Seattle, WA 98101';
  resolveScopeForAddress(address, { provider: withCache(createMockProvider()) })
    .then(scope => {
      console.log('Address : ' + address);
      console.log('Resolved: year ' + (scope.build_year_source.resolved_year ?? 'unknown') +
                  ' via ' + scope.build_year_source.source +
                  ' (' + scope.build_year_source.confidence + ')');
      if (scope.property) {
        const p = scope.property;
        const bits = [
          p.propertyType,
          p.squareFootage && p.squareFootage + ' sqft',
          (p.bedrooms != null) && p.bedrooms + ' bd',
          (p.bathrooms != null) && p.bathrooms + ' ba',
          p.lotSize && p.lotSize + ' sqft lot',
        ].filter(Boolean);
        console.log('Property: ' + (bits.join(' · ') || '(details available)'));
      }
      console.log('Redfin  : ' + (scope.lead_links && scope.lead_links.redfin || 'n/a'));
      console.log('');
      console.log(renderScopeText(scope));
    })
    .catch(err => { console.error(err); process.exit(1); });
}
