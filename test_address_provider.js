const {
  normalizeAddress, parseStateFromText, addressKey, inferMetro,
  createMockProvider, withCache, resolveScopeForAddress,
} = require('./address_provider.js');

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
// async-aware assertion
async function checkA(name, fn) { try { check(name, await fn()); } catch (e) { check(name + ' (threw: ' + e.message + ')', false); } }

(async () => {
  console.log('========================================');
  console.log('ADDRESS NORMALIZATION & STATE PARSING');
  console.log('========================================');
  check('string address -> freeform preserved',
    normalizeAddress('1730 Minor Ave, Seattle, WA 98101').freeform.includes('Seattle'));
  check('string address -> state parsed (WA)',
    normalizeAddress('1730 Minor Ave, Seattle, WA 98101').state === 'WA');
  check('object address -> assembled freeform',
    normalizeAddress({ line1: '233 S Wacker Dr', city: 'Chicago', state: 'IL', zip: '60606' }).state === 'IL');
  check('invalid 2-letter token is NOT treated as state',
    parseStateFromText('123 XX Street, Faketown') === '');
  check('last valid state token wins',
    parseStateFromText('Sent from OR office to Dallas, TX 75201') === 'TX');
  check('addressKey is stable across punctuation/case/space',
    addressKey('1730  Minor Ave., Seattle, WA 98101') === addressKey('1730 minor ave seattle wa 98101'));
  check('null address does not throw', normalizeAddress(null).freeform === '');
  check('string address parses CITY before the state token',
    normalizeAddress('100 Chicago Ave, Tucson, AZ').city === 'Tucson');

  console.log('\n========================================');
  console.log('METRO INFERENCE — city-accurate, state-guarded (no substring bug)');
  console.log('========================================');
  check('Seattle address infers SEA', inferMetro('1730 Minor Ave, Seattle, WA 98101') === 'SEA');
  check('city name inside a STREET does not mis-infer (Chicago Ave, Tucson AZ)', inferMetro('100 Chicago Ave, Tucson, AZ') === '');
  check('metro rejected when its state disagrees', inferMetro('1 Chicago St, Chicago, FL') === '');
  check('Seattle address -> SEA-1930 row end-to-end', (await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider: createMockProvider() })).row.id === 'SEA-1930');
  await checkA('provider state overriding the city drops the metro (label matches regions)', async () => {
    const wrongState = { id: 'wrong', async resolveBuildYear() { return { ok: true, year: 1945, state: 'CA', source: 'wrong', confidence: 'exact' }; } };
    const s = await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider: wrongState });
    // metro SEA implies WA, but provider says CA -> metro dropped, label + regions follow CA.
    return s.row.region === 'California (CA)' && s.regions_applied.some(r => r.id === 'seismic_west') && !s.regions_applied.some(r => r.id === 'pacific_nw');
  });

  console.log('\n========================================');
  console.log('MOCK PROVIDER: address -> build year');
  console.log('========================================');
  const provider = createMockProvider();
  await checkA('known Seattle address resolves to 1945', async () =>
    (await provider.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101')).year === 1945);
  await checkA('resolution carries source + confidence', async () => {
    const r = await provider.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok && r.source === 'mock' && r.confidence === 'exact';
  });
  await checkA('unknown address -> ok:false reason not_found', async () => {
    const r = await provider.resolveBuildYear('999 Nowhere St, Voidville, ZZ');
    return r.ok === false && r.reason === 'not_found';
  });
  await checkA('found-but-no-year -> ok:false reason year_unknown', async () => {
    const r = await provider.resolveBuildYear('500 UnknownYear Rd, Austin, TX 78701');
    return r.ok === false && r.reason === 'year_unknown' && r.state === 'TX';
  });

  console.log('\n========================================');
  console.log('END-TO-END: address -> full era scope (spec example)');
  console.log('========================================');
  const seattle = await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider });
  check('scope ok', seattle.ok === true);
  check('resolved via provenance block', seattle.build_year_source.resolved_year === 1945 && seattle.build_year_source.source === 'mock');
  check('era is 1930_1949 (from resolved year)', seattle.era.id === '1930_1949');
  check('WA regions applied from resolved/parsed state', seattle.regions_applied.some(r => r.id === 'pacific_nw') && seattle.regions_applied.some(r => r.id === 'seismic_west'));
  check('high-priority hazards present (lead/asbestos)', seattle.high_priority_flags.some(f => /lead-based paint/i.test(f)) && seattle.high_priority_flags.some(f => /asbestos/i.test(f)));
  check('address echoed back on scope', seattle.address.state === 'WA');

  console.log('\n========================================');
  console.log('GRACEFUL DEGRADE when year cannot be resolved');
  console.log('========================================');
  const noYear = await resolveScopeForAddress('500 UnknownYear Rd, Austin, TX 78701', { provider });
  check('unresolved year -> scope ok:false (engine standard fallback)', noYear.ok === false);
  check('failure reason surfaced in provenance', noYear.build_year_source.ok === false && noYear.build_year_source.reason === 'year_unknown');
  const notFound = await resolveScopeForAddress('999 Nowhere St, Voidville, ZZ', { provider });
  check('not-found address -> ok:false, reason not_found', notFound.ok === false && notFound.build_year_source.reason === 'not_found');

  console.log('\n========================================');
  console.log('PROVIDER ERRORS are caught, never thrown');
  console.log('========================================');
  const boom = { id: 'boom', async resolveBuildYear() { throw new Error('network down'); } };
  const errScope = await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider: boom });
  check('throwing provider -> graceful ok:false', errScope.ok === false && errScope.build_year_source.reason === 'provider_error');

  console.log('\n========================================');
  console.log('CACHE DECORATOR: one underlying call per unique address');
  console.log('========================================');
  let underlyingCalls = 0;
  const counting = {
    id: 'counting',
    async resolveBuildYear(addr) { underlyingCalls++; return createMockProvider().resolveBuildYear(addr); }
  };
  const cached = withCache(counting);
  await cached.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
  await cached.resolveBuildYear('1730 Minor Ave., SEATTLE, wa  98101'); // same addr, different formatting
  await cached.resolveBuildYear('233 S Wacker Dr, Chicago, IL 60606');
  check('repeat address served from cache (2 unique -> 2 underlying calls)', underlyingCalls === 2);
  check('cache stats report a hit', cached.stats().hits === 1 && cached.stats().size === 2);
  await checkA('failed lookups are NOT cached (retryable)', async () => {
    const c2start = underlyingCalls;
    await cached.resolveBuildYear('999 Nowhere St, Voidville, ZZ');
    await cached.resolveBuildYear('999 Nowhere St, Voidville, ZZ');
    return (underlyingCalls - c2start) === 2; // both miss, both hit underlying
  });

  console.log('\n========================================');
  console.log('PROVIDER-AGNOSTIC: swap source, identical engine behavior');
  console.log('========================================');
  const altProvider = createMockProvider({ 'same place anytown ca': { year: 1968, state: 'CA' } }, 'alt-source');
  const altScope = await resolveScopeForAddress('Same Place, Anytown, CA', { provider: altProvider });
  check('different provider id flows through', altScope.build_year_source.source === 'alt-source');
  check('same engine result (1968 -> 1965_1979 + CA seismic)', altScope.era.id === '1965_1979' && altScope.region_specific_items.some(f => /seismic|cripple|bolting/i.test(f)));

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
