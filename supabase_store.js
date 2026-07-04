/**
 * House Intelligence — Supabase persistence (write-only, single-table)
 * -------------------------------------------------------------------
 * BuildSuite calls House Intelligence with a match context (project/contractor/
 * client/contact ids + address). We compute the era scope + property details and
 * APPEND one row to Supabase so BuildSuite can query it later for the contractor's
 * matched-clients view. This module is that persistence seam.
 *
 * DESIGN / SAFETY (deliberate, audit me):
 *   - It ONLY ever INSERTs, and ONLY into ONE table. The table name is a hardcoded
 *     module constant (TABLE) — it is NEVER a parameter — so there is no code path
 *     that can touch another table. There is no update, delete, upsert, or DDL
 *     anywhere in this file.
 *   - Zero runtime dependencies: it writes through Supabase's PostgREST REST API
 *     over a tiny built-in https shim (no `@supabase/supabase-js`, no `pg`). Tests
 *     inject a fake transport, so the suite never hits the network.
 *   - Auth uses the SUPABASE_KEY (the *publishable* / anon key is recommended;
 *     it's RLS-gated, so it can only insert where a policy allows). Never throws on
 *     a failed write — it degrades to { ok:false, ... } so a persistence outage
 *     can't take down the scope computation the caller actually asked for.
 *
 * Table (house_intelligence_requests) is an APPEND LOG: one row per request,
 * `requested_at` defaults to now() in the DB. BuildSuite reads the latest row per
 * (contractor_id, client_id).
 */

const https = require('https');
const { URL } = require('url');

// HARDCODED — the ONLY table this module will ever write to. Not configurable.
const TABLE = 'house_intelligence_requests';

/**
 * Minimal JSON HTTP client (supports POST bodies), fetch-like return shape so it
 * matches the transport contract the RentCast adapter/tests already use:
 *   (url, { method, headers, body }) -> { ok, status, json(), text() }
 * Kept here so this module stays zero-dependency and Node >=14 compatible.
 */
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

/** Drop null/undefined keys so we never send a column we have no value for (lets
 *  DB defaults like `requested_at`/`resolved` apply and avoids NOT NULL surprises).
 *  Booleans and 0 are kept intentionally. */
function compactRow(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Map a computed scope + the BuildSuite-supplied match context to a table row.
 * The engine's field names are translated to the table's columns here (the store
 * itself stays a dumb single-table inserter).
 */
function toRequestRow(scope, context = {}) {
  const bys = (scope && scope.build_year_source) || {};
  const addr = (scope && scope.address) || {};
  return compactRow({
    // match keys passed in by BuildSuite
    project_id:    context.project_id,
    contractor_id: context.contractor_id,
    client_id:     context.client_id,       // clients.id (uuid)
    contact_id:    context.contact_id,       // GHL ghl_contact_id
    profile_id:    context.profile_id,       // pre-existing column — only set if BuildSuite sends it
    // resolved detail
    address:       addr.freeform || context.address || null,
    year_built:    bys.resolved_year ?? null,
    state:         addr.state || null,
    year_source:   bys.source || null,
    resolved:      !!bys.ok,
    severity:      (scope && scope.severity) || null,
    scope:         scope || null,            // full engine output (jsonb)
    property:      (scope && scope.property) || null,  // size/layout + features (jsonb)
  });
}

/**
 * The live store. INSERT-ONLY into TABLE via PostgREST.
 *   opts.url       — SUPABASE_URL (project url)
 *   opts.key       — SUPABASE_KEY (publishable/anon key recommended)
 *   opts.fetchImpl — inject a fake transport in tests
 * NOTE: `opts.table` is intentionally NOT honored — the table is fixed.
 */
function createSupabaseStore(opts = {}) {
  const url = String(opts.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = opts.key || process.env.SUPABASE_KEY || '';
  if (!url || !key) {
    throw new Error('createSupabaseStore: missing SUPABASE_URL or SUPABASE_KEY.');
  }
  const fetchImpl = opts.fetchImpl || httpsRequestJson;
  const endpoint = url + '/rest/v1/' + TABLE;   // TABLE is fixed — never from opts

  return {
    id: 'supabase',
    table: TABLE,
    async insert(row) {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',                       // INSERT only. never PATCH/DELETE.
          headers: {
            apikey: key,
            Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',     // get the stored row back to confirm
          },
          body: [row],                          // PostgREST takes an array of rows
        });
      } catch (err) {
        return { ok: false, stored: false, reason: 'network_error', detail: String((err && err.message) || err) };
      }
      if (!res || !res.ok) {
        const status = res && res.status;
        const reason = (status === 401 || status === 403) ? 'auth_error'
                     : status === 404 ? 'table_not_found'
                     : status === 409 ? 'conflict'
                     : 'http_' + (status || 'error');
        let detail;
        try { detail = res && await res.text(); } catch { /* ignore */ }
        return { ok: false, stored: false, reason, status, detail };
      }
      let data;
      try { data = await res.json(); } catch { data = null; }
      const record = Array.isArray(data) ? data[0] : data;
      return { ok: true, stored: true, record };
    },
  };
}

/** No-op store used when no Supabase creds are set: echoes the row, persists
 *  nothing, never touches the network. Keeps the server + tests running key-free. */
function createNoopStore() {
  return {
    id: 'noop',
    table: TABLE,
    async insert(row) {
      return { ok: true, stored: false, reason: 'no_supabase_credentials', record: row };
    },
  };
}

/**
 * Pick a store from the environment, mirroring server.js's provider auto-select:
 *   SUPABASE_URL + SUPABASE_KEY set → live Supabase store
 *   otherwise                       → no-op store (echo only)
 */
function selectStore(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim();
  const key = String(env.SUPABASE_KEY || '').trim();
  if (url && key) {
    return { store: createSupabaseStore({ url, key }), label: 'supabase (live) → ' + TABLE };
  }
  return {
    store: createNoopStore(),
    label: 'none — no-op echo (set SUPABASE_URL + SUPABASE_KEY to persist to ' + TABLE + ')',
  };
}

module.exports = {
  TABLE,
  toRequestRow,
  createSupabaseStore,
  createNoopStore,
  selectStore,
  httpsRequestJson,
};
