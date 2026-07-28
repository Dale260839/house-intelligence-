/**
 * Material Takeoff — HTTP API server
 * ----------------------------------
 * A thin, dependency-free HTTP layer over the takeoff engine — the SAME pattern and
 * stack as House Intelligence's server.js (Node core `http`, manual CORS headers,
 * JSON in/out, clean JSON errors). It exposes the exact logic the CLI uses; nothing
 * about the engine or dataset changes. This is just a deployable front door that
 * BuildSuite can call over HTTP.
 *
 * Built on Node's core `http` module ON PURPOSE: zero runtime dependencies, so
 * `node server.js` is all any host (Render, Railway, Fly, Heroku, a bare VM, Docker)
 * needs — no `npm install`, no framework.
 *
 * It runs alongside House Intelligence in the same repo but is a SEPARATE service:
 * its own folder, its own server. Default port is 3100 (House Intelligence defaults
 * to 3000) so both can run locally at once; hosts inject PORT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINTS
 *
 *   GET  /                              → API index + usage (JSON)
 *   GET  /health                        → liveness probe { status: 'ok' }
 *
 *   GET  /material-takeoff/project-types
 *                                       → supported project types + required/optional
 *                                         input fields (types/defaults) so a client can
 *                                         render a form dynamically. (v1: kitchen_remodel)
 *
 *   POST /material-takeoff
 *          { "projectType":"kitchen_remodel", "kitchenSqft":200, ...optional }
 *                                       → the full takeoff JSON (order quantities + raw +
 *                                         waste % + fixtures checklist). Bad/missing input
 *                                         returns 400 with a clear message.
 *
 *   GET  /material-takeoff?projectType=kitchen_remodel&kitchenSqft=200[&...]
 *                                       → same as POST, query-driven (handy for a browser).
 *
 * Add &format=text (GET) or "format":"text" (POST) for a rendered text block.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const http = require('http');
const fs = require('fs');
const { URL } = require('url');

const {
  buildTakeoff, getProjectTypes, renderTakeoffText, loadDataset,
} = require('./takeoff_engine.js');
const { buildScopeTakeoff, buildProposalTakeoff } = require('./scope_engine.js');
const { priceTakeoff, priceScopeTakeoff, renderPricingText } = require('./pricing_engine.js');
const { selectPricingProvider } = require('./pricing_provider.js');
const { selectExtractionProvider } = require('./extraction_provider.js');
const { renderTakeoffHtml } = require('./pdf_export.js');
const { clientKey, selectRateLimiter } = require('./rate_limiter.js');

// Load the dataset once at boot and reuse it for every request (it never changes at
// runtime). Saves a file read per call.
const DATASET = loadDataset();

// Per-client rate limiter, auto-selected from env (RATE_LIMIT_MAX / _WINDOW_MS /
// _DISABLED). Exported for tests. A periodic sweep drops expired buckets; unref() so it
// never keeps the process (or the test runner) alive.
const { limiter: RATE_LIMITER, enabled: RATE_ENABLED, label: RATE_LABEL } = selectRateLimiter();
const RATE_SWEEP = setInterval(() => RATE_LIMITER.sweep(), 60000);
if (RATE_SWEEP.unref) RATE_SWEEP.unref();

// The BuildSuite demo page, served from THIS server so it is same-origin with the API
// (no CORS, no local server, no file:// restrictions — just open /demo in any browser).
// Read once at boot; optional, so a missing file never breaks the API.
let DEMO_HTML = null;
try { DEMO_HTML = fs.readFileSync(__dirname + '/buildsuite-demo.html', 'utf8'); }
catch { /* demo page not deployed — /demo will 404 */ }

const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '0.0.0.0';

// ─── small helpers (same shape as House Intelligence's server) ───────────────

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

