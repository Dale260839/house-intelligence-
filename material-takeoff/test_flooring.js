/**
 * Material Takeoff — flooring_only project type (Phase 5)
 * A third project type built entirely on the pluggable-builder architecture: what gets
 * ordered is driven by `flooringType` (tile vs floating vs nail-down), plus transitions
 * and the shared optional add-ons. No plumbing/electrical rough-in.
 */
const { buildTakeoff, loadDataset, getProjectTypes } = require('./takeoff_engine.js');
const { priceTakeoff } = require('./pricing_engine.js');
const { createMockPricingProvider } = require('./pricing_provider.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const F = (o) => buildTakeoff({ projectType: 'flooring_only', floorSqft: 400, ...o }, ds);
const keys = t => t.materials.map(m => m.key);
const line = (t, k) => t.materials.find(m => m.key === k);
const has = (t, k) => t.materials.some(m => m.key === k);

(async () => {
  console.log('========================================');
  console.log('FLOORING ONLY — registered as a third project type');
  console.log('========================================');
  const types = getProjectTypes(ds);
  check('3 project types now', types.length === 3);
  check('flooring_only is listed', types.some(t => t.id === 'flooring_only'));
  check('floorSqft is the required input', types.find(t => t.id === 'flooring_only').required_inputs[0].name === 'floorSqft');
  check('missing floorSqft -> ok:false', buildTakeoff({ projectType: 'flooring_only' }, ds).ok === false);

  console.log('\n========================================');
  console.log('MATERIALS BY FLOORING TYPE (400 sqft, straight)');
  console.log('========================================');

  // tile -> backer board + thinset + grout
  const tile = F({ flooringType: 'tile' });
  check('tile -> flooring_tile line', has(tile, 'flooring_tile'));
  check('tile -> cement backer board, thinset AND grout', has(tile, 'cement_backer_board') && has(tile, 'thinset') && has(tile, 'grout'));
  check('tile -> NO foam underlayment / fasteners', !has(tile, 'underlayment') && !has(tile, 'fasteners'));
  check('  flooring 400 +7% = 428 sqft', line(tile, 'flooring_tile').order_qty === 428);
  check('  backer 400 +10% /15 = 30 sheets', line(tile, 'cement_backer_board').order_qty === 30);
  check('  thinset ceil(400/75) = 6 bags', line(tile, 'thinset').order_qty === 6);
  check('  grout ceil(400/100) = 4 bags', line(tile, 'grout').order_qty === 4);

  // floating (lvp / laminate) -> underlayment only
  for (const t of ['lvp', 'laminate']) {
    const f = F({ flooringType: t });
    check(`${t} -> underlayment only (no thinset/grout/fasteners)`,
      has(f, 'underlayment') && !has(f, 'thinset') && !has(f, 'grout') && !has(f, 'fasteners'));
    check(`  ${t} underlayment 400 +5% /100 = 5 rolls`, line(f, 'underlayment').order_qty === 5);
  }

  // nail-down (engineered / hardwood) -> underlayment + fasteners
  for (const t of ['engineered', 'hardwood']) {
    const f = F({ flooringType: t });
    check(`${t} -> underlayment + fasteners`, has(f, 'underlayment') && has(f, 'fasteners'));
    check(`  ${t} fasteners ceil(400/500) = 1 box`, line(f, 'fasteners').order_qty === 1);
    check(`  ${t} no tile setting materials`, !has(f, 'thinset') && !has(f, 'grout'));
  }

  check('per-type line key drives pricing search (flooring_hardwood)', has(F({ flooringType: 'hardwood' }), 'flooring_hardwood'));
  check('default type is lvp', has(F(), 'flooring_lvp'));

  console.log('\n========================================');
  console.log('LAYOUT WASTE · PACK ROUNDING · TOGGLES');
  console.log('========================================');
  check('straight = 7% waste', line(F(), 'flooring_lvp').waste_pct === 7);
  check('herringbone = 20% waste (more material)', line(F({ tileLayout: 'herringbone' }), 'flooring_lvp').waste_pct === 20);
  check('  herringbone orders more than straight',
    line(F({ tileLayout: 'herringbone' }), 'flooring_lvp').order_qty > line(F(), 'flooring_lvp').order_qty);
  check('mosaic tile -> grout small-tile coverage (50)', line(F({ flooringType: 'tile', tileLayout: 'mosaic' }), 'grout').coverage === 50);

  const packed = line(F({ flooringBoxSqft: 15.5 }), 'flooring_lvp');
  check('flooringBoxSqft -> pack_round in boxes', packed.type === 'pack_round' && packed.order_unit === 'box');
  check('  ceil(428/15.5) = 28 boxes', packed.order_qty === 28 && packed.covered_qty === 428);
  check('no box size -> stays sqft', line(F(), 'flooring_lvp').type === 'waste_factor');

  check('includeUnderlayment:false drops it', !has(F({ includeUnderlayment: false }), 'underlayment'));
  check('transitions default on = 1 per opening (2)', line(F(), 'transitions').order_qty === 2);
  check('openings:5 -> 5 transitions', line(F({ openings: 5 }), 'transitions').order_qty === 5);
  check('includeTransitions:false drops them', !has(F({ includeTransitions: false }), 'transitions'));
  check('openings:0 -> no transitions', !has(F({ openings: 0 }), 'transitions'));

  console.log('\n========================================');
  console.log('ADD-ONS + no rough-in checklist');
  console.log('========================================');
  const add = F({ includeDemolition: true, includeSubfloor: true, includeTrim: true });
  check('demolition/subfloor/trim add-ons work', has(add, 'demolition_dumpster') && has(add, 'subfloor') && has(add, 'baseboard'));
  check('  flooring debris rate 0.03 -> 12 cu yd -> 1 dumpster', line(add, 'demolition_dumpster').raw === 12 && line(add, 'demolition_dumpster').order_qty === 1);
  check('  baseboard: perim 80 - 2x3ft, +10%, /16 = 6 sticks', line(add, 'baseboard').order_qty === 6);
  check('add-ons off by default', !has(F(), 'demolition_dumpster') && !has(F(), 'baseboard'));
  check('paint/hardware are not applicable to flooring', !has(add, 'paint') && !has(add, 'primer') && !has(add, 'cabinet_hardware'));
  check('empty rough-in checklist (no plumbing/electrical)',
    F().fixtures_checklist.plumbing.length === 0 && F().fixtures_checklist.electrical.length === 0);
  check('summary says so', /No plumbing\/electrical rough-in/.test(F().summary));

  console.log('\n--- room shape only affects the trim add-on ---');
  check('galley -> longer perimeter', F({ roomShape: 'galley' }).derived.wall_perimeter_lf > F().derived.wall_perimeter_lf);
  check('  -> more baseboard', line(F({ roomShape: 'galley', includeTrim: true }), 'baseboard').order_qty >= line(add, 'baseboard').order_qty);
  check('  but flooring qty is unchanged by shape', line(F({ roomShape: 'galley' }), 'flooring_lvp').order_qty === line(F(), 'flooring_lvp').order_qty);

  console.log('\n========================================');
  console.log('PRICING');
  console.log('========================================');
  const mock = createMockPricingProvider();
  for (const t of ['tile', 'lvp', 'hardwood']) {
    const tk = F({ flooringType: t, includeDemolition: true, includeTrim: true });
    const pr = await priceTakeoff(tk, { provider: mock, dataset: ds, tier: 'better' });
    check(`${t} takeoff fully priced (${pr.lines.length} lines)`, pr.ok === true && pr.fully_priced === true);
  }
  const pr = await priceTakeoff(F(), { provider: mock, dataset: ds });
  check('flooring labor default is 60% of materials (not 100%)', pr.labor.pct_of_materials === 60);
  check('  profit layout computes', pr.profit_layout.price > pr.profit_layout.total_cost && pr.profit_layout.margin_pct > 0);

  console.log('\n--- validation ---');
  check('bad flooringType -> ok:false', F({ flooringType: 'carpet' }).ok === false);
  check('bad layout -> ok:false', F({ tileLayout: 'spiral' }).ok === false);
  check('negative floorSqft -> ok:false', buildTakeoff({ projectType: 'flooring_only', floorSqft: -5 }, ds).ok === false);

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
