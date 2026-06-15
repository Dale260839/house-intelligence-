/**
 * House Intelligence — HTTP API server
 * ------------------------------------
 * A thin, dependency-free HTTP layer over the existing engine. It exposes the
 * exact same logic the CLI uses — nothing about the engine, dataset, or address
 * resolution changes. This is just a deployable front door.
 *
 * Built on Node's core `http` module ON PURPOSE: the project has zero runtime
 * dependencies, so `node server.js` is all any host (Render, Railway, Fly,
 * Heroku, a bare VM, Docker) needs — no `npm install` step, no framework.
 *
 * The server runs WITHOUT any vendor adapter: address lookups use the bundled
 * MockProvider by default (same as the CLI). When you later wire a real provider
 * (RentCast, etc.), inject it where noted below and every endpoint upgrades for
 * free.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINTS
 *
 *   GET  /                      → API index + usage (JSON)
 *   GET  /health                → liveness probe { status: 'ok' }
 *
 *   GET  /scope?year=1945&state=WA[&metro=SEA][&format=text]
 *                               → scope of work for a known build year
 *   GET  /scope?address=<addr>[&format=text]
 *                               → resolve address → year → scope (via provider)
 *   POST /scope   { "year":1945, "state":"WA", "metro":"SEA" }
 *          - or -  { "address":"1730 Minor Ave, Seattle, WA 98101" }
 *                               → same as GET, body-driven
 *
 *   GET  /rows?region=SEA       → blueprint Layer-1 region+era grid (JSON array)
 *
 * `format=text` (GET) or "format":"text" (POST) returns the human-readable
 * rendered block instead of JSON — handy for emails/proposals.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const http = require('http');
const { URL } = require('url');

const {
  buildScope, buildRegionGrid, renderScopeText, loadDataset,
} = require('./lookup_engine.js');
const {
  resolveScopeForAddress, createMockProvider, withCache,
} = require('./address_provider.js');

// Load the dataset once at boot and reuse it for every request (it never changes
// at runtime). Saves a file read per call.
const DATASET = loadDataset();

// The address→year provider. Defaults to the dependency-free MockProvider wrapped
// in the in-memory cache. TO GO LIVE: replace createMockProvider() with your real
// adapter, e.g. withCache(createRentcastProvider({ apiKey: process.env.RENTCAST_API_KEY })).
const PROVIDER = withCache(createMockProvider());

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ─── small helpers ───────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',           // allow browser frontends
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

// Read and JSON-parse a request body, capped so a giant payload can't OOM us.
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let aborted = false;
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) { aborted = true; reject(new Error('payload_too_large')); req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

// Core dispatch shared by GET (query params) and POST (body): given the resolved
// params, produce a scope — by address if present, else by year.
async function computeScope(params) {
  const wantsAddress = params.address != null && String(params.address).trim() !== '';
  if (wantsAddress) {
    return resolveScopeForAddress(params.address, {
      provider: PROVIDER,
      dataset: DATASET,
      metro: params.metro,
    });
  }
  // Year path — buildScope handles a missing/invalid year by returning its
  // graceful ok:false "no valid year" scope (no throw).
  return buildScope(
    { year: params.year, state: params.state, metro: params.metro },
    DATASET
  );
}

function isTextFormat(v) {
  return String(v || '').toLowerCase() === 'text';
}

// ─── route handlers ──────────────────────────────────────────────────────────

function handleIndex(res) {
  sendJson(res, 200, {
    name: 'House Intelligence API',
    version: require('./package.json').version,
    status: 'ok',
    vendor_adapter: 'none (using bundled MockProvider)',
    endpoints: {
      'GET /health': 'liveness probe',
      'GET /scope?year=1945&state=WA&metro=SEA': 'scope for a known build year',
      'GET /scope?address=<full address>': 'resolve address → year → scope',
      'POST /scope': 'body: { year, state, metro } OR { address }',
      'GET /rows?region=SEA': 'blueprint region+era grid (JSON)',
      hint: 'add &format=text (GET) or "format":"text" (POST) for a rendered block',
    },
  });
}

async function handleScope(res, params) {
  const scope = await computeScope(params);
  if (isTextFormat(params.format)) {
    return sendText(res, scope.ok ? 200 : 422, renderScopeText(scope));
  }
  // A resolvable-but-yearless result is a valid 200 with ok:false; the caller
  // inspects `ok` and `reason`/`build_year_source`.
  return sendJson(res, 200, scope);
}

function handleRows(res, params) {
  const region = String(params.region || params.metro || params.state || '').trim();
  if (!region) {
    return sendJson(res, 400, { ok: false, error: 'missing_region',
      message: 'Pass ?region=<STATE or METRO>, e.g. /rows?region=SEA or /rows?region=WA' });
  }
  // buildRegionGrid auto-detects metro vs. state from the value.
  const grid = buildRegionGrid({ state: region, metro: region }, DATASET);
  return sendJson(res, 200, { ok: true, region, count: grid.length, rows: grid });
}

// ─── server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {            // CORS preflight
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'GET' && path === '/') return handleIndex(res);
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' && path === '/scope') return handleScope(res, query);
    if (req.method === 'GET' && path === '/rows') return handleRows(res, query);

    if (req.method === 'POST' && path === '/scope') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      return handleScope(res, { ...body });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found',
      message: `No route for ${req.method} ${path}. See GET / for usage.` });
  } catch (err) {
    // Last-resort guard: never leak a stack to the client, but log it server-side.
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
});

// Only listen when run directly (`node server.js`), so tests can import the
// server/handlers without binding a port.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`House Intelligence API listening on http://${HOST}:${PORT}`);
    console.log('Try:  curl "http://localhost:' + PORT + '/scope?address=1730%20Minor%20Ave,%20Seattle,%20WA%2098101"');
  });
}

module.exports = { server, computeScope };
