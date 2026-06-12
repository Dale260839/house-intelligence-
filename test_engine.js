const { buildScope, renderScopeText, findEra, loadDataset } = require('./lookup_engine.js');
const ds = loadDataset();

let pass=0, fail=0;
function check(name, cond){ console.log((cond?'PASS':'FAIL')+' '+name); cond?pass++:fail++; }

console.log('========================================');
console.log('THE SPEC EXAMPLE: 1940s Seattle house');
console.log('========================================');
const seattle = buildScope({year:1945, state:'WA'}, ds);
console.log(renderScopeText(seattle));
console.log('');
check('1945 -> 1930-1949 era', seattle.era.id==='1930_1949');
check('WA applies pacific_nw region', seattle.regions_applied.some(r=>r.id==='pacific_nw'));
check('WA applies seismic_west region', seattle.regions_applied.some(r=>r.id==='seismic_west'));
check('flags lead paint (pre-1978)', seattle.high_priority_flags.some(f=>/lead-based paint/i.test(f)));
check('flags asbestos', seattle.high_priority_flags.some(f=>/asbestos/i.test(f)));
check('region adds crawlspace/moisture', seattle.region_specific_items.some(f=>/moisture|crawlspace/i.test(f)));
check('region adds seismic item', seattle.region_specific_items.some(f=>/sill-plate|cripple|bolting/i.test(f)));

console.log('\n========================================');
console.log('EDGE: 1968 house (aluminum wiring + FPE window)');
console.log('========================================');
const al = buildScope({year:1968, state:'IL'}, ds);
check('1968 -> 1965-1979 era', al.era.id==='1965_1979');
check('flags ALUMINUM branch wiring', al.high_priority_flags.some(f=>/aluminum branch/i.test(f)));
check('flags Federal Pacific/Zinsco', al.high_priority_flags.some(f=>/federal pacific|zinsco|stab-lok/i.test(f)));
console.log('flags:', al.high_priority_flags.join(' | '));

console.log('\n========================================');
console.log('EDGE: 1985 house (polybutylene era)');
console.log('========================================');
const pb = buildScope({year:1985, state:'TX'}, ds);
check('1985 -> 1980-1999 era', pb.era.id==='1980_1999');
check('flags polybutylene', pb.high_priority_flags.some(f=>/polybutylene/i.test(f)));
check('TX gets gulf_southeast region', pb.regions_applied.some(r=>r.id==='gulf_southeast'));
check('TX gets expansive clay item', pb.region_specific_items.some(f=>/expansive clay|clay soil/i.test(f)));

console.log('\n========================================');
console.log('EDGE: 2005 Gulf house (Chinese drywall window)');
console.log('========================================');
const cd = buildScope({year:2005, state:'FL'}, ds);
check('2005 -> 2000-2009 era', cd.era.id==='2000_2009');
check('flags Chinese/defective drywall', cd.high_priority_flags.some(f=>/chinese.*drywall|defective drywall/i.test(f)));

console.log('\n========================================');
console.log('EDGE: 1890 house (pre-1900)');
console.log('========================================');
const old = buildScope({year:1890, state:'NY'}, ds);
check('1890 -> pre_1900 era', old.era.id==='pre_1900');
check('flags lead service line', old.high_priority_flags.some(f=>/lead service line/i.test(f)));
check('NY gets cold-northeast region', old.regions_applied.some(r=>r.id==='northeast_midwest_cold'));

console.log('\n========================================');
console.log('EDGE: 2022 new build (should be clean)');
console.log('========================================');
const nw = buildScope({year:2022, state:'CA'}, ds);
check('2022 -> 2010_present era', nw.era.id==='2010_present');
check('no legacy hazard flags', !nw.high_priority_flags.some(f=>/lead|asbestos|knob/i.test(f)));
check('CA still gets seismic items', nw.region_specific_items.some(f=>/seismic|bolting|cripple/i.test(f)));

console.log('\n========================================');
console.log('EDGE CASES: bad input');
console.log('========================================');
check('no year -> ok:false', buildScope({state:'WA'}, ds).ok===false);
check('garbage year -> ok:false', buildScope({year:'banana'}, ds).ok===false);
check('year 1300 -> still finds pre_1900', buildScope({year:1300}, ds).era?.id==='pre_1900' || buildScope({year:1300}, ds).ok===false ? true : false);
check('no state -> still works (no regions)', buildScope({year:1955}, ds).ok===true && buildScope({year:1955}, ds).regions_applied.length===0);
check('dedup works (no duplicate items)', (()=>{const s=buildScope({year:1945,state:'WA'},ds); return s.inspection_items.length===new Set(s.inspection_items.map(i=>i.toLowerCase())).size;})());

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail>0?1:0);
