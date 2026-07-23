/**
 * Material Takeoff — engine tests
 * Same dependency-free harness style as House Intelligence's test_engine.js.
 * Leads with Dale's canonical example: "Full kitchen remodel — 200 sq ft."
 */
const { buildTakeoff, getProjectTypes, renderTakeoffText, loadDataset } = require('./takeoff_engine.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const line = (t, key) => t.materials.find(m => m.key === key);

console.log('========================================');
console.log('THE CANONICAL EXAMPLE: Full kitchen remodel — 200 sq ft');
console.log('========================================');
const k = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200 }, ds);
console.log(renderTakeoffText(k));
console.log('');

check('200 sqft -> ok', k.ok === true);

// --- Cabinets: calibrated 35-45 LF total, ~60% base / ~40% upper, made-to-measure ---
check('total cabinet LF in 35-45 band (not ~20)', k.derived.total_cabinet_lf >= 35 && k.derived.total_cabinet_lf <= 45);
check('  -> 40 LF total at 200 sqft', k.derived.total_cabinet_lf === 40);
check('base ~= 60% (24 LF)', k.derived.base_cabinet_lf === 24);
check('upper ~= 40% (16 LF)', k.derived.upper_cabinet_lf === 16);
check('cabinets carry NO waste factor', line(k, 'base_cabinets').waste_pct === 0 && line(k, 'upper_cabinets').waste_pct === 0);
check('cabinets flagged field-verify (made-to-measure)', line(k, 'base_cabinets').field_verify === true);
check('100 sqft / 10x10 kitchen ~= 20 LF total', buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 100 }, ds).derived.total_cabinet_lf === 20);
// Larger kitchens must NOT be under-counted (scales with floor area, not perimeter).
check('300 sqft kitchen scales up (~60 LF, not ~24)', buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 300 }, ds).derived.total_cabinet_lf === 60);

// --- Countertop: ~1.0 sqft per base LF, +15% solid / +25% veined, field-verify ---
check('countertop finished = base LF (24 sqft)', k.derived.countertop_finished_sqft === 24);
check('countertop solid +15% -> order 28 sqft', line(k, 'countertop').waste_pct === 15 && line(k, 'countertop').order_qty === 28);
check('countertop flagged field-verify', line(k, 'countertop').field_verify === true);
const veined = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, countertopType: 'veined' }, ds);
check('veined countertop -> +25%', line(veined, 'countertop').waste_pct === 25);

// --- Thinset: ~75 sqft/bag (NOT 90+), conservative so it never falls short ---
check('thinset coverage = 75 sqft/bag (not 90+)', line(k, 'thinset').coverage === 75);
check('thinset coverage <= 80 (no under-ordering)', line(k, 'thinset').coverage <= 80);
check('thinset substrate = backsplash 36 + floor 200 = 236', line(k, 'thinset').raw === 236);
check('thinset -> 4 bags (ceil 236/75)', line(k, 'thinset').order_qty === 4);

// --- Grout: ~100 sqft/bag standard; mosaic uses more ---
check('grout coverage = 100 sqft/bag standard', line(k, 'grout').coverage === 100);
check('grout -> 3 bags (ceil 236/100)', line(k, 'grout').order_qty === 3);
const mosaic = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, tileLayout: 'mosaic' }, ds);
check('mosaic drops grout coverage to 50 sqft/bag', line(mosaic, 'grout').coverage === 50);
check('mosaic layout -> 20% tile waste', line(mosaic, 'floor_tile').waste_pct === 20);

// --- Tile waste by layout ---
check('straight-lay tile waste = 7%', line(k, 'floor_tile').waste_pct === 7);
check('diagonal tile waste = 15%', line(buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, tileLayout: 'diagonal' }, ds), 'floor_tile').waste_pct === 15);
check('herringbone tile waste = 20%', line(buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, tileLayout: 'herringbone' }, ds), 'floor_tile').waste_pct === 20);
check('floor tile 200 +7% -> order 214 sqft', line(k, 'floor_tile').order_qty === 214);

// --- floorTile:false drops floor tile and shrinks thinset/grout ---
const noFloor = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, floorTile: false }, ds);
check('floorTile:false removes floor_tile line', line(noFloor, 'floor_tile') === undefined);
check('floorTile:false -> thinset substrate = backsplash only (36)', line(noFloor, 'thinset').raw === 36);

