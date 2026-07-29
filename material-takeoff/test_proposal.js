/**
 * Material Takeoff — proposal extraction tests (U6 + U7)
 * Exercises the deterministic heuristic extractor, the LLM provider seam (with an injected
 * transport — no real LLM), and buildProposalTakeoff end-to-end. Dependency-free harness.
 */
const { loadDataset } = require('./takeoff_engine.js');
const { buildProposalTakeoff } = require('./scope_engine.js');
const { priceScopeTakeoff } = require('./pricing_engine.js');
const { createMockPricingProvider } = require('./pricing_provider.js');
const {
  hashProposal, heuristicExtract, createHeuristicExtractionProvider,
  createLlmExtractionProvider, selectExtractionProvider, buildLlmRequest, parseLlmScope,
} = require('./extraction_provider.js');

const ds = loadDataset();
let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }

const PROPOSAL = `# Renovation Proposal

## Kitchen
Full remodel of the 220 sqft kitchen. Demo the existing cabinets, install new shaker cabinets and quartz countertops. Paint the walls. Add a pot filler above the range.

## Master Bathroom
Renovate the 90 sqft master bathroom with a new walk-in shower and vanity. Install a heated floor. Remove and reinstall the existing medicine cabinet.
`;

(async () => {
  console.log('========================================');
  console.log('U6/U7 — heuristic extractor');
  console.log('========================================');

  const ex = heuristicExtract({ proposal_markdown: PROPOSAL });
  check('extraction ok', ex.ok === true && ex.source === 'heuristic');
  check('two sections found', ex.extracted_scope.sections.length === 2);
  const [kSec, bSec] = ex.extracted_scope.sections;
  check('section 1 classified kitchen (not fooled by "medicine cabinet")', kSec.project_type === 'kitchen_remodel');
  check('section 2 classified bathroom', bSec.project_type === 'bathroom_remodel');
  check('stated area -> confidence "stated"', kSec.inputs.kitchenSqft === 220 && kSec.confidence === 'stated');
  check('bathroom stated area 90', bSec.inputs.bathroomSqft === 90 && bSec.confidence === 'stated');
  check('kitchen add_ons include demolition + paint', kSec.add_ons.includes('demolition') && kSec.add_ons.includes('paint'));
  check('kitchen carries a source_quote', typeof kSec.source_quote === 'string' && kSec.source_quote.length > 0);
  check('long-tail pot filler -> passthrough with its source_quote', kSec.passthrough.some(p => p.key === 'pot_filler' && /pot filler/i.test(p.source_quote)));
  check('bathroom heated floor -> passthrough', bSec.passthrough.some(p => p.key === 'heated_floor'));
  check('remove & reinstall medicine cabinet -> NOT added', !(bSec.passthrough || []).some(p => p.key === 'medicine_cabinet'));
  check('  -> and a note explains why', ex.extracted_scope.notes.some(n => /medicine cabinet/i.test(n) && /reinstall/i.test(n)));

  // assumed area when none is stated
  const noArea = heuristicExtract({ proposal_markdown: '## Kitchen\nRemodel the kitchen with new cabinets.' });
  check('no stated area -> confidence "assumed" + a default sqft', noArea.extracted_scope.sections[0].confidence === 'assumed' && noArea.extracted_scope.sections[0].inputs.kitchenSqft > 0);

  // no recognizable scope -> ok:false no_scope_extracted (never throws)
  const none = heuristicExtract({ proposal_markdown: 'Hello, please call me next week about pricing.' });
  check('no scope -> ok:false no_scope_extracted', none.ok === false && none.reason === 'no_scope_extracted');
  const empty = heuristicExtract({ proposal_markdown: '' });
  check('empty proposal -> ok:false (no crash)', empty.ok === false);

  // deterministic: identical input -> identical output (the property a proposal-hash cache relies on)
  check('extraction is deterministic (identical in -> identical out)',
    JSON.stringify(heuristicExtract({ proposal_markdown: PROPOSAL })) === JSON.stringify(heuristicExtract({ proposal_markdown: PROPOSAL })));

  // budget_hint from budget_sections by trade keyword
  const budgeted = heuristicExtract({ proposal_markdown: PROPOSAL, budget_sections: [{ label: 'Kitchen materials', amount: 18000 }, { label: 'Bathroom', amount: 9000 }] });
  check('budget_sections mapped to sections by trade', budgeted.extracted_scope.sections[0].budget_hint === 18000 && budgeted.extracted_scope.sections[1].budget_hint === 9000);

  console.log('\n========================================');
  console.log('U7 — buildProposalTakeoff end-to-end (heuristic provider)');
  console.log('========================================');

  const prov = createHeuristicExtractionProvider();
  const t = await buildProposalTakeoff({ proposal_markdown: PROPOSAL }, ds, prov);
  check('proposal takeoff ok', t.ok === true);
  check('source_type = "proposal"', t.source_type === 'proposal');
  check('two-section proposal -> composite', t.project_type === 'composite' && t.sections.length === 2);
  check('extracted_scope echoed back', t.extracted_scope && t.extracted_scope.sections.length === 2);
  check('extracted_scope section ids aligned to generated ids', t.extracted_scope.sections[0].section_id === t.sections[0].section_id);
  check('every material line has source_quote + confidence fields', t.materials.every(m => 'source_quote' in m && 'confidence' in m));
  const baseCab = t.materials.find(m => m.key === 'base_cabinets');
  check('a kitchen-derived line inherits its section confidence "stated"', baseCab && baseCab.confidence === 'stated' && typeof baseCab.source_quote === 'string');
  const potFiller = t.materials.find(m => m.key === 'pot_filler');
  check('passthrough pot filler present as an ESTIMATED line', potFiller && potFiller.type === 'passthrough' && /pot filler/i.test(potFiller.source_quote));

  // priced end-to-end (mock)
  const priced = await priceScopeTakeoff(t.section_takeoffs, { provider: createMockPricingProvider(), dataset: ds, tier: 'better', markupPct: 20, laborPct: 100 });
  check('proposal takeoff is priceable (one profit layout)', priced.ok === true && priced.profit_layout.price > 0);

  // no scope -> ok:false, still source_type proposal (server maps this to a 200)
  const noneT = await buildProposalTakeoff({ proposal_markdown: 'Call me about a quote sometime.' }, ds, prov);
  check('no-scope proposal -> ok:false no_scope_extracted (no throw)', noneT.ok === false && noneT.error === 'no_scope_extracted' && noneT.source_type === 'proposal');

  console.log('\n========================================');
  console.log('Integration fixes (Sing) — Scope-of-Work parsing + denylist + provenance');
  console.log('========================================');

  // Issue 3: a 12-heading proposal must yield ONLY the Scope-of-Work area — not Exclusions,
  // Warranty, Permits, Executive Summary (which previously each produced a full takeoff).
  const noisy = heuristicExtract({ proposal_markdown:
    '## Executive Summary\nBathroom remodel at 123 Main St.\n\n## Scope of Work\n### 1. Bathroom\n- Install floor tile 75 sqft\n\n## Exclusions\n- Kitchen cabinetry is excluded\n- Countertops are excluded\n\n## Warranty\n- One year workmanship\n\n## Permits\n- Contractor pulls permits\n' });
  check('Issue 3: only Scope-of-Work is a work area (1 section, not 12)', noisy.extracted_scope.sections.length === 1);
  check('  -> it is the bathroom, 75 sqft', noisy.extracted_scope.sections[0].project_type === 'bathroom_remodel' && noisy.extracted_scope.sections[0].area_sqft === 75);
  check('  -> Exclusions/Warranty/Permits did NOT become takeoffs', !noisy.extracted_scope.sections.some(s => /exclusion|warranty|permit|summary/i.test(s.label)));
  check('  -> notes record the skipped non-work headings', noisy.extracted_scope.notes.some(n => /skipped/i.test(n)));

  // Issue 2: phase subsections under Scope of Work collapse to one job with merged add-ons.
  const phased = heuristicExtract({ proposal_markdown:
    '## Scope of Work\n### 1. Site Protection & Project Management\n- protect the floors, install dust barriers\n### 2. Demolition & Disposal\n- demo the existing flooring\n### 3. Flooring Installation\n- install 1400 sqft of LVP\n- prep the subfloor\n- new baseboard trim\n' });
  check('Issue 2: phase subsections collapse to ONE flooring section', phased.extracted_scope.sections.length === 1 && phased.extracted_scope.sections[0].project_type === 'flooring_only');
  check('  -> area read from the flooring subsection (1400)', phased.extracted_scope.sections[0].area_sqft === 1400);
  check('  -> add-ons merged across the phases', ['demolition', 'subfloor', 'trim', 'site_protection'].every(a => phased.extracted_scope.sections[0].add_ons.includes(a)));

  // Denylist backstop (no Scope-of-Work wrapper): a "## Materials" list naming a room is dropped.
  const denyMat = heuristicExtract({ proposal_markdown:
    '## Kitchen\nRemodel the 180 sqft kitchen.\n## Materials\n- Kitchen cabinets\n- Quartz countertops\n' });
  check('denylist: "## Materials" does not become a second kitchen section', denyMat.extracted_scope.sections.length === 1);

  // Smaller items: scope-level id + area_sqft populated; source_quote is a body sentence; notes present.
  const built = await buildProposalTakeoff({ proposal_markdown:
    '## Scope of Work\n### 1. Bathroom\n- Full remodel of the 75 sqft bathroom with a walk-in shower\n' }, ds, createHeuristicExtractionProvider());
  const exSec = built.extracted_scope.sections[0];
  check('smaller: extracted section has a non-null id', typeof exSec.id === 'string' && exSec.id.length > 0);
  check('smaller: extracted section has area_sqft populated (75)', exSec.area_sqft === 75);
  check('smaller: source_quote is a body sentence, not the heading', /75 sqft|walk-in/i.test(exSec.source_quote) && exSec.source_quote !== '1. Bathroom');

  console.log('\n========================================');
  console.log('U7 — LLM provider seam (injected transport, cached by proposal hash)');
  console.log('========================================');

  const fakeScope = { sections: [{ label: 'Kitchen', project_type: 'kitchen_remodel', inputs: { kitchenSqft: 180 }, confidence: 'stated', source_quote: 'kitchen remodel' }], notes: [] };
  let calls = 0;
  const okFetch = async () => { calls++; return { ok: true, status: 200, async json() { return { content: [{ type: 'text', text: JSON.stringify(fakeScope) }] }; }, async text() { return ''; } }; };
  const llm = createLlmExtractionProvider({ apiKey: 'K', fetchImpl: okFetch });
  const r1 = await llm.extract({ proposal_markdown: 'kitchen 180 sqft' });
  check('LLM provider parses a structured scope', r1.ok === true && r1.source === 'llm' && r1.extracted_scope.sections[0].project_type === 'kitchen_remodel');
  const r2 = await llm.extract({ proposal_markdown: 'kitchen 180 sqft' });
  check('LLM result cached by proposal hash (1 fetch for 2 identical calls)', calls === 1 && r2.cached === true);

  const badJson = createLlmExtractionProvider({ apiKey: 'K', fetchImpl: async () => ({ ok: true, status: 200, async json() { return { content: [{ type: 'text', text: 'sorry, no JSON here' }] }; }, async text() { return ''; } }) });
  check('LLM returns prose (no JSON) -> no_scope_extracted (no crash)', (await badJson.extract({ proposal_markdown: 'x' })).reason === 'no_scope_extracted');

  const http500 = createLlmExtractionProvider({ apiKey: 'K', fetchImpl: async () => ({ ok: false, status: 500, async json() { return null; }, async text() { return ''; } }) });
  check('LLM non-2xx -> extraction_unavailable (no throw)', (await http500.extract({ proposal_markdown: 'x' })).reason === 'extraction_unavailable');

  const boom = createLlmExtractionProvider({ apiKey: 'K', fetchImpl: async () => { throw new Error('socket hang up'); } });
  check('LLM transport throw -> extraction_error (no throw)', (await boom.extract({ proposal_markdown: 'x' })).reason === 'extraction_error');

  const reqBody = buildLlmRequest('claude-sonnet-5', { proposal_markdown: 'p', budget_total: 1000 });
  check('LLM request is low-temperature + structured', reqBody.temperature === 0 && typeof reqBody.system === 'string' && reqBody.messages[0].role === 'user');
  check('parseLlmScope tolerates prose around the JSON', parseLlmScope({ content: [{ text: 'here you go {"sections":[{"project_type":"kitchen_remodel","inputs":{"kitchenSqft":100}}],"notes":[]} thanks' }] }).sections.length === 1);
  check('parseLlmScope(null) -> null', parseLlmScope(null) === null);

  console.log('\n========================================');
  console.log('U7 — provider selection + hashing');
  console.log('========================================');
  check('EXTRACTION_API_KEY -> llm provider', selectExtractionProvider({ EXTRACTION_API_KEY: 'k' }).provider.id === 'llm');
  check('ANTHROPIC_API_KEY -> llm provider', selectExtractionProvider({ ANTHROPIC_API_KEY: 'k' }).provider.id === 'llm');
  check('no key -> heuristic provider (always available)', selectExtractionProvider({}).provider.id === 'heuristic');
  check('hashProposal deterministic + content-sensitive', hashProposal('a') === hashProposal('a') && hashProposal('a') !== hashProposal('b'));

  console.log('\n========================================');
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
})();
