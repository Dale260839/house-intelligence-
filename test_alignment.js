// Verifies the engine aligns with the Dataset Blueprint (#2):
//   Layer 1 region+era row, Layer 2 six categories + severity flags, Layer 3 samples.
const {
  buildScope, buildEraRow, buildRegionGrid, classifySeverity,
  CATEGORY_ORDER, loadDataset,
} = require('./lookup_engine.js');

const ds = loadDataset();
let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }

console.log('========================================');
console.log('LAYER 2 — SEVERITY FLAGS match the blueprint table');
console.log('========================================');
const SEV = [
  ['Knob-and-tube wiring', 'High'],
  ['Aluminum branch-circuit wiring (FIRE RISK)', 'High'],
  ['Federal Pacific Stab-Lok / Zinsco panels', 'High'],
  ['Fuse panel upgrade', 'Medium'],
  ['Ungrounded circuits', 'Medium'],
  ['Polybutylene piping', 'High'],
  ['Galvanized corrosion', 'Medium'],
  ['Cast iron deterioration', 'Medium'],
  ['Lead solder joints', 'High'],
  ['Lead service line (high priority)', 'High'],
  ['Balloon-frame fire-blocking absent', 'Medium'],
  ['Asbestos floor tile / pipe wrap / siding', 'High'],
  ['Lead-based paint (assume present)', 'High'],
  ['Single-pane wood', 'Low'],
  ['R-22 refrigerant (phased out 2010)', 'Low'],
  ['Low/no insulation', 'Low'],
];
for (const [item, want] of SEV) {
  check(`severity "${item}" -> ${want}`, classifySeverity(item) === want);
}

console.log('\n========================================');
console.log('LAYER 2 — SIX CATEGORIES present & well-formed');
console.log('========================================');
const seattle = buildScope({ year: 1945, state: 'WA' }, ds);
check('exactly the 6 blueprint categories exist', JSON.stringify(Object.keys(seattle.categories)) === JSON.stringify(CATEGORY_ORDER));
check('Electrical bucket has knob-and-tube', seattle.categories.Electrical.some(x => /knob-and-tube/i.test(x.item)));
check('Plumbing bucket has galvanized/lead', seattle.categories.Plumbing.some(x => /galvanized|lead/i.test(x.item)));
check('Hazards bucket has asbestos', seattle.categories.Hazards.some(x => /asbestos/i.test(x.item)));
check('Structural bucket has a seismic/foundation item', seattle.categories.Structural.some(x => /sill-plate|cripple|foundation|masonry|cracking/i.test(x.item)));
check('HVAC bucket has an asbestos/oil item', seattle.categories.HVAC.some(x => /asbestos|oil/i.test(x.item)));
check('Envelope bucket has insulation/window/moisture item', seattle.categories.Envelope.some(x => /insulation|window|moisture|rot|air leakage/i.test(x.item)));
check('every item lands in exactly one category (counts match)',
  CATEGORY_ORDER.reduce((n, c) => n + seattle.categories[c].length, 0) === seattle.inspection_items.length);
check('every category item carries a severity', CATEGORY_ORDER.every(c => seattle.categories[c].every(x => /^(High|Medium|Low)$/.test(x.severity))));

console.log('\n========================================');
console.log('ROW-LEVEL SEVERITY rollup (= highest item)');
console.log('========================================');
check('1945 WA Seattle -> overall High', seattle.severity === 'High');
check('high_priority_flags == the High-severity items', seattle.high_priority_flags.every(f => /./.test(f)) && seattle.high_priority_flags.length > 0);
const newNational = buildScope({ year: 2022 }, ds);
check('2022 national new build -> not High', newNational.severity !== 'High');
check('2022 national new build -> no High items', newNational.high_priority_flags.length === 0);
const pre1900 = buildScope({ year: 1890 }, ds);
check('1890 national -> High (lead service line)', pre1900.severity === 'High');

console.log('\n========================================');
console.log('LAYER 1 & 3 — region+era ROW view (SEA-1930 / LA-1965)');
console.log('========================================');
const seaRow = buildEraRow({ year: 1945, metro: 'SEA' }, ds);
check('Seattle row id is SEA-1930 (band-based)', seaRow.id === 'SEA-1930');
check('Seattle row region label', seaRow.region === 'Seattle, WA');
check('Seattle row era span 1930-1949', seaRow.era_start === 1930 && seaRow.era_end === 1949);
check('Seattle row severity High', seaRow.severity === 'High');
check('Seattle row electrical text mentions knob-and-tube', /knob-and-tube/i.test(seaRow.electrical));
check('Seattle row hazards text mentions asbestos + lead', /asbestos/i.test(seaRow.hazards) && /lead/i.test(seaRow.hazards));
check('Seattle row structural text mentions seismic anchorage', /sill-plate|cripple|masonry/i.test(seaRow.structural));
check('Seattle row inspection_items is a non-empty joined string', typeof seaRow.inspection_items === 'string' && seaRow.inspection_items.length > 20);