// Print-ready HTML (U8 export path — the client turns it into a PDF via Ctrl+P).
function sendHtml(res, status, html) {
  const body = String(html);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
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

function isTextFormat(v) {
  return String(v || '').toLowerCase() === 'text';
}

function isHtmlFormat(v) {
  const s = String(v || '').toLowerCase();
  return s === 'html' || s === 'print' || s === 'pdf';   // print-ready HTML export (U8)
}

function isTruthy(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

// Numeric/boolean query params arrive as strings; the engine's resolveInputs() coerces
// them, so we pass the raw param bag straight through.

// ─── route handlers ──────────────────────────────────────────────────────────

function handleIndex(res) {
  sendJson(res, 200, {
    name: 'Material Takeoff API',
    version: require('./package.json').version,
    status: 'ok',
    sibling_of: 'House Intelligence (same repo, same stack, separate service)',
    endpoints: {
      'GET /health': 'liveness probe',
      'GET /material-takeoff/project-types': 'supported project types + input form contract',
      'POST /material-takeoff': 'body: { projectType, kitchenSqft, ...optional } -> full takeoff',
      'GET /material-takeoff?projectType=kitchen_remodel&kitchenSqft=200': 'same, query-driven',
      'POST /material-takeoff/from-scope': 'body: { sections:[{ project_type, inputs, add_ons?, budget_hint? }], price?, ... } -> merged multi-section takeoff (project_type "composite" when >1). Every line carries section_id.',
      'POST /material-takeoff/from-proposal': 'body: { proposal_markdown, budget_total?, budget_sections?, price?, ... } -> extracts a scope from free text (LLM when EXTRACTION_API_KEY set, else deterministic heuristic) then runs the takeoff. Adds extracted_scope + per-line source_quote/confidence.',
      hint: 'add format=text for a rendered block, or format=html (a.k.a. print/pdf) for a print-ready sheet you can save as PDF from the browser',
      pricing: 'add price=true to attach live Home Depot pricing + a profit layout. Options: tier=good|better|best, markupPct, laborPct (percent of materials) or laborCost (dollars). Requires HOMEDEPOT_API_KEY on the server; without it pricing returns { ok:false, reason:"pricing_unavailable" } while quantities still return.',
    },
    pricing_enabled: !!selectPricingProvider(process.env).provider,
    rate_limit: RATE_ENABLED ? RATE_LABEL : 'disabled',
  });
}

function handleProjectTypes(res) {
  const types = getProjectTypes(DATASET);
  sendJson(res, 200, { ok: true, count: types.length, project_types: types });
}

// Core dispatch shared by GET (query params) and POST (body).
// Async because pricing (when requested) fetches live prices over the network.
async function handleTakeoff(res, params) {
  const takeoff = buildTakeoff(params, DATASET);

  // Validation failures (ok:false) are client errors -> 400 with the clear message.
  if (!takeoff.ok) {
    if (isTextFormat(params.format)) return sendText(res, 400, takeoff.message);
    return sendJson(res, 400, takeoff);
  }

  // Pricing is OPT-IN (price=true). Quantities are always returned; pricing is layered
  // on top and never turns a valid takeoff into an error — a pricing outage degrades
  // to takeoff.pricing = { ok:false, reason } while the quantities still stand.
  if (isTruthy(params.price)) {
    const { provider } = selectPricingProvider(process.env);
    takeoff.pricing = await priceTakeoff(takeoff, {
      provider,
      dataset: DATASET,
      tier: params.tier,
      markupPct: params.markupPct,
      laborPct: params.laborPct,
      laborCost: params.laborCost,
    });
  }

  if (isHtmlFormat(params.format)) return sendHtml(res, 200, renderTakeoffHtml(takeoff));
  if (isTextFormat(params.format)) {
    let text = renderTakeoffText(takeoff);
    if (takeoff.pricing) text += '\n' + renderPricingText(takeoff.pricing);
    return sendText(res, 200, text);
  }
  return sendJson(res, 200, takeoff);
}

// v2: multi-section SCOPE. Body carries a sections[] array (each its own project_type +
// inputs + add_ons + budget_hint); the aggregator runs each section's builder and merges.
// Pricing (opt-in price=true) applies to the WHOLE scope: one labor line, one profit layout.
// The existing POST /material-takeoff is untouched — this is a separate route.
async function handleScopeTakeoff(res, body) {
  const scope = buildScopeTakeoff(body, DATASET);
  if (!scope.ok) {
    if (isTextFormat(body.format)) return sendText(res, 400, scope.message);
    return sendJson(res, 400, scope);
  }

  if (isTruthy(body.price)) {
    const { provider } = selectPricingProvider(process.env);
    scope.pricing = await priceScopeTakeoff(scope.section_takeoffs, {
      provider,
      dataset: DATASET,
      tier: body.tier,
      markupPct: body.markupPct,
      laborPct: body.laborPct,
      laborCost: body.laborCost,
      budget_total: body.budget_total,
      budget_sections: body.budget_sections,
    });
  }

  // Strip the internal per-section takeoffs (they just duplicate `materials`).
  const { section_takeoffs, ...publicScope } = scope;

  if (isHtmlFormat(body.format)) return sendHtml(res, 200, renderTakeoffHtml(publicScope));
  if (isTextFormat(body.format)) {
    let text = renderTakeoffText(publicScope);
    if (publicScope.pricing) text += '\n' + renderPricingText(publicScope.pricing);
    return sendText(res, 200, text);
  }
  return sendJson(res, 200, publicScope);
}

// v2: from a free-text PROPOSAL. An extraction provider (LLM when EXTRACTION_API_KEY is set,
// else the deterministic heuristic) turns markdown into the from-scope shape, then the same
// deterministic aggregator runs. A proposal with no recognizable scope returns a NORMAL 200
// with ok:false (the caller can act on it) — never a crash.
async function handleProposalTakeoff(res, body) {
  const { provider } = selectExtractionProvider(process.env);

  let proposal;
  try {
    proposal = await buildProposalTakeoff(body, DATASET, provider);
  } catch (err) {
    console.error('[server] extraction error:', err);
    return sendJson(res, 200, { ok: false, source_type: 'proposal', error: 'extraction_error',
      message: 'The proposal could not be processed. Try /from-scope with an explicit scope.' });
  }

  // "no scope extracted" is a normal, actionable ok:false at HTTP 200 (per the contract).
  if (!proposal.ok && proposal.error === 'no_scope_extracted') {
    if (isTextFormat(body.format)) return sendText(res, 200, proposal.message);
    return sendJson(res, 200, proposal);
  }
  // A scope that extracted but failed validation is a real client error -> 400.
  if (!proposal.ok) {
    if (isTextFormat(body.format)) return sendText(res, 400, proposal.message);
    return sendJson(res, 400, proposal);
  }

  if (isTruthy(body.price)) {
    const { provider: pricer } = selectPricingProvider(process.env);
    proposal.pricing = await priceScopeTakeoff(proposal.section_takeoffs, {
      provider: pricer,
      dataset: DATASET,
      tier: body.tier,
      markupPct: body.markupPct,
      laborPct: body.laborPct,
      laborCost: body.laborCost,
      budget_total: body.budget_total,
      budget_sections: body.budget_sections,
    });
  }

  const { section_takeoffs, ...publicProposal } = proposal;

  if (isHtmlFormat(body.format)) return sendHtml(res, 200, renderTakeoffHtml(publicProposal));
  if (isTextFormat(body.format)) {
    let text = renderTakeoffText(publicProposal);
    if (publicProposal.pricing) text += '\n' + renderPricingText(publicProposal.pricing);
    return sendText(res, 200, text);
  }
  return sendJson(res, 200, publicProposal);
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

    // ── rate limit (per client IP) ──────────────────────────────────────────────
    // /health is exempt so liveness probes never count against the limit. On a hit we
    // reply 429 with Retry-After; otherwise we attach the standard X-RateLimit-* headers
    // (merged into the eventual response via setHeader) so clients can self-throttle.
    if (RATE_ENABLED && path !== '/health') {
      const rl = RATE_LIMITER.check(clientKey(req));
      res.setHeader('X-RateLimit-Limit', rl.limit);
      res.setHeader('X-RateLimit-Remaining', rl.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(rl.resetAt / 1000)); // epoch seconds
      if (!rl.allowed) {
        const retryS = Math.ceil(rl.retryAfterMs / 1000);
        res.setHeader('Retry-After', retryS);
        return sendJson(res, 429, { ok: false, error: 'rate_limited',
          message: `Too many requests. Try again in ${retryS}s.`, retry_after_s: retryS });
      }
    }

    // Demo UI — same-origin with the API, so it works from any browser with no CORS
    // and no local server. See buildsuite-demo.html.
    if (req.method === 'GET' && (path === '/demo' || path === '/demo.html')) {
      if (!DEMO_HTML) {
        return sendJson(res, 404, { ok: false, error: 'demo_unavailable',
          message: 'buildsuite-demo.html is not deployed with this service.' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(DEMO_HTML),
        'Cache-Control': 'no-cache',
      });
      return res.end(DEMO_HTML);
    }

    if (req.method === 'GET' && path === '/') return handleIndex(res);
    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' && path === '/material-takeoff/project-types') return handleProjectTypes(res);
    if (req.method === 'GET' && path === '/material-takeoff') return await handleTakeoff(res, query);

    if (req.method === 'POST' && path === '/material-takeoff') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      return await handleTakeoff(res, { ...body });
    }

    // v2 multi-section scope (POST only — sections[] doesn't map cleanly to a query string).
    if (req.method === 'POST' && path === '/material-takeoff/from-scope') {
      let body;
      try { body = await readJsonBody(req); }
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      return await handleScopeTakeoff(res, { ...body });
    }

    // v2 from a free-text proposal (POST only).
    if (req.method === 'POST' && path === '/material-takeoff/from-proposal') {
      let body;
      try { body = await readJsonBody(req, 256 * 1024); }   // proposals can be large
      catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
      return await handleProposalTakeoff(res, { ...body });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found',
      message: `No route for ${req.method} ${path}. See GET / for usage.` });
  } catch (err) {
    // Last-resort guard: never leak a stack to the client, but log it server-side.
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
});

// Only listen when run directly (`node server.js`), so tests can import the server
// without binding a port.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Material Takeoff API listening on http://${HOST}:${PORT}`);
    console.log('Rate limit:       ' + (RATE_ENABLED ? RATE_LABEL : 'disabled'));
    console.log('Try:  curl -X POST http://localhost:' + PORT + '/material-takeoff -H "Content-Type: application/json" -d \'{"projectType":"kitchen_remodel","kitchenSqft":200}\'');
  });
}

module.exports = { server, RATE_LIMITER };
