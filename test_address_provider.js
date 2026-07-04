const {
  normalizeAddress, parseStateFromText, addressKey, inferMetro,
  redfinSearchUrl, mapRentcastProperty,
  createMockProvider, createRentcastProvider, withCache, resolveScopeForAddress,
} = require('./address_provider.js');

// Build a fake fetch-like transport so the RentCast adapter can be tested with no
// network and no API key. `fetchImpl` matches the (url, { headers }) -> { ok,
// status, json() } contract the adapter expects.
function fakeFetch({ status = 200, body = [], throwErr = null, captured } = {}) {
  return async (url, opts) => {
    if (captured) { captured.url = url; captured.headers = (opts && opts.headers) || {}; }
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
  console.log('RENTCAST ADAPTER — live address -> build year (faked transport)');
  console.log('========================================');

  check('constructing without an apiKey throws (config error)', (() => {
    try { createRentcastProvider({}); return false; } catch { return true; }
  })());

  await checkA('happy path: array body -> ok, year, state, source, confidence', async () => {
    const cap = {};
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [{ yearBuilt: 1952, state: 'WA' }], captured: cap }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok && r.year === 1952 && r.state === 'WA' && r.source === 'rentcast' && r.confidence === 'exact';
  });

  await checkA('sends X-Api-Key header and URL-encodes the address', async () => {
    const cap = {};
    const rc = createRentcastProvider({ apiKey: 'secret-key', fetchImpl: fakeFetch({ body: [{ yearBuilt: 1990, state: 'IL' }], captured: cap }) });
    await rc.resolveBuildYear('233 S Wacker Dr, Chicago, IL 60606');
    return cap.headers['X-Api-Key'] === 'secret-key'
      && cap.url.startsWith('https://api.rentcast.io/v1/properties?address=')
      && cap.url.includes('Chicago') && cap.url.includes('%2C'); // comma encoded
  });

  await checkA('non-array (single object) body is accepted too', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: { yearBuilt: 1925, state: 'NY' } }) });
    const r = await rc.resolveBuildYear('1 Park Ave, New York, NY 10016');
    return r.ok && r.year === 1925 && r.state === 'NY';
  });

  await checkA('record present but no yearBuilt -> year_unknown (keeps state)', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [{ state: 'TX' }] }) });
    const r = await rc.resolveBuildYear('500 Somewhere Rd, Austin, TX 78701');
    return r.ok === false && r.reason === 'year_unknown' && r.state === 'TX';
  });

  await checkA('empty array -> not_found', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [] }) });
    const r = await rc.resolveBuildYear('999 Nowhere St, Voidville, WA');
    return r.ok === false && r.reason === 'not_found';
  });

  await checkA('HTTP 401/403 -> auth_error', async () => {
    const rc = createRentcastProvider({ apiKey: 'bad', fetchImpl: fakeFetch({ status: 401, body: { error: 'unauthorized' } }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok === false && r.reason === 'auth_error';
  });

  await checkA('HTTP 429 -> rate_limited', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ status: 429, body: {} }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok === false && r.reason === 'rate_limited';
  });

  await checkA('network throw -> provider_error (never throws out)', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ throwErr: 'ECONNRESET' }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok === false && r.reason === 'provider_error';
  });

  await checkA('end-to-end: RentCast result -> SEA-1930 era scope', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [{ yearBuilt: 1945, state: 'WA' }] }) });
    const scope = await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider: rc });
    return scope.ok && scope.row.id === 'SEA-1930' && scope.build_year_source.source === 'rentcast';
  });

  await checkA('withCache wraps RentCast: 1 underlying call per unique address', async () => {
    let calls = 0;
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: async () => { calls++; return { ok: true, status: 200, async json() { return [{ yearBuilt: 1968, state: 'IL' }]; } }; } });
    const cached = withCache(rc);
    await cached.resolveBuildYear('233 S Wacker Dr, Chicago, IL 60606');
    await cached.resolveBuildYear('233 S Wacker Dr., CHICAGO, il 60606'); // same addr, reformatted
    return calls === 1 && cached.stats().hits === 1;
  });

  console.log('\n========================================');
  console.log('PROPERTY DETAILS — "more info about the house" (size/layout + features)');
  console.log('========================================');

  // A representative RentCast /properties record (extra fields incl. sale history
  // that we deliberately DO NOT surface).
  const rcRec = {
    yearBuilt: 1952, state: 'WA', propertyType: 'Single Family',
    squareFootage: 1820, bedrooms: 3, bathrooms: 2, lotSize: 5000,
    lastSalePrice: 750000, lastSaleDate: '2019-04-01',          // sale history — must be ignored
    features: { heating: true, heatingType: 'Forced Air', cooling: false,
                garage: true, garageSpaces: 1, pool: false, roofType: 'Asphalt',
                foundationType: 'Basement', exteriorType: 'Wood', floorCount: 2, roomCount: 7 },
  };

  check('mapRentcastProperty pulls core size/layout', (() => {
    const p = mapRentcastProperty(rcRec);
    return p.propertyType === 'Single Family' && p.squareFootage === 1820
      && p.bedrooms === 3 && p.bathrooms === 2 && p.lotSize === 5000
      && p.floorCount === 2 && p.roomCount === 7 && p.source === 'rentcast';
  })());
  check('mapRentcastProperty pulls features (heating/garage/roof)', (() => {
    const f = mapRentcastProperty(rcRec).features;
    return f.heating === true && f.heatingType === 'Forced Air' && f.garage === true
      && f.garageSpaces === 1 && f.roofType === 'Asphalt' && f.foundationType === 'Basement';
  })());
  check('mapRentcastProperty does NOT surface sale history / valuation', (() => {
    const p = mapRentcastProperty(rcRec);
    return !('lastSalePrice' in p) && !('lastSaleDate' in p)
      && !('lastSalePrice' in p.features) && JSON.stringify(p).indexOf('750000') === -1;
  })());
  check('mapRentcastProperty drops null/absent fields (sparse record)', (() => {
    const p = mapRentcastProperty({ propertyType: 'Condo', squareFootage: null, bedrooms: 2 });
    return p.propertyType === 'Condo' && p.bedrooms === 2
      && !('squareFootage' in p) && !('lotSize' in p) && !('features' in p);
  })());
  check('mapRentcastProperty returns null when there is no record', mapRentcastProperty(null) === null);

  await checkA('RentCast adapter attaches property on a successful lookup', async () => {
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [rcRec] }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok && r.year === 1952 && r.property && r.property.squareFootage === 1820
      && r.property.source === 'rentcast';
  });
  await checkA('RentCast adapter still surfaces property when the YEAR is unknown', async () => {
    const { yearBuilt, ...noYear } = rcRec;                     // record present, no yearBuilt
    const rc = createRentcastProvider({ apiKey: 'k', fetchImpl: fakeFetch({ body: [noYear] }) });
    const r = await rc.resolveBuildYear('1730 Minor Ave, Seattle, WA 98101');
    return r.ok === false && r.reason === 'year_unknown' && r.property && r.property.bedrooms === 3;
  });

  await checkA('end-to-end: scope carries property details for the Seattle fixture', async () => {
    const s = await resolveScopeForAddress('1730 Minor Ave, Seattle, WA 98101', { provider: createMockProvider() });
    return s.property && s.property.squareFootage === 1820 && s.property.bedrooms === 3
      && s.property.features.heatingType === 'Forced Air' && s.property.source === 'mock';
  });
  await checkA('end-to-end: scope.property is null when the source has no details', async () => {
    const bare = createMockProvider({ 'x y ca': { year: 1970, state: 'CA' } }, 'bare');
    const s = await resolveScopeForAddress('X, Y, CA', { provider: bare });
    return s.ok && s.property === null;
  });

  console.log('\n========================================');
  console.log('REDFIN DEEP-LINK — lead/context only (no data, no key)');
  console.log('========================================');
  check('redfinSearchUrl builds a redfin.com search link from the address', (() => {
    const u = redfinSearchUrl('1730 Minor Ave, Seattle, WA 98101');
    return typeof u === 'string' && u.startsWith('https://www.redfin.com/search?location=')
      && u.includes('Seattle') && u.includes('%2C');           // address present + comma-encoded
  })());
  check('redfinSearchUrl returns null for an empty address', redfinSearchUrl('') === null);
  await checkA('scope exposes lead_links.redfin (even when the year is unresolved)', async () => {
    const s = await resolveScopeForAddress('999 Nowhere St, Voidville, ZZ', { provider: createMockProvider() });
    return s.lead_links && typeof s.lead_links.redfin === 'string'
      && s.lead_links.redfin.includes('redfin.com');           // present regardless of lookup outcome
  });

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