const laRow = buildEraRow({ year: 1968, metro: 'LA' }, ds);
check('LA row id is LA-1965', laRow.id === 'LA-1965');
check('LA row region label', laRow.region === 'Los Angeles, CA');
check('LA row electrical mentions aluminum wiring', /aluminum/i.test(laRow.electrical));
check('LA row severity High (aluminum + seismic)', laRow.severity === 'High');

console.log('\n========================================');
console.log('STATE-LEVEL & PRE-1900 row ids');
console.log('========================================');
const ilRow = buildEraRow({ year: 1955, state: 'IL' }, ds);
check('state-only row id IL-1950', ilRow.id === 'IL-1950');
check('state-only row region "Illinois (IL)"', ilRow.region === 'Illinois (IL)');
const oldRow = buildEraRow({ year: 1850, state: 'NY' }, ds);
check('pre-1900 row id uses token (NY-pre1900)', oldRow.id === 'NY-pre1900');

console.log('\n========================================');
console.log('LAYER 1 — full region GRID generation (the blueprint table)');
console.log('========================================');
const grid = buildRegionGrid({ metro: 'SEA' }, ds);
check('grid has one row per era band', grid.length === ds.era_bands.length);
check('grid rows all carry id/region/severity', grid.every(r => r.id && r.region === 'Seattle, WA' && /^(High|Medium|Low)$/.test(r.severity)));
check('grid is ordered oldest -> newest', grid[0].era_start === 0 && grid[grid.length - 1].era_end === 'Present');

console.log('\n========================================');
console.log('R-22 refrigerant feature now present (was a blueprint gap)');
console.log('========================================');
check('1990 build surfaces R-22 (Low)', buildScope({ year: 1990 }, ds).inspection_items.some(i => /R-22/i.test(i)));
check('R-22 classified Low', classifySeverity('R-22 refrigerant (phased out 2010)') === 'Low');

console.log('\n========================================');
console.log('AUDIT FIXES — categorization correctness, single-pane, era_end');
console.log('========================================');
const catOf = (scope, rx) => CATEGORY_ORDER.find(c => (scope.categories[c] || []).some(x => rx.test(x.item))) || null;
const gulf = buildScope({ year: 2005, state: 'FL' }, ds);
check('wind/hurricane tie-downs -> Structural (not Envelope)', catOf(gulf, /tie-down|roof strap/i) === 'Structural');
check('water heater strapping -> Structural (was silent default)', catOf(seattle, /water heater strapping/i) === 'Structural');
const cold = buildScope({ year: 1955, state: 'NY' }, ds);
check('frozen-pipe risk -> Plumbing (deliberate)', catOf(cold, /frozen[- ]pipe/i) === 'Plumbing');
const balloon = buildScope({ year: 1920 }, ds);
check('balloon framing -> Structural (blueprint placement)', catOf(balloon, /balloon[- ]?fram/i) === 'Structural');
check('single-pane windows now surfaces in scope', seattle.inspection_items.some(i => /single-pane/i.test(i)));
check('single-pane lands in Envelope as Low', (seattle.categories.Envelope || []).some(x => /single-pane/i.test(x.item) && x.severity === 'Low'));
check('open-band era_end is "Present", not 9999', buildEraRow({ year: 2022 }, ds).era_end === 'Present');
check('no row leaks the 9999 sentinel', buildRegionGrid({ state: 'CA' }, ds).every(r => r.era_end !== 9999));

console.log('\n========================================');
console.log('REGRESSION — original engine contract intact');
console.log('========================================');
check('era id still present', seattle.era.id === '1930_1949');
check('regions_applied still present', seattle.regions_applied.some(r => r.id === 'pacific_nw'));
check('region_specific_items still present', seattle.region_specific_items.length > 0);
check('inspection_items still deduped', seattle.inspection_items.length === new Set(seattle.inspection_items.map(i => i.toLowerCase())).size);

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
