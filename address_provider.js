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
 *     raw?:      any                // raw provider payload, for debugging/audit
 *   }
 *
 *   `address` may be a string ("1730 Minor Ave, Seattle, WA 98101") OR an object
 *   ({ line1, city, state, zip }). Use normalizeAddress() to accept both.
 * ─────────────────────────────────────────────────────────────────────────────
 */

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
 * MockProvider — deterministic, no network. Drives tests and local dev, and
 * documents exactly the shape a real adapter returns.
 *
 *   fixtures: { [addressKey]: { year:number|null, state?:string } }
 *     - year as a number  -> resolves ok with that year
 *     - year === null     -> simulates "property found but no recorded year"
 *     - key absent         -> simulates "address not found"
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
                 source: id, confidence: 'unknown', reason: 'year_unknown', raw: hit };
      }
      return {
        ok: true,
        year: Number(hit.year),
        state: (normalizeStateCode(hit.state) || a.state) || null,
        source: id,
        confidence: 'exact',
        raw: hit
      };
    }
  };
}

// A few realistic fixtures (keys are normalized addresses). The Seattle one is
// the canonical spec example, now reachable by address instead of raw year.
const DEFAULT_FIXTURES = {
  '1730 minor ave seattle wa 98101': { year: 1945, state: 'WA' }, // 1940s Seattle
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
  return scope;
}

module.exports = {
  normalizeAddress,
  normalizeStateCode,
  parseStateFromText,
  addressKey,
  inferMetro,
  createMockProvider,
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
 *   ── RentCast (recommended MVP source) ─────────────────────────────────────
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
      console.log('');
      console.log(renderScopeText(scope));
    })
    .catch(err => { console.error(err); process.exit(1); });
}
