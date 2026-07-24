/**
 * Material Takeoff — optional add-on line groups (Phase 4)
 * Demolition, subfloor, paint, trim and hardware are OFF by default (so they can never
 * change an existing takeoff) and each is switched on by its own include* input.
 * Verified on both project types, plus pricing coverage for the new lines.
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const { priceTakeoff } = require('./pricing_engine.js');
const { createMockPricingProvider } = require('./pricing_provider.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const K = (o) => buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, ...o }, ds);
const B = (o) => buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, ...o }, ds);
const has = (t, key) => t.materials.some(m => m.key === key);
const line = (t, key) => t.materials.find(m => m.key === key);
const ADDONS = ['demolition_dumpster', 'subfloor', 'primer', 'paint', 'baseboard', 'cabinet_hardware'];

(async () => {
  console.log('========================================');
  console.log('DEFAULT OFF — add-ons never change an existing takeoff');
  console.log('========================================');
  const kBase = K(), bBase = B();
  check('kitchen: no add-on lines by default', ADDONS.every(k => !has(kBase, k)));
  check('bathroom: no add-on lines by default', ADDONS.every(k => !has(bBase, k)));
  check('kitchen base line count still 11', kBase.materials.length === 11);
  check('bathroom base line count still 12', bBase.materials.length === 12);

  console.log('\n========================================');
  console.log('EACH GROUP TOGGLES INDEPENDENTLY (kitchen 200 sqft)');
  console.log('========================================');

  // Demolition -> debris volume -> dumpsters
  const demo = line(K({ includeDemolition: true }), 'demolition_dumpster');
  check('includeDemolition -> dumpster line', !!demo && demo.type === 'coverage');
  check('  debris = 200 sqft x 0.08 = 16 cu yd -> 1 dumpster', demo.raw === 16 && demo.order_qty === 1);
  check('  only that group is added', K({ includeDemolition: true }).materials.length === 12);

  // Subfloor -> panels
  const sub = line(K({ includeSubfloor: true }), 'subfloor');
  check('includeSubfloor -> panels (200 +10% /32 = 7 sheets)', sub.order_qty === 7 && sub.order_unit === 'sheet');

  // Paint -> primer + topcoats
  const kp = K({ includePaint: true });
  check('includePaint -> primer AND paint lines', has(kp, 'primer') && has(kp, 'paint'));
  check('  primer 1 coat over 422.5 sqft -> 2 gal', line(kp, 'primer').order_qty === 2);
  check('  paint 2 coats (default) -> 3 gal', line(kp, 'paint').order_qty === 3);
  check('  paintCoats respected (4 coats -> more paint)', line(K({ includePaint: true, paintCoats: 4 }), 'paint').order_qty > line(kp, 'paint').order_qty);
  check('  paint label shows coat count', /2 coats/.test(line(kp, 'paint').label));

  // Trim -> sticks, less door openings
  const trim = line(K({ includeTrim: true }), 'baseboard');
  check('includeTrim -> baseboard sticks (56.6 - 2x3ft, +10%, /16 = 4)', trim.order_qty === 4);
  check('  openings reduce the trim run', line(K({ includeTrim: true, openings: 6 }), 'baseboard').raw < trim.raw);

  // Hardware -> pulls from cabinet LF
  const hw = line(K({ includeHardware: true }), 'cabinet_hardware');
  check('includeHardware -> pulls (40 LF x 0.9 = 36 ea)', hw.order_qty === 36 && hw.order_unit === 'ea');
  check('  scales with cabinet LF', line(K({ includeHardware: true, cabinetLF: 60 }), 'cabinet_hardware').order_qty === 54);

  // All together
  const kAll = K({ includeDemolition: true, includeSubfloor: true, includePaint: true, includeTrim: true, includeHardware: true });
  check('all add-ons on -> 11 + 6 = 17 lines', kAll.materials.length === 17);
  check('  every add-on line present', ADDONS.every(k => has(kAll, k)));
  check('  every add-on line has an auditable basis', ADDONS.every(k => typeof line(kAll, k).basis === 'string' && line(kAll, k).basis.length > 0));

  console.log('\n========================================');
  console.log('BATHROOM add-ons');
  console.log('========================================');
  const bAll = B({ includeDemolition: true, includeSubfloor: true, includePaint: true, includeTrim: true, includeHardware: true, vanityLF: 3 });
  check('bathroom gets all 6 add-on groups too', ADDONS.every(k => has(bAll, k)));
  check('bathroom debris rate is higher (0.12/sqft -> 7.2 cu yd)', line(bAll, 'demolition_dumpster').raw === 7.2);
  check('bathroom paint covers DRY walls only (< total wall area)',
    line(bAll, 'primer').raw < bAll.derived.total_wall_area_sqft);
  check('bathroom hardware derives from vanity LF (3 x 0.9 -> 3 ea)', line(bAll, 'cabinet_hardware').order_qty === 3);
  check('bathroom hardware absent when no vanity', !has(B({ includeHardware: true, includeVanity: false }), 'cabinet_hardware'));

  console.log('\n========================================');
  console.log('PRICING — add-on lines are priceable');
  console.log('========================================');
  const mock = createMockPricingProvider();
  const pr = await priceTakeoff(kAll, { provider: mock, dataset: ds, tier: 'better' });
  check('priced takeoff with add-ons is fully priced', pr.ok === true && pr.fully_priced === true);
  check('  all 17 lines priced', pr.lines.length === 17);
  check('  every add-on line has a cost', ADDONS.every(k => {
    const l = pr.lines.find(x => x.key === k);
    return l && l.line_cost > 0;
  }));
  const prBase = await priceTakeoff(kBase, { provider: mock, dataset: ds, tier: 'better' });
  check('  add-ons increase the material total', pr.profit_layout.materials_cost > prBase.profit_layout.materials_cost);

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