// --- Drywall: 32 sqft/sheet, 15% kitchen waste ---
check('drywall sheet = 32 sqft / 15% kitchen waste', line(k, 'drywall_sheets').waste_pct === 15);
check('drywall wall area derived (perimeter*h - openings)', k.derived.wall_area_sqft > 400 && k.derived.wall_area_sqft < 460);
check('drywall -> 16 sheets', line(k, 'drywall_sheets').order_qty === 16);
check('joint compound line present (~30 lb/100sqft)', !!line(k, 'joint_compound'));
check('drywall tape line present', !!line(k, 'drywall_tape'));
check('drywall screws line present', !!line(k, 'drywall_screws'));

// --- Every material line shows the auditable math (raw + waste/coverage + order) ---
check('every line has raw + order_qty', k.materials.every(m => m.raw != null && m.order_qty != null));
check('every line has a basis (shows the math)', k.materials.every(m => typeof m.basis === 'string' && m.basis.length > 0));

// --- Fixtures / rough-in checklist ---
check('plumbing checklist has sink, faucet, P-trap, disposal',
  ['Kitchen sink', 'Kitchen faucet', 'P-trap assembly', 'Garbage disposal'].every(it => k.fixtures_checklist.plumbing.some(f => f.item === it)));
check('electrical has GFCI receptacles scaled to counter (6 for 24 base LF)',
  k.fixtures_checklist.electrical.find(f => /GFCI/.test(f.item)).qty === 6);
check('electrical has range circuit + dedicated appliance circuits + romex',
  k.fixtures_checklist.electrical.some(f => /Range/.test(f.item)) &&
  k.fixtures_checklist.electrical.some(f => /Dedicated/.test(f.item)) &&
  k.fixtures_checklist.electrical.some(f => /Romex/.test(f.item)));
check('under-cabinet lighting LF = upper LF (16)',
  k.fixtures_checklist.electrical.find(f => /Under-cabinet/.test(f.item)).qty === 16);

// --- Disclaimer + provenance present ---
check('output carries the field-measurement disclaimer', /field measurement/i.test(k.disclaimer));
check('field_verify_items lists cabinets + countertop', k.field_verify_items.includes('base_cabinets') && k.field_verify_items.includes('countertop'));

console.log('\n========================================');
console.log('KNOWN-MEASUREMENT OVERRIDES (optional inputs win over derivation)');
console.log('========================================');
const known = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, cabinetLF: 50, countertopSqft: 60 }, ds);
check('known cabinetLF=50 overrides derivation', known.derived.total_cabinet_lf === 50);
check('  -> base 30 / upper 20 (60/40 split of provided)', known.derived.base_cabinet_lf === 30 && known.derived.upper_cabinet_lf === 20);
check('known countertopSqft=60 overrides derivation', line(known, 'countertop').raw === 60);
const known2 = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, baseCabinetLF: 28, upperCabinetLF: 14 }, ds);
check('explicit base/upper LF honored', known2.derived.base_cabinet_lf === 28 && known2.derived.upper_cabinet_lf === 14);

console.log('\n========================================');
console.log('PROJECT TYPES CONTRACT (drives the dynamic form)');
console.log('========================================');
const types = getProjectTypes(ds);
check('two project types (kitchen + bathroom)', types.length === 2);
check('kitchen_remodel present', types.some(t => t.id === 'kitchen_remodel'));
check('bathroom_remodel present', types.some(t => t.id === 'bathroom_remodel'));
check('it is kitchen_remodel (first)', types[0].id === 'kitchen_remodel');
check('kitchenSqft is required', types[0].required_inputs.some(i => i.name === 'kitchenSqft'));
check('optional inputs expose type + default', types[0].optional_inputs.every(i => i.type && 'default' in i));
check('tileLayout exposes allowed enum values', types[0].optional_inputs.find(i => i.name === 'tileLayout').allowed.length === 4);

console.log('\n========================================');
console.log('EDGE CASES: bad / missing input (return ok:false)');
console.log('========================================');
check('no projectType -> ok:false', buildTakeoff({ kitchenSqft: 200 }, ds).ok === false);
check('unknown projectType -> ok:false', buildTakeoff({ projectType: 'bathroom', kitchenSqft: 200 }, ds).ok === false);
check('missing kitchenSqft -> ok:false invalid_input', buildTakeoff({ projectType: 'kitchen_remodel' }, ds).error === 'invalid_input');
check('non-numeric kitchenSqft -> ok:false', buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 'banana' }, ds).ok === false);
check('zero/negative kitchenSqft -> ok:false', buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: -5 }, ds).ok === false);
check('bad enum tileLayout -> ok:false', buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, tileLayout: 'spiral' }, ds).ok === false);
check('bad input message names the field', /kitchenSqft/i.test(buildTakeoff({ projectType: 'kitchen_remodel' }, ds).message));

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
