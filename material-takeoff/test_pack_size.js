/**
 * Material Takeoff — pack-size rounding + per-surface tile layout tests (Phase 3)
 * Tile/countertop can round to whole vendor packs (boxes/slabs) when the pack size is
 * known, and floor vs wall/backsplash tile can use different layouts. Backward-compatible:
 * without a box/slab size, lines stay in sqft; without a per-surface layout, tileLayout wins.
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const { priceTakeoff } = require('./pricing_engine.js');
const { createMockPricingProvider } = require('./pricing_provider.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const round2 = n => Math.round(n * 100) / 100;
const K = (o) => buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, ...o }, ds);
const B = (o) => buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, ...o }, ds);
const line = (t, key) => t.materials.find(m => m.key === key);

(async () => {
  console.log('========================================');
  console.log('PACK-SIZE ROUNDING — tile -> boxes, countertop -> slabs (kitchen)');
  console.log('========================================');

  // Backward compat: no box size -> tile stays a sqft waste_factor line.
  const flNoPack = line(K(), 'floor_tile');
  check('no box size -> floor tile stays waste_factor in sqft', flNoPack.type === 'waste_factor' && flNoPack.order_unit === 'sqft');

  // With box coverage -> pack_round line ordered in whole boxes.
  const fl = line(K({ floorTileBoxSqft: 15.5 }), 'floor_tile');
  check('floorTileBoxSqft -> pack_round line, ordered in boxes', fl.type === 'pack_round' && fl.order_unit === 'box');
  check('  covered_qty == the sqft order it replaces (214)', fl.covered_qty === flNoPack.order_qty);
  check('  pack_size recorded (15.5 sqft/box)', fl.pack_size === 15.5 && fl.pack_unit === 'box');
  check('  boxes = ceil(covered / box size) = ceil(214/15.5) = 14', fl.order_qty === Math.ceil(fl.covered_qty / 15.5) && fl.order_qty === 14);
  check('  raw sqft still reported (auditable)', fl.raw === 200);

  // Backsplash tile boxes are independent of floor tile boxes.
  const bs = line(K({ backsplashTileBoxSqft: 10 }), 'backsplash_tile');
  check('backsplashTileBoxSqft -> backsplash in boxes', bs.type === 'pack_round' && bs.order_unit === 'box');
  check('  floor tile unaffected when only backsplash box given', line(K({ backsplashTileBoxSqft: 10 }), 'floor_tile').type === 'waste_factor');

  // Countertop -> slabs.
  const ct = line(K({ countertopSlabSqft: 50 }), 'countertop');
  check('countertopSlabSqft -> countertop ordered in whole slabs', ct.type === 'pack_round' && ct.order_unit === 'slab');
  check('  slabs = ceil(covered / slab size)', ct.order_qty === Math.ceil(ct.covered_qty / 50) && ct.order_qty === 1);

  console.log('\n========================================');
  console.log('PER-SURFACE TILE LAYOUT (kitchen)');
  console.log('========================================');
  const ps = K({ floorTileLayout: 'mosaic', backsplashTileLayout: 'straight' });
  check('floor + backsplash can use DIFFERENT layouts (mosaic 20% / straight 7%)',
    line(ps, 'floor_tile').waste_pct === 20 && line(ps, 'backsplash_tile').waste_pct === 7);
  check('per-surface falls back to tileLayout when omitted (diagonal 15%)',
    line(K({ tileLayout: 'diagonal' }), 'floor_tile').waste_pct === 15 && line(K({ tileLayout: 'diagonal' }), 'backsplash_tile').waste_pct === 15);
  check('mosaic on EITHER surface -> grout small-tile coverage (50)',
    line(K({ floorTileLayout: 'mosaic' }), 'grout').coverage === 50);
  check('no mosaic -> standard grout coverage (100)', line(K(), 'grout').coverage === 100);

  console.log('\n========================================');
  console.log('BATHROOM — pack rounding + per-surface layout');
  console.log('========================================');
  const bPack = B({ floorTileBoxSqft: 10, wallTileBoxSqft: 12 });
  check('bathroom floor tile -> boxes', line(bPack, 'floor_tile').type === 'pack_round' && line(bPack, 'floor_tile').order_unit === 'box');
  check('bathroom wall tile -> boxes', line(bPack, 'wall_tile').type === 'pack_round' && line(bPack, 'wall_tile').order_unit === 'box');
  const bSlab = line(B({ vanityLF: 3, vanityTopSlabSqft: 30 }), 'vanity_top');
  check('bathroom vanity top -> slabs', bSlab.type === 'pack_round' && bSlab.order_unit === 'slab' && bSlab.order_qty >= 1);
  check('bathroom per-surface layout (floor herringbone 20%)', line(B({ floorTileLayout: 'herringbone' }), 'floor_tile').waste_pct === 20);
  check('bathroom no box size -> tile stays sqft', line(B(), 'floor_tile').type === 'waste_factor' && line(B(), 'floor_tile').order_unit === 'sqft');

  console.log('\n========================================');
  console.log('PRICING — boxed tile is priced PER BOX (fixes per-case inflation)');
  console.log('========================================');
  const mock = createMockPricingProvider();
  const tkBoxed = K({ floorTileBoxSqft: 15.5 });
  const pr = await priceTakeoff(tkBoxed, { provider: mock, dataset: ds, tier: 'better' });
  const flPriced = pr.lines.find(l => l.key === 'floor_tile');
  check('boxed floor tile priced per BOX (price_unit=box)', flPriced.price_unit === 'box');
  check('  line_cost = unit_price x boxes (not x sqft)', flPriced.line_cost === round2(flPriced.unit_price * flPriced.order_qty));
  check('  order_qty is the box count, not sqft', flPriced.order_qty === line(tkBoxed, 'floor_tile').order_qty && flPriced.order_qty < 50);
  // Sanity: unpacked tile prices per sqft (the old, inflated basis) -> confirms the difference.
  const prSqft = await priceTakeoff(K(), { provider: mock, dataset: ds, tier: 'better' });
  const flSqft = prSqft.lines.find(l => l.key === 'floor_tile');
  check('unpacked floor tile still priced per sqft (order_qty = 214)', flSqft.order_qty === 214 && flPriced.line_cost < flSqft.line_cost);

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
