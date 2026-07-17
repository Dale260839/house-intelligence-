/**
 * Material Takeoff — HTTP API tests
 * Spins the real server on an ephemeral port and exercises each route over the wire.
 * Dependency-free (core http only), same harness style as House Intelligence's
 * test_server.js.
 */
const http = require('http');
const { server, RATE_LIMITER } = require('./server.js');

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }

// Minimal request helper: returns { status, json, text }.
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          let json = null; try { json = JSON.parse(raw); } catch { /* text route */ }
          resolve({ status: res.statusCode, json, text: raw, headers: res.headers });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('========================================');
  console.log('HTTP API — routes over the wire (port ' + port + ')');
  console.log('========================================');

  try {
    const health = await request(port, 'GET', '/health');
    check('GET /health -> 200 ok', health.status === 200 && health.json.status === 'ok');

    const index = await request(port, 'GET', '/');
    check('GET / -> 200 with endpoints', index.status === 200 && !!index.json.endpoints);

    // CORS enabled (BuildSuite calls from a browser).
    check('responses send Access-Control-Allow-Origin: *', health.headers['access-control-allow-origin'] === '*');
    const preflight = await request(port, 'OPTIONS', '/material-takeoff');
    check('OPTIONS preflight -> 204', preflight.status === 204);

    // project-types contract
    const types = await request(port, 'GET', '/material-takeoff/project-types');
    check('GET /material-takeoff/project-types -> ok', types.status === 200 && types.json.ok === true);
    check('  -> lists kitchen_remodel', types.json.project_types[0].id === 'kitchen_remodel');
    check('  -> exposes required + optional inputs', Array.isArray(types.json.project_types[0].required_inputs) && Array.isArray(types.json.project_types[0].optional_inputs));

    // POST takeoff — the canonical 200 sqft example
    const post = await request(port, 'POST', '/material-takeoff', { projectType: 'kitchen_remodel', kitchenSqft: 200 });
    check('POST /material-takeoff { kitchen, 200 } -> 200 ok', post.status === 200 && post.json.ok === true);
    check('  -> 40 LF total cabinets', post.json.derived.total_cabinet_lf === 40);
    check('  -> thinset 4 bags @ 75 sqft/bag', post.json.materials.find(m => m.key === 'thinset').order_qty === 4);
    check('  -> 16 drywall sheets', post.json.materials.find(m => m.key === 'drywall_sheets').order_qty === 16);
    check('  -> includes fixtures checklist', !!post.json.fixtures_checklist.plumbing && !!post.json.fixtures_checklist.electrical);

    // GET takeoff (query-driven), with optional inputs as query strings
    const get = await request(port, 'GET', '/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&tileLayout=diagonal&floorTile=false');
    check('GET /material-takeoff?... -> ok', get.status === 200 && get.json.ok === true);
    check('  -> query coercion: diagonal tile = 15% waste', get.json.materials.find(m => m.key === 'backsplash_tile').waste_pct === 15);
    check('  -> query coercion: floorTile=false drops floor tile', get.json.materials.every(m => m.key !== 'floor_tile'));

    // text format
    const asText = await request(port, 'GET', '/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&format=text');
    check('format=text -> plain text takeoff block', /MATERIAL TAKEOFF/.test(asText.text) && asText.json === null);

    // ── validation: bad/missing input returns 400 with a clear message ──
    const missing = await request(port, 'POST', '/material-takeoff', { projectType: 'kitchen_remodel' });
    check('POST missing kitchenSqft -> 400', missing.status === 400 && missing.json.ok === false);
    check('  -> message names the field', /kitchenSqft/i.test(missing.json.message));

    const badType = await request(port, 'POST', '/material-takeoff', { projectType: 'bathroom', kitchenSqft: 200 });
    check('POST unsupported projectType -> 400', badType.status === 400 && badType.json.error === 'unsupported_project_type');

    const noType = await request(port, 'POST', '/material-takeoff', { kitchenSqft: 200 });
    check('POST no projectType -> 400', noType.status === 400);

    const badEnum = await request(port, 'POST', '/material-takeoff', { projectType: 'kitchen_remodel', kitchenSqft: 200, tileLayout: 'spiral' });
    check('POST bad enum value -> 400', badEnum.status === 400);

    const negative = await request(port, 'GET', '/material-takeoff?projectType=kitchen_remodel&kitchenSqft=-5');
    check('GET negative kitchenSqft -> 400', negative.status === 400);

    // invalid JSON body
    const badJson = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/material-takeoff',
        headers: { 'Content-Type': 'application/json' } }, res => {
        let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, raw }));
      });
      req.on('error', reject); req.write('{ not json'); req.end();
    });
    check('POST invalid JSON -> 400', badJson.status === 400);

    // ── pricing (opt-in) ──────────────────────────────────────────────────
    // Force the deterministic mock provider for the wire tests (no key / network).
    process.env.PRICING_MOCK = '1';
    delete process.env.HOMEDEPOT_API_KEY;

    const priced = await request(port, 'POST', '/material-takeoff',
      { projectType: 'kitchen_remodel', kitchenSqft: 200, price: true, tier: 'better', markupPct: 20, laborPct: 100 });
    check('POST price=true -> 200 with pricing block', priced.status === 200 && priced.json.pricing && priced.json.pricing.ok === true);
    check('  -> mock source, better tier, fully priced', priced.json.pricing.source === 'mock' && priced.json.pricing.tier === 'better' && priced.json.pricing.fully_priced === true);
    check('  -> profit layout has both markup% and margin%', priced.json.pricing.profit_layout.markup_pct === 20 && priced.json.pricing.profit_layout.margin_pct > 0);
    check('  -> price = total_cost x 1.20', Math.abs(priced.json.pricing.profit_layout.price - Math.round(priced.json.pricing.profit_layout.total_cost * 1.2 * 100) / 100) < 0.01);
    check('  -> quantities still present alongside pricing', priced.json.derived.total_cabinet_lf === 40);

    const pricedGet = await request(port, 'GET', '/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&tier=best');
    check('GET price=true&tier=best -> best tier', pricedGet.status === 200 && pricedGet.json.pricing.tier === 'best');

    const pricedText = await request(port, 'GET', '/material-takeoff?projectType=kitchen_remodel&kitchenSqft=200&price=true&format=text');
    check('price + format=text -> PROFIT LAYOUT block', /PROFIT LAYOUT/.test(pricedText.text));

    // No pricing requested -> no pricing block (backwards compatible).
    const noPrice = await request(port, 'POST', '/material-takeoff', { projectType: 'kitchen_remodel', kitchenSqft: 200 });
    check('no price flag -> no pricing block (unchanged shape)', noPrice.json.pricing === undefined);

    // Pricing requested but provider unavailable -> quantities still 200, pricing ok:false.
    delete process.env.PRICING_MOCK;
    const noProv = await request(port, 'POST', '/material-takeoff', { projectType: 'kitchen_remodel', kitchenSqft: 200, price: true });
    check('price=true, no provider -> 200, pricing ok:false pricing_unavailable', noProv.status === 200 && noProv.json.ok === true && noProv.json.pricing.ok === false && noProv.json.pricing.reason === 'pricing_unavailable');

    // ── rate limiting ─────────────────────────────────────────────────────
    // Drive the exported limiter directly: tighten to 3/window, reset the buckets,
    // then fire 4 requests from the same client — the 4th must be 429.
    RATE_LIMITER.configure({ max: 3 });
    RATE_LIMITER.reset();
    const rlCodes = [];
    for (let i = 0; i < 4; i++) rlCodes.push((await request(port, 'GET', '/')).status);
    check('first 3 requests under limit -> 200', rlCodes.slice(0, 3).every(s => s === 200));
    const blocked = await request(port, 'GET', '/');   // 5th, still over the limit
    check('over-limit request -> 429 rate_limited', blocked.status === 429 && blocked.json.error === 'rate_limited');
    check('  -> Retry-After + X-RateLimit headers present', !!blocked.headers['retry-after'] && blocked.headers['x-ratelimit-limit'] === '3');
    // /health is exempt from rate limiting even when over the limit.
    const healthOver = await request(port, 'GET', '/health');
    check('/health exempt from rate limit (still 200)', healthOver.status === 200);
    RATE_LIMITER.configure({ max: 120 });               // restore + clear for any later calls
    RATE_LIMITER.reset();

    // 404
    const notFound = await request(port, 'GET', '/nope');
    check('GET /nope -> 404', notFound.status === 404 && notFound.json.error === 'not_found');

  } catch (e) {
    check('suite ran without throwing (' + e.message + ')', false);
  } finally {
    await new Promise(r => server.close(r));
  }

  console.log('\n========================================');
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
