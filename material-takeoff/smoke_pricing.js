/**
 * Material Takeoff — live pricing smoke test
 * ------------------------------------------
 * A one-shot tool to VERIFY the Home Depot pricing path end-to-end against a real
 * third-party API before trusting it in BuildSuite. It builds a takeoff, prices it
 * with the env-selected provider, and prints — per material line — the search term
 * sent, the unit price the parser extracted, the product it matched, and the profit
 * layout. This is the "confirm the live response shape" step for pricing (the same
 * discipline the project applies to the RentCast address adapter).
 *
 * Usage:
 *   HOMEDEPOT_API_KEY=... node smoke_pricing.js [kitchenSqft] [tier]     # LIVE
 *   HOMEDEPOT_API_KEY=... HOMEDEPOT_API_URL='https://api.bigboxapi.com/request?api_key={key}&type=search&search_term={query}' \
 *     node smoke_pricing.js 200 better                                   # LIVE (BigBox)
 *   PRICING_MOCK=1 node smoke_pricing.js                                 # DEV (no key/network)
 *
 * Exits 0 on a clean run (even with no provider — it just tells you what to set),
 * 1 only if pricing was attempted but every line failed to price (a real red flag).
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const { priceTakeoff } = require('./pricing_engine.js');
const { selectPricingProvider } = require('./pricing_provider.js');

const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

(async () => {
  const sqft = Number(process.argv[2]) || 200;
  const tier = process.argv[3] || 'better';
  const ds = loadDataset();

  const { provider, label } = selectPricingProvider(process.env);
  console.log('Material Takeoff — pricing smoke test');
  console.log('Provider: ' + label);
  console.log(`Takeoff:  kitchen_remodel, ${sqft} sqft, tier "${tier}"`);
  console.log('─'.repeat(72));

  if (!provider) {
    console.log('No pricing provider selected — nothing to verify.');
    console.log('Set HOMEDEPOT_API_KEY to test the LIVE Home Depot API, or PRICING_MOCK=1 for a dry run.');
    process.exit(0);
  }

  const takeoff = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: sqft }, ds);
  if (!takeoff.ok) { console.error('Takeoff failed:', takeoff.message); process.exit(1); }

  const t0 = process.hrtime.bigint();
  const pricing = await priceTakeoff(takeoff, { provider, dataset: ds, tier });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (!pricing.ok) {
    console.error('Pricing failed:', pricing.reason, '-', pricing.message || '');
    process.exit(1);
  }

  console.log(pad('LINE', 20) + pad('UNIT PRICE', 12) + pad('LINE COST', 12) + 'MATCHED PRODUCT');
  console.log('─'.repeat(72));
  for (const l of pricing.lines) {
    console.log(pad(l.key, 20) + pad(money(l.unit_price) + '/' + l.price_unit, 12)
      + pad(money(l.line_cost), 12) + (l.product_title || '(no title)'));
  }
  for (const u of pricing.unpriced_lines) {
    console.log(pad(u.key, 20) + pad('—', 12) + pad('NOT PRICED', 12) + '(' + u.reason + (u.query ? ': "' + u.query + '"' : '') + ')');
  }

  const g = pricing.profit_layout;
  console.log('─'.repeat(72));
  console.log(`Priced ${pricing.lines.length}/${pricing.lines.length + pricing.unpriced_lines.length} lines`
    + ` via ${pricing.source} in ${ms.toFixed(0)} ms`);
  console.log(`Materials ${money(g.materials_cost)}  +Labor ${money(g.labor_cost)}`
    + `  = Cost ${money(g.total_cost)}  +${g.markup_pct}% = Price ${money(g.price)}`
    + `  (Profit ${money(g.profit)}, ${g.margin_pct}% margin)`);

  // A live run where NOTHING priced means the API shape/queries need attention.
  if (pricing.source !== 'mock' && pricing.lines.length === 0) {
    console.error('\n⚠  LIVE run priced 0 lines — check the API response shape / search terms.');
    process.exit(1);
  }
  if (pricing.unpriced_lines.length) {
    console.log(`\nNote: ${pricing.unpriced_lines.length} line(s) did not match — inspect the reasons above.`);
  }
  process.exit(0);
})();
