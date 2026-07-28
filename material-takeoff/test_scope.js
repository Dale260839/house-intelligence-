/**
 * Material Takeoff — multi-section scope tests (U1) + v2 line fields (U2)
 * Same dependency-free harness as the other test files. Uses the deterministic mock
 * pricing provider (no key, no network).
 */
const { buildTakeoff, loadDataset } = require('./takeoff_engine.js');
const { buildScopeTakeoff, addOnsToToggles, slugify } = require('./scope_engine.js');
const { priceTakeoff, priceScopeTakeoff } = require('./pricing_engine.js');
const { createMockPricingProvider, MOCK_UNIT_PRICES } = require('./pricing_provider.js');

const ds = loadDataset();
let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }
const approx = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const hasKey = (mats, key) => mats.some(m => m.key === key);
const bySection = (mats, sid) => mats.filter(m => m.section_id === sid);

(async () => {
  console.log('========================================');
  console.log('U2 — source_type + section_id on the SINGLE endpoint (unchanged behaviour + new fields)');
  console.log('========================================');

  const k = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: 200 }, ds);
  check('manual takeoff carries source_type "manual"', k.source_type === 'manual');
  check('every material line stamped with a default section_id', k.materials.every(m => m.section_id === 'section-1'));
  check('field_verify_items still derived (regression)', Array.isArray(k.field_verify_items) && k.field_verify_items.length > 0);

  const mock = createMockPricingProvider();
  const kp = await priceTakeoff(k, { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('manual pricing lines now carry section_id', kp.lines.every(l => l.section_id === 'section-1'));
  check('manual pricing lines now carry price_source = mock', kp.lines.every(l => l.price_source === 'mock'));

  console.log('\n========================================');
  console.log('U1 — single-section scope (NOT composite)');
  console.log('========================================');

  const single = buildScopeTakeoff({ sections: [{ project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 } }] }, ds);
  check('single scope ok', single.ok === true);
  check('single scope project_type = the type, not composite', single.project_type === 'kitchen_remodel');
  check('scope source_type = "scope"', single.source_type === 'scope');
  check('single scope has 1 section meta', single.sections.length === 1);
  check('single scope default section id = section-1', single.sections[0].section_id === 'section-1');
  check('single scope materials == manual materials count', single.materials.length === k.materials.length);
  check('single scope every line stamped section-1', single.materials.every(m => m.section_id === 'section-1'));
  check('internal section_takeoffs present for pricing', Array.isArray(single.section_takeoffs) && single.section_takeoffs.length === 1);

  console.log('\n========================================');
  console.log('U1 — composite (kitchen + bathroom)');
  console.log('========================================');

  const bath = buildTakeoff({ projectType: 'bathroom_remodel', bathroomSqft: 60 }, ds);
  const comp = buildScopeTakeoff({ sections: [
    { label: 'Main Kitchen', project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 } },
    { label: 'Hall Bath', project_type: 'bathroom_remodel', inputs: { bathroomSqft: 60 } },
  ] }, ds);
  check('composite ok', comp.ok === true);
  check('composite project_type = "composite"', comp.project_type === 'composite');
  check('composite has 2 section metas', comp.sections.length === 2);
  check('section ids slugified from labels', comp.sections[0].section_id === 'main-kitchen' && comp.sections[1].section_id === 'hall-bath');
  check('merged material count = kitchen + bath', comp.materials.length === k.materials.length + bath.materials.length);
  check('kitchen lines tagged main-kitchen', bySection(comp.materials, 'main-kitchen').length === k.materials.length);
  check('bath lines tagged hall-bath', bySection(comp.materials, 'hall-bath').length === bath.materials.length);
  check('composite has both project types in summary', /kitchen_remodel/.test(comp.summary) && /bathroom_remodel/.test(comp.summary));
  check('fixtures merged + tagged with section_id', comp.fixtures_checklist.plumbing.every(f => f.section_id) && comp.fixtures_checklist.plumbing.length > 0);
  check('derived_by_section keyed by section id', !!comp.derived_by_section['main-kitchen'] && !!comp.derived_by_section['hall-bath']);

  console.log('\n========================================');
  console.log('U1 — section id generation + add_ons mapping');
  console.log('========================================');

  check('slugify kebab-cases', slugify('Main  Kitchen!!') === 'main-kitchen');
  check('addOnsToToggles maps names -> include* booleans',
    addOnsToToggles(['demolition', 'trim']).includeDemolition === true && addOnsToToggles(['demolition', 'trim']).includeTrim === true);
  check('addOnsToToggles ignores unknown', Object.keys(addOnsToToggles(['bogus'])).length === 0);

  const explicitId = buildScopeTakeoff({ sections: [{ section_id: 'K1', project_type: 'kitchen_remodel', inputs: { kitchenSqft: 100 } }] }, ds);
  check('explicit section_id honored (slugified)', explicitId.sections[0].section_id === 'k1');

  const dupLabels = buildScopeTakeoff({ sections: [
    { label: 'Bath', project_type: 'bathroom_remodel', inputs: { bathroomSqft: 40 } },
    { label: 'Bath', project_type: 'bathroom_remodel', inputs: { bathroomSqft: 50 } },
  ] }, ds);
  check('duplicate labels de-duplicated', dupLabels.sections[0].section_id === 'bath' && dupLabels.sections[1].section_id === 'bath-2');

  const withAddon = buildScopeTakeoff({ sections: [
    { project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 }, add_ons: ['demolition'] },
  ] }, ds);
  check('add_ons:["demolition"] adds the demolition line', hasKey(withAddon.materials, 'demolition_dumpster'));
  check('  and without add_ons it is absent', !hasKey(single.materials, 'demolition_dumpster'));

  console.log('\n========================================');
  console.log('U1 — bad input degrades to ok:false (never throws / crashes)');
  console.log('========================================');

  const empty = buildScopeTakeoff({ sections: [] }, ds);
  check('empty sections -> ok:false missing_sections', empty.ok === false && empty.error === 'missing_sections');
  const noSections = buildScopeTakeoff({}, ds);
  check('no sections key -> ok:false', noSections.ok === false);
  const badType = buildScopeTakeoff({ sections: [{ project_type: 'garage', inputs: {} }] }, ds);
  check('unknown project_type -> ok:false invalid_section', badType.ok === false && badType.error === 'invalid_section');
  const missingReq = buildScopeTakeoff({ sections: [
    { project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 } },
    { label: 'Bad', project_type: 'kitchen_remodel', inputs: {} },
  ] }, ds);
  check('missing required input -> ok:false, message names the section', missingReq.ok === false && /Section 2/.test(missingReq.message) && missingReq.section_index === 1);

  console.log('\n========================================');
  console.log('U1 — scope pricing: per-type config, merged into ONE profit layout');
  console.log('========================================');

  const noProv = await priceScopeTakeoff(comp.section_takeoffs, { provider: null, dataset: ds });
  check('no provider -> ok:false pricing_unavailable', noProv.ok === false && noProv.reason === 'pricing_unavailable');

  const cp = await priceScopeTakeoff(comp.section_takeoffs, { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('composite pricing ok', cp.ok === true);
  check('every priced line carries section_id + price_source', cp.lines.every(l => l.section_id && l.price_source === 'mock'));
  check('kitchen-only line (base_cabinets) priced under main-kitchen', cp.lines.some(l => l.key === 'base_cabinets' && l.section_id === 'main-kitchen'));
  check('bath-only line (vanity) priced under hall-bath', cp.lines.some(l => l.key === 'vanity' && l.section_id === 'hall-bath'));
  check('materials_cost = sum of all line costs', approx(cp.profit_layout.materials_cost, Math.round(cp.lines.reduce((s, l) => s + l.line_cost, 0) * 100) / 100));
  check('one labor line + one profit layout for the whole scope', cp.profit_layout.labor_cost >= 0 && cp.profit_layout.price > cp.profit_layout.total_cost - 0.01);
  check('price = total_cost x 1.20', approx(cp.profit_layout.price, Math.round(cp.profit_layout.total_cost * 1.2 * 100) / 100));
  check('per-section cost breakdown present (2 sections)', cp.sections.length === 2 && cp.sections.every(s => s.materials_cost > 0));
  check('composite fully priced by mock', cp.fully_priced === true);

  // Invariant: a single-section scope prices IDENTICALLY to the manual endpoint.
  const scopeSingleP = await priceScopeTakeoff(single.section_takeoffs, { provider: mock, dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('single-section scope pricing == manual pricing (materials)', approx(scopeSingleP.profit_layout.materials_cost, kp.profit_layout.materials_cost));
  check('single-section scope pricing == manual pricing (price)', approx(scopeSingleP.profit_layout.price, kp.profit_layout.price));

  console.log('\n========================================');
  console.log('U3 — budget-derived fallback + price_source enum');
  console.log('========================================');

  // A provider that behaves like the LIVE one but MISSES the made-to-measure countertop
  // (a real failure mode: the slab search returns nothing usable). Everything else prices.
  const partialLive = (missKeys) => ({
    id: 'partial', source: 'homedepot_live',
    async lookup({ key, tier }) {
      if (missKeys.includes(key)) return { ok: false, reason: 'no_match' };
      const row = MOCK_UNIT_PRICES[key]; const price = row && row[tier];
      return price == null ? { ok: false, reason: 'no_match' }
        : { ok: true, unit_price: price, currency: 'USD', product_title: key, source: 'homedepot_live' };
    },
  });

  const withBudget = buildScopeTakeoff({ sections: [
    { project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 }, budget_hint: 20000 },
  ] }, ds);
  const pB = await priceScopeTakeoff(withBudget.section_takeoffs,
    { provider: partialLive(['countertop']), dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('live-priced lines tagged price_source homedepot_live', pB.lines.some(l => l.price_source === 'homedepot_live'));
  const cfLine = pB.lines.find(l => l.key === 'countertop');
  check('unmatched line rescued by budget fallback (now in priced lines)', !!cfLine);
  check('  -> tagged price_source proposal_budget + estimated', cfLine.price_source === 'proposal_budget' && cfLine.estimated === true);
  check('  -> no longer in unpriced_lines', !pB.unpriced_lines.some(l => l.key === 'countertop'));
  check('budget fallback lifts section materials_cost to the hint (no silent understatement)', approx(pB.profit_layout.materials_cost, 20000, 0.5));
  check('totals still reconcile: materials + labor = total', approx(pB.profit_layout.total_cost, pB.profit_layout.materials_cost + pB.profit_layout.labor_cost));
  check('totals still reconcile: price - total = profit', approx(pB.profit_layout.profit, Math.round((pB.profit_layout.price - pB.profit_layout.total_cost) * 100) / 100));

  // Without a budget, the SAME miss silently drops out of the total (the bug U3 guards).
  const noBudget = buildScopeTakeoff({ sections: [{ project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 } }] }, ds);
  const pNB = await priceScopeTakeoff(noBudget.section_takeoffs,
    { provider: partialLive(['countertop']), dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('no budget -> unmatched line stays unpriced', pNB.unpriced_lines.some(l => l.key === 'countertop'));
  check('no budget -> materials_cost is LOWER than the budgeted run (understates without fallback)', pNB.profit_layout.materials_cost < pB.profit_layout.materials_cost);

  // A budget already met by the priced lines does NOT invent extra cost.
  const metBudget = buildScopeTakeoff({ sections: [{ project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 }, budget_hint: 10 }] }, ds);
  const pMet = await priceScopeTakeoff(metBudget.section_takeoffs,
    { provider: partialLive(['countertop']), dataset: ds, tier: 'better' });
  check('budget already met -> unmatched stays unpriced (no phantom cost)', pMet.unpriced_lines.some(l => l.key === 'countertop'));

  // Multiple misses share the remaining budget evenly.
  const twoMiss = await priceScopeTakeoff(withBudget.section_takeoffs,
    { provider: partialLive(['countertop', 'grout']), dataset: ds, tier: 'better', laborPct: 100 });
  const est = twoMiss.lines.filter(l => l.price_source === 'proposal_budget');
  check('two misses -> two budget-estimated lines', est.length === 2);
  check('  -> they split the remaining budget evenly', approx(est[0].line_cost, est[1].line_cost));

  console.log('\n========================================');
  console.log('U5 — passthrough long-tail items (ESTIMATED, carry source_quote)');
  console.log('========================================');
  const withPass = buildScopeTakeoff({ sections: [{
    project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 },
    passthrough: [{ key: 'pot_filler', label: 'Pot filler rough-in', qty: 1, unit: 'ea', source_quote: 'install a pot filler above the range' }],
  }] }, ds);
  const pt = withPass.materials.find(m => m.key === 'pot_filler');
  check('passthrough item appears as a material line', !!pt);
  check('  marked type passthrough + calculation estimated', pt.type === 'passthrough' && pt.calculation === 'estimated');
  check('  carries its source_quote', pt.source_quote === 'install a pot filler above the range');
  check('  stamped with the section id', pt.section_id === 'section-1');

  const passScope = buildScopeTakeoff({ sections: [{
    project_type: 'kitchen_remodel', inputs: { kitchenSqft: 200 }, budget_hint: 30000,
    passthrough: [{ key: 'custom_hood', label: 'Custom range hood', qty: 1, unit: 'ea', source_quote: 'custom hood' }],
  }] }, ds);
  const passPriced = await priceScopeTakeoff(passScope.section_takeoffs, { provider: partialLive([]), dataset: ds, tier: 'better', laborPct: 100 });
  check('unpriceable passthrough falls to a budget estimate (proposal_budget)', passPriced.lines.some(l => l.key === 'custom_hood' && l.price_source === 'proposal_budget'));

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
