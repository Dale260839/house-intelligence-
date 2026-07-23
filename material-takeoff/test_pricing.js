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
  parsePrice, extractProduct, buildSearchUrl, MOCK_UNIT_PRICES,
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

  // A provider that never matches -> every line unpriced, materials_cost 0, but ok:true.
  const emptyProvider = { id: 'empty', source: 'empty', async lookup() { return { ok: false, reason: 'no_match' }; } };
  const allUnpriced = await priceTakeoff(takeoff(), { provider: emptyProvider, dataset: ds });
  check('all-miss provider -> ok:true but fully_priced:false', allUnpriced.ok === true && allUnpriced.fully_priced === false);
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
  check('extractProduct normalizes apionline -> www.homedepot.com', extractProduct({ products: [{ title: 'T', price: 5, link: 'https://apionline.homedepot.com/p/x/123' }] }).url === 'https://www.homedepot.com/p/x/123');

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

  // error mapping: 429 -> rate_limited, non-2xx never throws.
  const rl = createHomeDepotProvider({ apiKey: 'K', fetchImpl: async () => ({ ok: false, status: 429, async json() { return null; }, async text() { return ''; } }) });
  const rlRes = await rl.lookup({ query: 'x' });
  check('HTTP 429 -> ok:false rate_limited (no throw)', rlRes.ok === false && rlRes.reason === 'rate_limited');

  const boom = createHomeDepotProvider({ apiKey: 'K', fetchImpl: async () => { throw new Error('socket hang up'); } });
  const boomRes = await boom.lookup({ query: 'x' });
  check('transport throw -> ok:false network_error (no throw)', boomRes.ok === false && boomRes.reason === 'network_error');

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
