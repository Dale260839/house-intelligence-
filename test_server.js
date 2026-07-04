/**
 * House Intelligence — HTTP API tests
 * Spins the real server on an ephemeral port and exercises each route over the
 * wire. Dependency-free (core http only), same harness style as the other suites.
 */
const http = require('http');
// Keep this suite hermetic: force the bundled MockProvider regardless of any real
// RENTCAST_API_KEY in the environment or .env (a defined-but-empty value is honored
// by server.js's loader and treated as "no key"). Without this, adding a live key
// would make these tests hit the RentCast network and flip the mock assertions.
process.env.RENTCAST_API_KEY = '';
// Same reasoning for Supabase: force the no-op store so these tests never touch a
// live Supabase project even if SUPABASE_URL/KEY are present in .env.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
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
          resolve({ status: res.statusCode, json, text: raw });
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
    check('GET / advertises no-vendor default', /MockProvider/.test(index.json.vendor_adapter));

    // Year path
    const byYear = await request(port, 'GET', '/scope?year=1945&state=WA&metro=SEA');
    check('GET /scope?year=1945&state=WA&metro=SEA -> ok', byYear.status === 200 && byYear.json.ok === true);
    check('  → era 1930–1949', byYear.json.era && byYear.json.era.range[0] === 1930);
    check('  → blueprint row SEA-1930', byYear.json.row && byYear.json.row.id === 'SEA-1930');

    // Address path (mock provider, no vendor adapter)
    const byAddr = await request(port, 'GET', '/scope?address=' + encodeURIComponent('1730 Minor Ave, Seattle, WA 98101'));
    check('GET /scope?address=... resolves via mock -> ok', byAddr.status === 200 && byAddr.json.ok === true);
    check('  → build_year_source.source = mock', byAddr.json.build_year_source && byAddr.json.build_year_source.source === 'mock');
    check('  → resolved year 1945', byAddr.json.build_year_source.resolved_year === 1945);

    // Unknown address still 200, graceful ok:false (no vendor needed to not-crash)
    const unknown = await request(port, 'GET', '/scope?address=' + encodeURIComponent('999 Nowhere Rd, Faketown, ZZ'));
    check('unknown address -> 200 graceful ok:false', unknown.status === 200 && unknown.json.ok === false);

    // text format
    const asText = await request(port, 'GET', '/scope?year=1945&state=WA&format=text');
    check('format=text -> plain text scope block', /SCOPE OF WORK/.test(asText.text) && asText.json === null);

    // POST body, year
    const post = await request(port, 'POST', '/scope', { year: 1968, state: 'IL' });
    check('POST /scope { year, state } -> ok', post.status === 200 && post.json.ok === true);

    // POST body, address
    const postAddr = await request(port, 'POST', '/scope', { address: '233 S Wacker Dr, Chicago, IL 60606' });
    check('POST /scope { address } -> resolved 1968', postAddr.json.ok === true && postAddr.json.build_year_source.resolved_year === 1968);

    // invalid JSON body
    const badJson = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/scope',
        headers: { 'Content-Type': 'application/json' } }, res => {
        let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, raw }));
      });
      req.on('error', reject); req.write('{ not json'); req.end();
    });
    check('POST invalid JSON -> 400', badJson.status === 400);

    // POST /intelligence — BuildSuite match context -> scope + persistence outcome
    const intel = await request(port, 'POST', '/intelligence', {
      address: '1730 Minor Ave, Seattle, WA 98101',
      project_id: 'p1', contractor_id: 'c1', client_id: 'cl1', contact_id: 'ghl1',
    });
    check('POST /intelligence -> 200 with scope resolved', intel.status === 200 && intel.json.ok === true
      && intel.json.scope.build_year_source.resolved_year === 1945);
    check('  → no-op store reports stored:false (no creds in tests)',
      intel.json.stored && intel.json.stored.ok === true && intel.json.stored.stored === false);
    check('  → echoed row carries match keys + mapped detail',
      intel.json.stored.record.contractor_id === 'c1' && intel.json.stored.record.client_id === 'cl1'
      && intel.json.stored.record.year_built === 1945 && intel.json.stored.record.severity);
    const intelNoAddr = await request(port, 'POST', '/intelligence', { contractor_id: 'c1' });
    check('POST /intelligence without address -> 400', intelNoAddr.status === 400 && intelNoAddr.json.error === 'missing_address');

    // rows grid
    const rows = await request(port, 'GET', '/rows?region=SEA');
    check('GET /rows?region=SEA -> ok with rows[]', rows.status === 200 && rows.json.ok === true && rows.json.rows.length > 0);
    const missingRegion = await request(port, 'GET', '/rows');
    check('GET /rows (no region) -> 400', missingRegion.status === 400);

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
