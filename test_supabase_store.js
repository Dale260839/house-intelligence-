/**
 * House Intelligence — Supabase store tests
 * Hermetic: a fake transport stands in for the network, so no key and no Supabase
 * project are needed. Verifies the store is INSERT-ONLY, single-table, maps the
 * scope→row correctly, and degrades gracefully on every failure.
 */
const {
  TABLE, toRequestRow, createSupabaseStore, createNoopStore, selectStore,
} = require('./supabase_store.js');

// Fake (url, { method, headers, body }) -> { ok, status, json(), text() } transport.
function fakeFetch({ status = 201, body = [{ id: 'row-1' }], throwErr = null, captured } = {}) {
  return async (url, opts) => {
    if (captured) { captured.url = url; captured.opts = opts || {}; }
    if (throwErr) throw new Error(throwErr);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
}

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
async function checkA(name, fn) { try { check(name, await fn()); } catch (e) { check(name + ' (threw: ' + e.message + ')', false); } }

// A minimal scope like resolveScopeForAddress() returns.
const SCOPE = {
  ok: true,
  severity: 'High',
  address: { freeform: '1730 Minor Ave, Seattle, WA 98101', state: 'WA' },
  build_year_source: { resolved_year: 1945, source: 'rentcast', ok: true, confidence: 'exact' },
  property: { propertyType: 'Single Family', squareFootage: 1820, source: 'rentcast' },
};
const CTX = {
  project_id: '4c6c083e-b688-4701-9a51-11c0',
  contractor_id: '376d487a-d7cf-44a6-8b1d-dd00',
  client_id: '22f56f0f-76a8-465c-8c86-be5e44ba',
  contact_id: 'btgXsbWgoFsrIbzZVuA6',
  address: '1730 Minor Ave, Seattle, WA 98101',
};

(async () => {
  console.log('========================================');
  console.log('toRequestRow — scope + context -> table columns');
  console.log('========================================');

  const row = toRequestRow(SCOPE, CTX);
  check('maps match keys through', row.project_id === CTX.project_id && row.contractor_id === CTX.contractor_id
    && row.client_id === CTX.client_id && row.contact_id === CTX.contact_id);
  check('maps year_built / state / year_source', row.year_built === 1945 && row.state === 'WA' && row.year_source === 'rentcast');
  check('maps resolved (bool) and severity', row.resolved === true && row.severity === 'High');
  check('carries full scope + property as objects', row.scope === SCOPE && row.property === SCOPE.property);
  check('address from scope.address.freeform', row.address === '1730 Minor Ave, Seattle, WA 98101');
  check('drops null/undefined keys (no profile_id when not supplied)', !('profile_id' in row));

  const unresolved = toRequestRow(
    { ok: false, address: { state: 'TX' }, build_year_source: { resolved_year: null, source: 'mock', ok: false } },
    { contractor_id: 'c1', client_id: 'cl1' });
  check('unresolved: resolved=false, no year_built key, keeps state', unresolved.resolved === false
    && !('year_built' in unresolved) && unresolved.state === 'TX');
  check('resolved=false is kept even though falsy (boolean, not null)', 'resolved' in unresolved);

  console.log('\n========================================');
  console.log('createSupabaseStore — INSERT-ONLY, single hardcoded table');
  console.log('========================================');

  check('constructing without url/key throws (config error)', (() => {
    try { createSupabaseStore({}); return false; } catch { return true; }
  })());

  await checkA('insert POSTs an array to /rest/v1/house_intelligence_requests', async () => {
    const cap = {};
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'sb_publishable_x', fetchImpl: fakeFetch({ captured: cap }) });
    await store.insert(row);
    return cap.url === 'https://proj.supabase.co/rest/v1/house_intelligence_requests'
      && cap.opts.method === 'POST' && Array.isArray(cap.opts.body) && cap.opts.body[0] === row;
  });

  await checkA('sends apikey + Bearer auth + return=representation', async () => {
    const cap = {};
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'sb_publishable_secret', fetchImpl: fakeFetch({ captured: cap }) });
    await store.insert(row);
    const h = cap.opts.headers;
    return h.apikey === 'sb_publishable_secret' && h.Authorization === 'Bearer sb_publishable_secret'
      && h['Content-Type'] === 'application/json' && h.Prefer === 'return=representation';
  });

  await checkA('the method is ONLY ever POST (never PATCH/PUT/DELETE)', async () => {
    const cap = {};
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'k', fetchImpl: fakeFetch({ captured: cap }) });
    await store.insert(row);
    return cap.opts.method === 'POST';
  });

  await checkA('table is fixed — an opts.table override is IGNORED', async () => {
    const cap = {};
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'k', table: 'clients', fetchImpl: fakeFetch({ captured: cap }) });
    await store.insert(row);
    return store.table === TABLE && cap.url.endsWith('/rest/v1/house_intelligence_requests') && !cap.url.includes('clients');
  });

  await checkA('trailing slash on url is normalized (no //rest)', async () => {
    const cap = {};
    const store = createSupabaseStore({ url: 'https://proj.supabase.co/', key: 'k', fetchImpl: fakeFetch({ captured: cap }) });
    await store.insert(row);
    return cap.url === 'https://proj.supabase.co/rest/v1/house_intelligence_requests';
  });

  await checkA('happy path returns stored:true and the inserted record', async () => {
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'k', fetchImpl: fakeFetch({ status: 201, body: [{ id: 'abc', address: 'x' }] }) });
    const r = await store.insert(row);
    return r.ok === true && r.stored === true && r.record && r.record.id === 'abc';
  });

  await checkA('HTTP 401 -> auth_error, stored:false, never throws', async () => {
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'bad', fetchImpl: fakeFetch({ status: 401, body: { message: 'no' } }) });
    const r = await store.insert(row);
    return r.ok === false && r.stored === false && r.reason === 'auth_error';
  });

  await checkA('HTTP 404 -> table_not_found', async () => {
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'k', fetchImpl: fakeFetch({ status: 404, body: {} }) });
    const r = await store.insert(row);
    return r.ok === false && r.reason === 'table_not_found';
  });

  await checkA('network throw -> network_error (caught, not rethrown)', async () => {
    const store = createSupabaseStore({ url: 'https://proj.supabase.co', key: 'k', fetchImpl: fakeFetch({ throwErr: 'ECONNRESET' }) });
    const r = await store.insert(row);
    return r.ok === false && r.reason === 'network_error';
  });

  console.log('\n========================================');
  console.log('no-op store + selectStore');
  console.log('========================================');

  await checkA('no-op store echoes the row, persists nothing', async () => {
    const r = await createNoopStore().insert(row);
    return r.ok === true && r.stored === false && r.reason === 'no_supabase_credentials' && r.record === row;
  });

  check('selectStore with creds -> live supabase store', (() => {
    const { store, label } = selectStore({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_KEY: 'k' });
    return store.id === 'supabase' && /supabase \(live\)/.test(label);
  })());
  check('selectStore without creds -> no-op store', (() => {
    const { store } = selectStore({ SUPABASE_URL: '', SUPABASE_KEY: '' });
    return store.id === 'noop';
  })());

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
