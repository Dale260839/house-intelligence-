/**
 * Material Takeoff — roomShape / measurement-accuracy tests (Phase 2)
 * Verifies the shape-aware wall-perimeter model (square-room stays the fallback,
 * exact wallPerimeterLF still wins) and the island cabinet boost.
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const ds = loadDataset();

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const K = (o) => buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200, ...o }, ds);
const B = (o) => buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60, ...o }, ds);
const sheets = (t) => t.materials.find(m => m.key === 'drywall_sheets').order_qty;

console.log('========================================');
console.log('ROOM SHAPE — wall-perimeter accuracy (kitchen 200 sqft)');
console.log('========================================');

const sq = K();                       // no roomShape -> default 'square'
const sqExplicit = K({ roomShape: 'square' });
check('default (no roomShape) == square: perimeter 56.6', sq.derived.wall_perimeter_lf === 56.6);
check('explicit square identical to default', sqExplicit.derived.wall_perimeter_lf === 56.6 && sheets(sqExplicit) === sheets(sq));
check('square unchanged: 16 drywall sheets, 40 LF cabinets (no regression)', sheets(sq) === 16 && sq.derived.total_cabinet_lf === 40);

const galley = K({ roomShape: 'galley' });
check('galley -> longer perimeter than square', galley.derived.wall_perimeter_lf > sq.derived.wall_perimeter_lf);
check('galley perimeter ~= 4.6*sqrt(200) = 65.1', galley.derived.wall_perimeter_lf === 65.1);
check('galley -> more drywall than square (18 vs 16)', sheets(galley) === 18 && sheets(galley) > sheets(sq));

const uShaped = K({ roomShape: 'u_shaped' });
check('u_shaped -> even more perimeter than galley', uShaped.derived.wall_perimeter_lf > galley.derived.wall_perimeter_lf);

check('shapes are monotonic (square < rectangular <= galley < l_shaped < u_shaped)',
  K({ roomShape: 'square' }).derived.wall_perimeter_lf
    <= K({ roomShape: 'rectangular' }).derived.wall_perimeter_lf
    && K({ roomShape: 'rectangular' }).derived.wall_perimeter_lf
    < K({ roomShape: 'galley' }).derived.wall_perimeter_lf
    && K({ roomShape: 'galley' }).derived.wall_perimeter_lf
    < K({ roomShape: 'l_shaped' }).derived.wall_perimeter_lf
    && K({ roomShape: 'l_shaped' }).derived.wall_perimeter_lf
    < K({ roomShape: 'u_shaped' }).derived.wall_perimeter_lf);

console.log('\n--- island cabinet boost ---');
const island = K({ roomShape: 'island' });
check('island -> +15% cabinet run (40 -> 46 LF)', island.derived.total_cabinet_lf === 46);
check('island base/upper follow the boosted total (27.6 / 18.4)', island.derived.base_cabinet_lf === 27.6 && island.derived.upper_cabinet_lf === 18.4);
check('island does NOT boost cabinets when cabinetLF is provided', K({ roomShape: 'island', cabinetLF: 40 }).derived.total_cabinet_lf === 40);

console.log('\n--- exact measurement always wins ---');
const override = K({ roomShape: 'galley', wallPerimeterLF: 100 });
check('wallPerimeterLF overrides roomShape (perimeter = 100)', override.derived.wall_perimeter_lf === 100);

console.log('\n========================================');
console.log('ROOM SHAPE — bathroom (60 sqft)');
console.log('========================================');
const bSq = B();
const bGalley = B({ roomShape: 'galley' });
check('bathroom default square perimeter = 4*sqrt(60) = 31', bSq.derived.wall_perimeter_lf === 31);
check('bathroom galley -> longer perimeter', bGalley.derived.wall_perimeter_lf > bSq.derived.wall_perimeter_lf);
check('bathroom galley -> larger dry wall area (more drywall)', bGalley.derived.dry_wall_area_sqft > bSq.derived.dry_wall_area_sqft);
check('bathroom wallPerimeterLF overrides roomShape', B({ roomShape: 'u_shaped', wallPerimeterLF: 40 }).derived.wall_perimeter_lf === 40);
check('bathroom has no island shape (rejected)', B({ roomShape: 'island' }).ok === false);

console.log('\n--- validation ---');
check('bad roomShape enum -> ok:false', K({ roomShape: 'hexagon' }).ok === false);
check('roomShape is optional (omitted is fine)', K().ok === true);

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
