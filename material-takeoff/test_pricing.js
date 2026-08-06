/**
 * Material Takeoff — pricing & profit tests
 * Same dependency-free harness style as test_engine.js. Uses the deterministic mock
 * pricing provider (no key, no network) plus a fake transport to exercise the LIVE
 * provider's URL building + response parsing without hitting a real API.
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const { priceTakeoff, renderPricingText } = require('./pricing_engine.js');
const {
  createMockPricingProvider, createHomeDepotProvider, selectPricingProvider,
  parsePrice, normalizePackPrice, extractProduct, buildSearchUrl, MOCK_UNIT_PRICES,
} = require('./pricing_provider.js');

const ds = loadDataset();
let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const takeoff = () => buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200 }, ds);
const pline = (p, key) => p.lines.find(l => l.key === key);

(async () => {
  console.log('========================================');
  console.log('PRICING — canonical 200 sqft kitchen, mock provider, "better" tier');
  console.log('========================================');

  const mock = createMockPricingProvider();
  const t = takeoff();
  const p = await priceTakeoff(t, { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  console.log(renderPricingText(p));
  console.log('');

  check('pricing ok', p.ok === true);
  check('source is mock', p.source === 'mock');
  check('tier is better', p.tier === 'better');
  check('every material line priced (mock covers all)', p.fully_priced === true && p.unpriced_lines.length === 0);
  check('priced line count == material line count', p.lines.length === t.materials.length);

  // --- per-line cost = unit_price x order_qty ---
  const thinset = pline(p, 'thinset');
  check('thinset unit price = mock better (18)', thinset.unit_price === 18);
  check('thinset line cost = 18 x 4 bags = 72', thinset.line_cost === 72);
  const baseCab = pline(p, 'base_cabinets');
  check('base cabinets priced per LF (200 x 24 = 4800)', baseCab.unit_price === 200 && baseCab.line_cost === 4800);
  check('made-to-measure line flagged field_estimate', baseCab.field_estimate === true);

  // --- profit layout arithmetic ---
  const g = p.profit_layout;
  const expectMaterials = t.materials.reduce((s, m) => {
    const up = MOCK_UNIT_PRICES[m.key] && MOCK_UNIT_PRICES[m.key].better;
    return s + (up != null ? up * m.order_qty : 0);
  }, 0);
  check('materials_cost = sum of line costs', approx(g.materials_cost, Math.round(expectMaterials * 100) / 100));
  check('labor = 100% of materials', approx(g.labor_cost, g.materials_cost));
  check('total_cost = materials + labor', approx(g.total_cost, g.materials_cost + g.labor_cost));
  check('price = total_cost x 1.20 (20% markup)', approx(g.price, Math.round(g.total_cost * 1.2 * 100) / 100));
  check('profit = price - total_cost', approx(g.profit, Math.round((g.price - g.total_cost) * 100) / 100));
  // margin implied by a 20% markup is 1 - 1/1.2 = 16.67%
  check('margin_pct implied by 20% markup ~= 16.7%', approx(g.margin_pct, 16.7, 0.1));

  console.log('\n========================================');
  console.log('TIER + KNOB behaviour');
  console.log('========================================');

  const good = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'good', laborPct: 100, markupPct: 20 });
  const best = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'best', laborPct: 100, markupPct: 20 });
  check('good tier cheaper than better', good.profit_layout.materials_cost < g.materials_cost);
  check('best tier pricier than better', best.profit_layout.materials_cost > g.materials_cost);
  check('best tier label present', /premium/i.test(best.tier_label));

  const bumpMarkup = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'better', markupPct: 50, laborPct: 100 });
  check('higher markup -> higher price', bumpMarkup.profit_layout.price > g.price);
  check('50% markup -> ~33.3% margin', approx(bumpMarkup.profit_layout.margin_pct, 33.3, 0.1));

  const explicitLabor = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborCost: 5000 });
  check('explicit laborCost wins over laborPct', explicitLabor.profit_layout.labor_cost === 5000 && explicitLabor.labor.basis === 'explicit');

  const zeroLabor = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborPct: 0 });
  check('laborPct 0 -> labor cost 0, total == materials', zeroLabor.profit_layout.labor_cost === 0 && approx(zeroLabor.profit_layout.total_cost, zeroLabor.profit_layout.materials_cost));

  const badTier = await priceTakeoff(takeoff(), { provider: mock, dataset: ds, tier: 'platinum', laborPct: 100, markupPct: 20 });
  check('unknown tier falls back to default + warns', badTier.tier === 'better' && Array.isArray(badTier.warnings) && badTier.warnings.length > 0);

  const defaults = await priceTakeoff(takeoff(), { provider: mock, dataset: ds });
  check('defaults: tier=better, markup=20, labor=100% from dataset', defaults.tier === 'better' && defaults.profit_layout.markup_pct === 20 && approx(defaults.profit_layout.labor_cost, defaults.profit_layout.materials_cost));

  console.log('\n========================================');
  console.log('PROVIDER GUARDS');
  console.log('========================================');

  const noProvider = await priceTakeoff(takeoff(), { provider: null, dataset: ds });
  check('no provider -> ok:false pricing_unavailable', noProvider.ok === false && noProvider.reason === 'pricing_unavailable');

  // A provider that never matches -> every line unpriced. Too large a fail share flips ok:false
  // (pricing_degraded) so consumers degrade off one signal, but the payload is still returned.
  const emptyProvider = { id: 'empty', source: 'empty', async lookup() { return { ok: false, reason: 'no_match' }; } };
  const allUnpriced = await priceTakeoff(takeoff(), { provider: emptyProvider, dataset: ds });
  check('all-miss provider -> ok:false pricing_degraded, fully_priced:false',
    allUnpriced.ok === false && allUnpriced.reason === 'pricing_degraded' && allUnpriced.fully_priced === false);
  check('all-miss -> priced_count 0, unpriced_count = all lines',
    allUnpriced.priced_count === 0 && allUnpriced.unpriced_count === takeoff().materials.length);
  check('all-miss -> materials_cost 0 and all lines listed unpriced', allUnpriced.profit_layout.materials_cost === 0 && allUnpriced.unpriced_lines.length === takeoff().materials.length);

  console.log('\n========================================');
  console.log('CONCURRENCY — lookups overlap, capped, order preserved');
  console.log('========================================');
  {
    let inFlight = 0, maxInFlight = 0;
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const slow = {
      id: 'slow', source: 'slow',
      async lookup({ key, tier: tr }) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(15);
        inFlight--;
        const price = (MOCK_UNIT_PRICES[key] && MOCK_UNIT_PRICES[key][tr]) || 10;
        return { ok: true, unit_price: price, currency: 'USD', product_title: key, source: 'slow' };
      },
    };
    const tk = takeoff();
    const pr = await priceTakeoff(tk, { provider: slow, dataset: ds, tier: 'better' });
    check('all lines priced via slow provider', pr.fully_priced === true);
    check('lookups ran CONCURRENTLY (maxInFlight > 1, not sequential)', maxInFlight > 1);
    check('concurrency CAPPED at <= 5', maxInFlight <= 5);
    check('priced lines preserve material order',
      JSON.stringify(pr.lines.map(l => l.key)) === JSON.stringify(tk.materials.map(m => m.key)));
  }

  console.log('\n========================================');
  console.log('LIVE PROVIDER — URL building + response parsing (fake transport)');
  console.log('========================================');

  check('parsePrice handles number', parsePrice(12.98) === 12.98);
  check('parsePrice handles "$1,299.00"', parsePrice('$1,299.00') === 1299);
  check('parsePrice handles {extracted_value}', parsePrice({ extracted_value: 42.5 }) === 42.5);
  check('parsePrice rejects zero/garbage', parsePrice(0) === null && parsePrice('n/a') === null);
  // Range-safety: a HD price range must take the FIRST number, not concatenate digits.
  check('parsePrice "$10 - $20" -> 10 (not 1020)', parsePrice('$10 - $20') === 10);
  check('parsePrice "$1,299.00 - $1,499.00" -> 1299', parsePrice('$1,299.00 - $1,499.00') === 1299);
  check('parsePrice "$12.98 each" -> 12.98', parsePrice('$12.98 each') === 12.98);
  check('parsePrice "from $8.47/sq. ft." -> 8.47', parsePrice('from $8.47/sq. ft.') === 8.47);

  check('extractProduct: SerpApi products[]', extractProduct({ products: [{ title: 'A', link: 'u', price: '$5.00' }] }).price === 5);
  check('extractProduct: BigBox search_results[].product', extractProduct({ search_results: [{ product: { title: 'B', price: 9.99 } }] }).price === 9.99);
  check('extractProduct: flat product', extractProduct({ product: { title: 'C', price: '$3' } }).price === 3);
  check('extractProduct: nothing usable -> null', extractProduct({ foo: 'bar' }) === null);

  // Outlier guard: bulk/pallet SKUs sometimes rank first. Real case that shipped a $580k
  // quote: a "cement backer board" search returned a $19,275 pallet before the $15 sheet.
  const withPallet = { products: [
    { title: 'Cement Backerboard PALLET', price: 19275 },
    { title: 'Cement Backerboard 3x5', price: 15.48 },
    { title: 'Cement Backerboard 3x5 alt', price: 16.98 },
    { title: 'Backer board 4x8', price: 22.10 },
  ] };
  check('outlier guard skips a pallet SKU listed first', extractProduct(withPallet).price === 15.48);
  check('  and keeps its title/url aligned to the picked product', /3x5/.test(extractProduct(withPallet).title));
  check('normal first result is still chosen (no false positives)',
    extractProduct({ products: [{ title: 'A', price: 17.98 }, { title: 'B', price: 21.98 }] }).price === 17.98);
  check('explicit maxPrice caps too', extractProduct({ products: [
    { title: 'pricey', price: 90 }, { title: 'ok', price: 40 }] }, { maxPrice: 50 }).price === 40);
  check('all-outlier / single result -> cheapest, never a pallet',
    extractProduct({ products: [{ title: 'only', price: 19275 }] }).price === 19275);
  check('outlierFactor is tunable', extractProduct(withPallet, { outlierFactor: 2000 }).price === 19275);
  check('extractProduct normalizes apionline -> www.homedepot.com', extractProduct({ products: [{ title: 'T', price: 5, link: 'https://apionline.homedepot.com/p/x/123' }] }).url === 'https://www.homedepot.com/p/x/123');

  // LOW-SIDE FLOOR (swatch guard, U4): the mirror of the pallet guard. Countertop / vanity-top
  // searches surface 4x4in SAMPLE SWATCHES (~$4) beside the real slabs; a swatch read as a
  // $/sqft price silently UNDER-states the whole counter. min_unit_price floors them out.
  const withSwatch = { products: [
    { title: 'Quartz Countertop Sample 4 in. x 4 in.', price: 3.98 },
    { title: 'Calacatta Quartz Countertop Slab', price: 55.00 },
    { title: 'Quartz Countertop', price: 62.00 },
  ] };
  check('low-side floor drops a $4 sample swatch, picks the slab', extractProduct(withSwatch, { minPrice: 10 }).price === 55);
  check('  the picked title aligns to the slab, not the swatch', /slab/i.test(extractProduct(withSwatch, { minPrice: 10 }).title));
  check('  without the floor the swatch is taken (the bug it guards)', extractProduct(withSwatch).price === 3.98);
  check('all-swatch result + floor -> null (degrade to no_match, not a wrong low price)',
    extractProduct({ products: [{ price: 3.98 }, { price: 4.5 }] }, { minPrice: 10 }) === null);
  check('floor + ceiling together: both swatch AND pallet dropped', extractProduct({ products: [
    { title: 'swatch', price: 4 }, { title: 'pallet', price: 9000 }, { title: 'slab', price: 58 }] },
    { minPrice: 10, maxPrice: 500 }).price === 58);

  // Live provider threads minPrice end-to-end.
  const swatchFetch = async () => ({ ok: true, status: 200,
    async json() { return { products: [{ title: 'Sample', price: 3.98 }, { title: 'Quartz Slab', price: 54.5 }] }; },
    async text() { return ''; } });
  const floored = createHomeDepotProvider({ apiKey: 'K', fetchImpl: swatchFetch });
  const fr = await floored.lookup({ query: 'quartz countertop slab', minPrice: 10 });
  check('live provider passes minPrice to extractProduct (swatch skipped)', fr.ok === true && fr.unit_price === 54.5);

  // The two swatch-prone made-to-measure lines carry the floor in the dataset.
  check('dataset: kitchen countertop has a min_unit_price floor',
    ds.project_types.kitchen_remodel.pricing.lines.countertop.min_unit_price >= 5);
  check('dataset: bathroom vanity_top has a min_unit_price floor',
    ds.project_types.bathroom_remodel.pricing.lines.vanity_top.min_unit_price >= 5);

  console.log('\n========================================');
  console.log('PACK / CASE NORMALIZATION + per-line bands (Issue 1)');
  console.log('========================================');

  // Home Depot lists flooring by the case / trim by the pack, with the size in the title.
  check('LVP case price -> per sqft (42.87 / 23.95 = 1.79)',
    normalizePackPrice(42.87, 'sqft', 'Edwards Oak Click Lock LVP Flooring (23.95 sqft/case)') === 1.79);
  check('tile case price -> per sqft (58.14 / 15.6 = 3.73)',
    normalizePackPrice(58.14, 'sqft', 'Porcelain Tile 12 in. x 24 in. (15.6 sq. ft./case)') === 3.73);
  check('baseboard 5-pack / 80 LF -> per 16 ft stick (128 / 5 = 25.6)',
    normalizePackPrice(128, '16 ft stick', 'Primed Pine Baseboard Moulding (5-Pack - 80 Total Linear Feet)') === 25.6);
  check('generic "Case of 12" -> /12', normalizePackPrice(60, 'ea', 'Cabinet Pulls (Case of 12)') === 5);
  check('generic "(6-Pack)" -> /6', normalizePackPrice(30, 'roll', 'Painters Tape (6-Pack)') === 5);
  check('already per-sqft (no case stated) is unchanged', normalizePackPrice(2.98, 'sqft', 'Ceramic Floor Tile 12 in. x 12 in.') === 2.98);
  check('no title / no unit -> unchanged (safe no-op)', normalizePackPrice(9.99, '', null) === 9.99 && normalizePackPrice(9.99, 'sqft', null) === 9.99);

  // extractProduct normalizes + applies the band end to end.
  const lvp = extractProduct({ products: [
    { title: 'Edwards Oak LVP (23.95 sqft/case)', price: 42.87 },
    { title: 'Budget LVP (19.6 sqft/case)', price: 33.0 },
  ] }, { priceUnit: 'sqft', minPrice: 1, maxPrice: 8 });
  check('extractProduct: case LVP normalized into band (~1.79)', Math.abs(lvp.price - 1.79) < 0.01);
  check('  -> 1498 sqft line is ~$2,681 not ~$64k', Math.round(lvp.price * 1498) < 3000);

  // An out-of-band price that can't be pack-parsed is dropped (Sing: prefer unpriced over a 24x error).
  const oob = extractProduct({ products: [{ title: 'Mystery Flooring Bundle', price: 189.0 }] },
    { priceUnit: 'sqft', minPrice: 1, maxPrice: 8 });
  check('unparseable out-of-band price -> null (degrade to unpriced)', oob === null);

  // The dumpster consumer bag matched against a 20 cu yd rental line -> floor rejects it.
  const bag = extractProduct({ products: [{ title: 'Dumpster in a Bag (Holds 3,300 lb.)', price: 29.95 }] },
    { priceUnit: '20 cu yd dumpster', minPrice: 200 });
  check('dumpster consumer bag rejected by floor (the 12x-under guard)', bag === null);
  check('dataset: dumpster search retuned off the consumer bag',
    /rental/i.test(ds.project_types.flooring_only.pricing.lines.demolition_dumpster.search.better));

  // Live provider path: a case-priced LVP normalized via the threaded priceUnit + band.
  const caseFetch = async () => ({ ok: true, status: 200,
    async json() { return { products: [{ title: 'LVP (23.95 sqft/case)', price: 42.87 }] }; }, async text() { return ''; } });
  const liveLvp = createHomeDepotProvider({ apiKey: 'K', fetchImpl: caseFetch });
  const lr = await liveLvp.lookup({ query: 'lvp', priceUnit: 'sqft', minPrice: 1, maxPrice: 8 });
  check('live provider normalizes a case price to per-sqft', lr.ok === true && Math.abs(lr.unit_price - 1.79) < 0.01);

  // Full priceTakeoff path exercises PRICE_BANDS -> lookup(priceUnit,min,max) -> normalize.
  const smartFetch = async (u) => {
    const q = decodeURIComponent((String(u).match(/[?&]q=([^&]+)/) || [])[1] || '');
    const products = /vinyl|lvp/i.test(q) ? [{ title: 'LVP (23.95 sqft/case)', price: 42.87 }] : [{ title: q, price: 20 }];
    return { ok: true, status: 200, async json() { return { products }; }, async text() { return ''; } };
  };
  const flTk = buildTakeoff({ projectType: 'flooring_only', floorSqft: 1400 }, ds);
  const flPr = await priceTakeoff(flTk, { provider: createHomeDepotProvider({ apiKey: 'K', fetchImpl: smartFetch }), dataset: ds, tier: 'better' });
  const lvpLine = flPr.lines.find(l => l.key === 'flooring_lvp');
  check('priceTakeoff: 1400 sqft LVP line is sane (< $3k, not $64k)', lvpLine && lvpLine.unit_price < 8 && lvpLine.line_cost < 3000);

  const url = buildSearchUrl('', 'SECRET', 'thinset mortar 50 lb');
  check('buildSearchUrl default = SerpApi home_depot + q + api_key', /serpapi\.com/.test(url) && /q=thinset%20mortar%2050%20lb/.test(url) && /api_key=SECRET/.test(url));
  const tmpl = buildSearchUrl('https://api.example.com/hd?term={query}&key={key}', 'K', 'grout');
  check('buildSearchUrl honors {query}/{key} template', tmpl === 'https://api.example.com/hd?term=grout&key=K');

  // Fake transport records the URL it was asked to fetch and returns a canned product.
  let seenUrl = null;
  const fakeFetch = async (u) => {
    seenUrl = u;
    return { ok: true, status: 200, async json() { return { products: [{ title: 'Custom Thinset', link: 'https://homedepot.com/p/1', price: '$21.47' }] }; }, async text() { return ''; } };
  };
  const live = createHomeDepotProvider({ apiKey: 'KEY123', fetchImpl: fakeFetch });
  check('live provider id', live.id === 'homedepot_live');
  const r = await live.lookup({ key: 'thinset', query: 'thinset mortar 50 lb', tier: 'better' });
  check('live lookup parses price 21.47', r.ok === true && r.unit_price === 21.47);
  check('live lookup carries product title + url + source', r.product_title === 'Custom Thinset' && /homedepot\.com/.test(r.product_url) && r.source === 'homedepot_live');
  check('live lookup called the built URL with the query', /q=thinset%20mortar%2050%20lb/.test(seenUrl) && /api_key=KEY123/.test(seenUrl));

  // caching: a repeat query does not re-fetch.
  let calls = 0;
  const countingFetch = async () => { calls++; return { ok: true, status: 200, async json() { return { products: [{ price: 10 }] }; }, async text() { return ''; } }; };
  const cached = createHomeDepotProvider({ apiKey: 'K', fetchImpl: countingFetch });
  await cached.lookup({ query: 'same' }); await cached.lookup({ query: 'same' });
  check('live provider caches repeat queries (1 fetch for 2 lookups)', calls === 1);

  // error mapping: 429 -> rate_limited, non-2xx never throws. (retryBackoffMs:1 keeps the test fast.)
  const rl = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, fetchImpl: async () => ({ ok: false, status: 429, async json() { return null; }, async text() { return ''; } }) });
  const rlRes = await rl.lookup({ query: 'x' });
  check('HTTP 429 -> ok:false rate_limited (no throw)', rlRes.ok === false && rlRes.reason === 'rate_limited');

  const boom = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, fetchImpl: async () => { throw new Error('socket hang up'); } });
  const boomRes = await boom.lookup({ query: 'x' });
  check('transport throw -> ok:false network_error (no throw)', boomRes.ok === false && boomRes.reason === 'network_error');

  console.log('\n========================================');
  console.log('RETRY — transient failures are retried (Issue 1: pricing stability)');
  console.log('========================================');

  // A transient failure that clears on a later attempt should still price the line.
  let tries = 0;
  const flaky = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, fetchImpl: async () => {
    tries++;
    if (tries < 3) throw new Error('socket hang up');            // fail twice, then succeed
    return { ok: true, status: 200, async json() { return { products: [{ price: 12.5 }] }; }, async text() { return ''; } };
  } });
  const flakyRes = await flaky.lookup({ query: 'x' });
  check('transient lookup is retried, then succeeds', flakyRes.ok === true && flakyRes.unit_price === 12.5 && tries === 3);

  let tries2 = 0;
  const deadNet = createHomeDepotProvider({ apiKey: 'K', maxRetries: 2, retryBackoffMs: 1, fetchImpl: async () => { tries2++; throw new Error('ECONNRESET'); } });
  const deadRes = await deadNet.lookup({ query: 'x' });
  check('exhausted retries -> network_error after maxRetries+1 attempts', deadRes.ok === false && deadRes.reason === 'network_error' && tries2 === 3);

  let tries3 = 0;
  const noMatchProv = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, fetchImpl: async () => { tries3++; return { ok: true, status: 200, async json() { return { products: [] }; }, async text() { return ''; } }; } });
  await noMatchProv.lookup({ query: 'x' });
  check('a genuine no_match is NOT retried (1 attempt)', tries3 === 1);

  // not_retail_sku: the dumpster line is skipped (no live call) with a distinct reason.
  const dumpTk = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, includeDemolition: true }, ds);
  const dumpPr = await priceTakeoff(dumpTk, { provider: createMockPricingProvider(), dataset: ds, tier: 'better' });
  const dumpLine = dumpPr.unpriced_lines.find(u => u.key === 'demolition_dumpster');
  check('demolition_dumpster -> unpriced with reason not_retail_sku', !!dumpLine && dumpLine.reason === 'not_retail_sku');
  check('  -> priced_count/unpriced_count reported on the pricing block', typeof dumpPr.priced_count === 'number' && typeof dumpPr.unpriced_count === 'number');

  console.log('\n========================================');
  console.log('CIRCUIT BREAKER — fail fast when the provider is down (no hanging)');
  console.log('========================================');

  let breakerCalls = 0;
  const deadProvider = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, maxRetries: 0, breakerThreshold: 3,
    fetchImpl: async () => { breakerCalls++; throw new Error('timeout'); } });
  for (let i = 0; i < 3; i++) await deadProvider.lookup({ query: 'q' + i });   // distinct queries -> 3 real fails -> trip
  const callsAtTrip = breakerCalls;
  const afterTrip = await deadProvider.lookup({ query: 'q-after' });
  check('breaker trips after threshold consecutive fails -> provider_unavailable', afterTrip.ok === false && afterTrip.reason === 'provider_unavailable');
  check('  -> a tripped provider makes NO further fetches (fast fail)', breakerCalls === callsAtTrip);

  // A single flaky line (fails within one lookup) must NOT trip the breaker (threshold > retries).
  let flakyOne = 0;
  const oneFlaky = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, maxRetries: 2, breakerThreshold: 5,
    fetchImpl: async () => { flakyOne++; if (flakyOne < 3) throw new Error('blip'); return { ok: true, status: 200, async json() { return { products: [{ price: 8 }] }; }, async text() { return ''; } }; } });
  const flakyRes2 = await oneFlaky.lookup({ query: 'z' });
  check('one flaky line (retried to success) does not trip the breaker', flakyRes2.ok === true && flakyRes2.unit_price === 8);

  console.log('\n========================================');
  console.log('PERSISTENT PRICE CACHE — scrape a term once, reuse across requests');
  console.log('========================================');

  const shared = new Map();
  let cacheFetches = 0;
  const mkShared = () => createHomeDepotProvider({ apiKey: 'K', sharedCache: shared,
    fetchImpl: async () => { cacheFetches++; return { ok: true, status: 200, async json() { return { products: [{ price: 9.5 }] }; }, async text() { return ''; } }; } });
  const c1 = await mkShared().lookup({ query: 'shared-term' });
  const c2 = await mkShared().lookup({ query: 'shared-term' });   // a DIFFERENT request/instance, same Map
  check('cache: 2nd lookup (new instance) served from cache, only 1 fetch', c1.unit_price === 9.5 && c2.unit_price === 9.5 && cacheFetches === 1);

  let ttlFetches = 0;
  const sharedTtl = new Map();
  const mkTtlProv = () => createHomeDepotProvider({ apiKey: 'K', sharedCache: sharedTtl, cacheTtlMs: -1,
    fetchImpl: async () => { ttlFetches++; return { ok: true, status: 200, async json() { return { products: [{ price: 5 }] }; }, async text() { return ''; } }; } });
  await mkTtlProv().lookup({ query: 't' });   // separate instances (separate requests) so the
  await mkTtlProv().lookup({ query: 't' });   // per-request memo doesn't mask the TTL check
  check('cache honors TTL (ttl -1 -> entry always expired, re-fetch)', ttlFetches === 2);

  const failShared = new Map();
  const failProv = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, maxRetries: 0, sharedCache: failShared,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { products: [] }; }, async text() { return ''; } }) });   // no_match
  await failProv.lookup({ query: 'nope' });
  check('cache does NOT store failures', failShared.size === 0);

  console.log('\n========================================');
  console.log('TOTAL-TIME BUDGET + 200-with-error (Sing Aug-4)');
  console.log('========================================');

  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  // A slow provider so the total-time budget trips: batch 1 prices, the rest come back partial.
  const slowProv = { id: 'slow', source: 'homedepot_live', async lookup({ key, tier: tr }) {
    await sleepMs(40);
    const p = MOCK_UNIT_PRICES[key] && MOCK_UNIT_PRICES[key][tr];
    return p != null ? { ok: true, unit_price: p, currency: 'USD', source: 'homedepot_live' } : { ok: false, reason: 'no_match' };
  } };
  const budgeted = await priceTakeoff(takeoff(), { provider: slowProv, dataset: ds, tier: 'better', maxTotalMs: 30 });
  check('total-time budget returns PARTIAL results (not all lines priced)', budgeted.priced_count > 0 && budgeted.priced_count < takeoff().materials.length);
  check('  -> unpriced lines flagged pricing_timeout', budgeted.unpriced_lines.some(u => u.reason === 'pricing_timeout'));
  check('  -> pricing.timed_out flag set', budgeted.timed_out === true);
  check('  -> never hangs: a generous budget prices everything (no timed_out)',
    (await priceTakeoff(takeoff(), { provider: slowProv, dataset: ds, tier: 'better', maxTotalMs: 60000 })).timed_out === undefined);

  // SerpApi 200-with-error body: HTTP 200 but the JSON says the scrape errored -> TRANSIENT, not
  // a silent no_match (Sing's "200 but no price" case).
  const errBody = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, maxRetries: 0,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { search_metadata: { status: 'Error' }, error: 'timeout scraping home depot' }; }, async text() { return ''; } }) });
  const er = await errBody.lookup({ query: 'x' });
  check('SerpApi 200-with-error body -> transient provider_error (not silent no_match)', er.ok === false && er.reason === 'provider_error');

  let peCalls = 0;
  const peRetry = createHomeDepotProvider({ apiKey: 'K', retryBackoffMs: 1, maxRetries: 2,
    fetchImpl: async () => { peCalls++;
      if (peCalls < 2) return { ok: true, status: 200, async json() { return { search_metadata: { status: 'Error' } }; }, async text() { return ''; } };
      return { ok: true, status: 200, async json() { return { products: [{ price: 11 }] }; }, async text() { return ''; } };
    } });
  const per = await peRetry.lookup({ query: 'x' });
  check('200-with-error is retried (transient), then succeeds', per.ok === true && per.unit_price === 11 && peCalls === 2);

  console.log('\n========================================');
  console.log('PROVIDER SELECTION (mirrors selectStore)');
  console.log('========================================');
  check('HOMEDEPOT_API_KEY set -> live provider', selectPricingProvider({ HOMEDEPOT_API_KEY: 'k' }).provider.id === 'homedepot_live');
  check('PRICING_MOCK=1 (no key) -> mock provider', selectPricingProvider({ PRICING_MOCK: '1' }).provider.id === 'mock');
  check('nothing set -> null provider (pricing unavailable)', selectPricingProvider({}).provider === null);
  check('PRICING_MOCK=0 -> null (not mock)', selectPricingProvider({ PRICING_MOCK: '0' }).provider === null);
  check('PRICING_MOCK=false -> null (not mock)', selectPricingProvider({ PRICING_MOCK: 'false' }).provider === null);
  check('PRICING_MOCK=off -> null (not mock)', selectPricingProvider({ PRICING_MOCK: 'off' }).provider === null);
  check('PRICING_MOCK=true -> mock', selectPricingProvider({ PRICING_MOCK: 'true' }).provider.id === 'mock');
  check('live key wins over PRICING_MOCK=false', selectPricingProvider({ HOMEDEPOT_API_KEY: 'k', PRICING_MOCK: 'false' }).provider.id === 'homedepot_live');

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
