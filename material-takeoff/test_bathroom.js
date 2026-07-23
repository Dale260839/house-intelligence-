/**
 * Material Takeoff — bathroom_remodel engine tests
 * Same dependency-free harness style as test_engine.js. Verifies the second project
 * type end-to-end: derived geometry, material lines, configurable scope toggles, and
 * the rough-in checklist.
 */
const { buildTakeoff, loadDataset, renderTakeoffText, getProjectTypes } = require('./takeoff_engine.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const line = (t, key) => t.materials.find(m => m.key === key);
const has = (t, key) => !!line(t, key);

console.log('========================================');
console.log('BATHROOM REMODEL — 60 sqft, default full (tub_shower)');
console.log('========================================');
const b = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60 }, ds);
console.log(renderTakeoffText(b));
console.log('');

check('60 sqft bathroom -> ok', b.ok === true);
check('project_type is bathroom_remodel', b.project_type === 'bathroom_remodel');
check('label is Full Bathroom Remodel', b.project_label === 'Full Bathroom Remodel');

// --- default-full scope: expect all the major line groups present ---
check('has floor tile', has(b, 'floor_tile'));
check('has wall tile (surround)', has(b, 'wall_tile'));
check('has thinset', has(b, 'thinset'));
check('has grout', has(b, 'grout'));
check('has waterproofing membrane', has(b, 'waterproofing_membrane'));
check('has cement backer board', has(b, 'cement_backer_board'));
check('has drywall (dry walls)', has(b, 'drywall_sheets'));
check('has vanity + vanity top', has(b, 'vanity') && has(b, 'vanity_top'));

// --- geometry / derived ---
check('floor tile sqft = bathroom sqft (60)', b.derived.floor_tile_sqft === 60);
check('shower wall = tub_shower default (100)', b.derived.shower_wall_sqft === 100);
check('wall tile sqft = surround (100, no wainscot)', b.derived.wall_tile_sqft === 100);
check('tiled substrate = floor 60 + wall 100 = 160', b.derived.tiled_substrate_sqft === 160);
check('dry wall area = total wall - shower wall', b.derived.dry_wall_area_sqft === Math.round((b.derived.total_wall_area_sqft - 100) * 10) / 10);
check('waterproofing sqft = surround 100 + pan 0 (tub_shower)', b.derived.waterproofing_sqft === 100);
check('vanity LF default 3', b.derived.vanity_lf === 3);

// --- line math sanity ---
check('floor tile straight 7% -> order 65 sqft (60 + 7%)', line(b, 'floor_tile').order_qty === 65);
check('vanity is made-to-measure, field-verify', line(b, 'vanity').type === 'made_to_measure' && line(b, 'vanity').field_verify === true);
check('vanity top field-verify', line(b, 'vanity_top').field_verify === true);
check('backer board ordered in whole sheets', line(b, 'cement_backer_board').order_unit === 'sheet' && Number.isInteger(line(b, 'cement_backer_board').order_qty));
check('thinset substrate = 160', line(b, 'thinset').raw === 160);
check('every line has raw + order_qty + basis', b.materials.every(m => m.raw != null && m.order_qty != null && m.basis));

// --- rough-in checklist ---
check('plumbing has toilet + vanity + shower valve', ['Toilet', 'Vanity sink + faucet'].every(it => b.fixtures_checklist.plumbing.some(f => f.item === it)) && b.fixtures_checklist.plumbing.some(f => /valve/i.test(f.item)));
check('electrical has exhaust fan + GFCI + Romex(est)', b.fixtures_checklist.electrical.some(f => /Exhaust/.test(f.item)) && b.fixtures_checklist.electrical.some(f => /GFCI/.test(f.item)) && b.fixtures_checklist.electrical.some(f => f.estimate));
check('field_verify_items includes vanity + vanity_top', b.field_verify_items.includes('vanity') && b.field_verify_items.includes('vanity_top'));

console.log('\n========================================');
console.log('CONFIGURABLE SCOPE (toggles drop line groups)');
console.log('========================================');

const noShower = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, showerType: 'none' }, ds);
check('showerType:none drops wall tile', !has(noShower, 'wall_tile'));
check('showerType:none drops waterproofing', !has(noShower, 'waterproofing_membrane'));
check('showerType:none drops backer board', !has(noShower, 'cement_backer_board'));
check('showerType:none keeps floor tile', has(noShower, 'floor_tile'));
check('showerType:none -> shower_wall_sqft 0', noShower.derived.shower_wall_sqft === 0);

const noVanity = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, includeVanity: false }, ds);
check('includeVanity:false drops vanity + top', !has(noVanity, 'vanity') && !has(noVanity, 'vanity_top'));

const noFloor = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, floorTile: false }, ds);
check('floorTile:false drops floor tile', !has(noFloor, 'floor_tile'));
check('floorTile:false -> thinset covers wall only (100)', line(noFloor, 'thinset').raw === 100);

const noWp = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, includeWaterproofing: false }, ds);
check('includeWaterproofing:false drops membrane (keeps tile + backer)', !has(noWp, 'waterproofing_membrane') && has(noWp, 'wall_tile') && has(noWp, 'cement_backer_board'));

const walkIn = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, showerType: 'shower' }, ds);
check('walk-in shower -> larger surround (120)', walkIn.derived.shower_wall_sqft === 120);
check('walk-in shower -> waterproofing includes pan (120 + 12 = 132)', walkIn.derived.waterproofing_sqft === 132);

const wainscot = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, wainscotHeight: 36 }, ds);
check('wainscot adds wall tile beyond surround', wainscot.derived.wall_tile_sqft > 100);

const veined = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, vanityTopType: 'veined' }, ds);
check('veined vanity top -> +25% waste', line(veined, 'vanity_top').waste_pct === 25);

console.log('\n========================================');
console.log('VALIDATION + PROJECT-TYPES CONTRACT');
console.log('========================================');
check('missing bathroomSqft -> ok:false invalid_input', buildTakeoff({ projectType: 'bathroom_remodel' }, ds).error === 'invalid_input');
check('bad showerType enum -> ok:false', buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, showerType: 'jacuzzi' }, ds).ok === false);
const bt = getProjectTypes(ds).find(t => t.id === 'bathroom_remodel');
check('project-types lists bathroom_remodel', !!bt);
check('  -> bathroomSqft required', bt.required_inputs.some(i => i.name === 'bathroomSqft'));
check('  -> showerType enum exposed', bt.optional_inputs.find(i => i.name === 'showerType').allowed.length === 4);

// kitchen still works unchanged (dispatch didn't break it)
const k = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200 }, ds);
check('kitchen still builds (dispatch intact): 40 LF cabinets', k.derived.total_cabinet_lf === 40);

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
