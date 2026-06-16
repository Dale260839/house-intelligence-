/**
 * Material Takeoff — HTTP API tests
 * Spins the real server on an ephemeral port and exercises each route over the wire.
 * Dependency-free (core http only), same harness style as House Intelligence's
 * test_server.js.
 */
const http = require('http');
const { server } = require('./server.js');

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
