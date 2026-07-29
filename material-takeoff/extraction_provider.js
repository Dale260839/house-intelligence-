/**
 * Material Takeoff — proposal extraction provider (v2, U6 / U7)
 * ------------------------------------------------------------
 * Turns a free-text PROPOSAL (markdown) into the structured from-scope shape the
 * deterministic core already understands:
 *   { sections:[{ project_type, inputs, add_ons?, budget_hint?, passthrough?,
 *                 source_quote, confidence }], notes:[] }
 *
 * This is the ONE place an LLM belongs — the takeoff/scope core stays fully deterministic;
 * extraction is the fuzzy step, so it lives behind a PROVIDER SEAM (mirrors
 * pricing_provider.js and House Intelligence's address adapters) and is fully mockable.
 *
 *   selectExtractionProvider(env):
 *     EXTRACTION_API_KEY / ANTHROPIC_API_KEY set -> LLM provider (structured output,
 *                                                    temperature 0, CACHED BY PROPOSAL HASH
 *                                                    so identical re-runs are free + stable)
 *     else                                       -> deterministic HEURISTIC extractor
 *                                                    (always available, so /from-proposal
 *                                                     works without a key; clearly labeled)
 *
 * Provider interface:
 *   await provider.extract({ proposal_markdown, budget_total, budget_sections, project_type_hint })
 *     -> { ok:true,  source, extracted_scope:{ sections:[…], notes:[…] }, cached? }
 *      | { ok:false, reason:'no_scope_extracted', source, notes:[…] }
 *
 * Never throws — an extraction miss/outage degrades to ok:false so a request never crashes.
 */
const crypto = require('crypto');
const { httpsRequestJson } = require('./pricing_provider.js');

/** Stable content hash of a proposal — the LLM cache key (identical proposal => identical answer). */
function hashProposal(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

// ─── deterministic heuristic extractor (default; the test mock) ─────────────────
// A real, if simple, extraction layer: split the proposal into blocks, classify each onto
// a supported project type, pull the stated area, detect add-ons + long-tail items, and
// honour remove-and-reinstall (no new material). A production LLM REPLACES this behind the
// same seam; keeping a deterministic default means the endpoint works with no key + in tests.

// Supported project types, in PRIORITY order (a block naming a kitchen is a kitchen even if
// it also mentions its floor).
const TYPE_RULES = [
  { type: 'kitchen_remodel',  label: 'Kitchen',  sqft: 'kitchenSqft',
    re: /\b(kitchen|cabinet|countertop|backsplash)s?\b/i },
  { type: 'bathroom_remodel', label: 'Bathroom', sqft: 'bathroomSqft',
    re: /\b(bath(?:room)?|shower|vanity|tub|toilet)s?\b/i },
  { type: 'flooring_only',    label: 'Flooring', sqft: 'floorSqft',
    re: /\b(floor(?:ing)?|lvp|laminate|hardwood|luxury vinyl)\b/i },
];
const DEFAULT_SQFT = { kitchen_remodel: 200, bathroom_remodel: 100, flooring_only: 300 };

// add_on -> the phrases that switch it on.
const ADDON_RULES = [
  { addon: 'demolition',      re: /\b(demo(?:lition)?|tear[- ]?out|gut)\b/i },
  { addon: 'subfloor',        re: /\bsub[- ]?floor(?:ing)?\b/i },
  { addon: 'paint',           re: /\b(paint|primer)\b/i },
  { addon: 'trim',            re: /\b(trim|baseboard|moulding|molding|casing)\b/i },
  { addon: 'hardware',        re: /\b(hardware|pulls?|knobs?)\b/i },
  { addon: 'site_protection', re: /\b(dust (?:barrier|control|protection)|site protection|floor protection|containment|hepa)\b/i },
];

// Long-tail fixtures we don't model as geometry rules -> carried as ESTIMATED passthrough.
const PASSTHROUGH_RULES = [
  { key: 'pot_filler',       label: 'Pot filler',          re: /\bpot[- ]?filler\b/i },
  { key: 'range_hood',       label: 'Range hood',          re: /\b(range hood|vent hood|exhaust hood)\b/i },
  { key: 'medicine_cabinet', label: 'Medicine cabinet',    re: /\bmedicine cabinet\b/i },
  { key: 'heated_floor',     label: 'Heated floor system', re: /\b(heated floor|radiant floor|floor warming)\b/i },
  { key: 'towel_warmer',     label: 'Towel warmer',        re: /\btowel warmer\b/i },
  { key: 'skylight',         label: 'Skylight',            re: /\bskylight\b/i },
];

const RE_SQFT = /(\d[\d,]*)\s*(?:sq\.?\s?ft|sf|square\s?feet|square\s?foot)\b/i;
// Remove-and-reinstall of the SAME item generates NO new material — unless the same clause
// also says new/replace.
const reinstallOnly = (s) =>
  /\b(remove and reinstall|reinstall(?:ing)? (?:the )?existing|r ?& ?r)\b/i.test(s) &&
  !/\b(new|replace|replacement)\b/i.test(s);

// A BuildSuite proposal nests the actual work under one "## Scope of Work" heading, with a
// `### N. Trade` subsection per phase. When present, ONLY those subsections are real work
// areas (Issue 2) — everything else (Executive Summary, Exclusions, Warranty, Permits …) is
// prose that must never become a takeoff (Issue 3).
const SCOPE_RE = /\bscope\s+of\s+(?:the\s+)?work\b|\bproject\s+scope\b|\bwork\s+to\s+be\s+performed\b|^\s*scope\s*$/i;

// Headings that are NOT work areas. Matched after stripping any "### 5. " numbering. This is
// the backstop for proposals that have no "## Scope of Work" wrapper (Issue 3).
const DENYLIST = [
  'executive summary', 'summary', 'project summary', 'project highlights', 'highlights',
  'overview', 'introduction', 'intro', 'timeline', 'schedule', 'pricing', 'price',
  'cost breakdown', 'investment summary', 'investment', 'payment schedule', 'payment',
  'exclusions', 'excluded', 'not included', 'warranty', 'permits', 'permit',
  'site considerations', 'assumptions', 'allowances', 'client responsibilities',
  'change order', 'change orders', 'completion criteria', 'terms', 'terms and conditions',
  'acceptance', 'signature', 'contact', 'about us', 'about', 'notes', 'general notes',
  'materials', 'material list', 'fixtures', 'project details', 'project management',
];
function isDeniedHeading(heading) {
  const h = String(heading || '').toLowerCase().replace(/^[\s\d.)#-]+/, '').trim();
  return DENYLIST.some(term => h === term || h.startsWith(term + ' ') || h.startsWith(term + ':') || h.startsWith(term + ' &'));
}

const unionAddons = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));

const sentencesOf = (t) => String(t).split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
function firstSentence(text, re) { for (const s of sentencesOf(text)) if (re.test(s)) return s; return null; }

/** Parse the markdown into a flat list of heading nodes { level, title, body[] } in doc order. */
function parseNodes(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const nodes = [];
  let cur = { level: 0, title: '', body: [] };
  for (const ln of lines) {
    const h = ln.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) { nodes.push(cur); cur = { level: h[1].length, title: h[2].trim(), body: [] }; }
    else cur.body.push(ln);
  }
  nodes.push(cur);
  return nodes.filter(n => n.level > 0 || n.body.join('').trim());
}

function nodeToBlock(n) {
  const body = n.body.join('\n').trim();
  return { heading: n.title, body, text: `${n.title}\n${body}`.trim() };
}

/**
 * Choose which blocks are candidate WORK AREAS:
 *   - If a "## Scope of Work" heading exists, ONLY its deeper subsections count — a real
 *     BuildSuite proposal nests every trade under it as `### N. …`, and Executive Summary /
 *     Exclusions / Warranty / Permits live OUTSIDE it (Issues 2 & 3).
 *   - Otherwise every top-level section is a candidate (legacy); the denylist filters prose.
 * Returns { blocks, mode: 'scope' | 'legacy' }.
 */
function selectBlocks(md) {
  const nodes = parseNodes(md);
  const scopeIdx = nodes.findIndex(n => n.level >= 1 && SCOPE_RE.test(n.title));
  if (scopeIdx >= 0) {
    const scope = nodes[scopeIdx];
    const subs = [];
    for (let i = scopeIdx + 1; i < nodes.length; i++) {
      if (nodes[i].level <= scope.level) break;   // next sibling/parent heading ends the scope
      subs.push(nodes[i]);
    }
    const src = subs.length ? subs : [scope];     // scope with no subsections -> its own body
    // Everything at the scope's level or shallower (other than the scope heading itself) is
    // non-scope prose — Executive Summary, Exclusions, Warranty, Permits — report it for trust.
    const ignored = nodes
      .filter((n, i) => i !== scopeIdx && n.level > 0 && n.level <= scope.level)
      .map(n => n.title);
    return { blocks: src.map(nodeToBlock), mode: 'scope', ignored };
  }
  const tops = nodes.filter(n => n.level >= 1);
  const src = tops.length ? tops : nodes;         // no headings at all -> the whole doc as one block
  return { blocks: src.map(nodeToBlock), mode: 'legacy', ignored: [] };
}

// Classify a block by the type with the MOST keyword hits (not the first match): a bathroom
// block that says "medicine cabinet" must not be mis-read as a kitchen. Ties fall to
// TYPE_RULES priority (a strict `>` keeps the earlier, higher-priority type).
function classifyBlock(text) {
  let best = null, bestScore = 0;
  for (const rule of TYPE_RULES) {
    const hits = (text.match(new RegExp(rule.re.source, 'gi')) || []).length;
    if (hits > bestScore) { best = rule; bestScore = hits; }
  }
  return best;
}

// Detect add-ons + long-tail passthrough items in ANY block (a room section OR a phase
// subsection like "### Demolition"), honouring remove-and-reinstall (no new material).
function detectExtras(text) {
  const notes = [];
  const add_ons = [];
  for (const ar of ADDON_RULES) {
    const sent = firstSentence(text, ar.re);
    if (!sent) continue;
    if (reinstallOnly(sent)) { notes.push(`"${ar.addon}" is remove & reinstall — no new material added.`); continue; }
    add_ons.push(ar.addon);
  }
  const passthrough = [];
  for (const pr of PASSTHROUGH_RULES) {
    const sent = firstSentence(text, pr.re);
    if (!sent) continue;
    if (reinstallOnly(sent)) { notes.push(`"${pr.label}" is remove & reinstall — no new item added.`); continue; }
    passthrough.push({ key: pr.key, label: pr.label, qty: 1, unit: 'ea',
      source_quote: sent, confidence: /\d/.test(sent) ? 'stated' : 'inferred' });
  }
  return { add_ons, passthrough, notes };
}

function extractSection(block) {
  const rule = classifyBlock(block.text);
  if (!rule) return null;

  const notes = [];
  const m = block.text.match(RE_SQFT);
  let area, confidence;
  if (m) { area = Number(m[1].replace(/,/g, '')); confidence = 'stated'; }   // prefer STATED
  else { area = DEFAULT_SQFT[rule.type]; confidence = 'assumed'; }            // else assumed (flagged post-merge)

  const extras = detectExtras(block.text);
  notes.push(...extras.notes);

  // source_quote: a real sentence from the BODY (a measurement line, else a trade line, else the
  // first body sentence) — NOT the heading — for useful provenance in the UI.
  const source_quote = firstSentence(block.body, RE_SQFT)
    || firstSentence(block.body, rule.re)
    || sentencesOf(block.body)[0]
    || block.heading || null;

  const section = {
    label: block.heading || rule.label,
    project_type: rule.type,
    inputs: { [rule.sqft]: area },
    area_sqft: area,
    source_quote,
    confidence,
  };
  if (extras.add_ons.length) section.add_ons = extras.add_ons;
  if (extras.passthrough.length) section.passthrough = extras.passthrough;
  return { section, notes };
}

// Scope mode is one job decomposed by phase -> merge same-type room sections (union add-ons,
// concat passthrough, prefer a stated area over an assumed one).
function mergeRoomSections(sections) {
  const order = [];
  const map = new Map();
  for (const s of sections) {
    if (!map.has(s.project_type)) { map.set(s.project_type, s); order.push(s.project_type); continue; }
    const t = map.get(s.project_type);
    if (s.confidence === 'stated' && t.confidence !== 'stated') {
      t.inputs = s.inputs; t.area_sqft = s.area_sqft; t.confidence = 'stated'; t.source_quote = s.source_quote || t.source_quote;
    }
    if (s.add_ons) t.add_ons = unionAddons(t.add_ons, s.add_ons);
    if (s.passthrough) t.passthrough = [...(t.passthrough || []), ...s.passthrough];
  }
  return order.map(k => map.get(k));
}

function heuristicExtract({ proposal_markdown, budget_total, budget_sections } = {}) {
  const { blocks, mode, ignored } = selectBlocks(proposal_markdown);

  const roomSections = [];
  const globalAddOns = [];
  const globalPassthrough = [];
  const notes = [];
  const skipped = [...(ignored || [])];   // non-scope headings ignored in scope mode

  for (const b of blocks) {
    if (isDeniedHeading(b.heading)) { skipped.push(b.heading); continue; }   // Issue 3
    const r = extractSection(b);
    if (r) {
      roomSections.push(r.section);
      notes.push(...r.notes);
    } else {
      // A phase/support subsection (Demolition, Site Protection, …): no room of its own, but
      // its add-ons + long-tail items still count — apply them to the room section(s).
      const ex = detectExtras(b.text);
      globalAddOns.push(...ex.add_ons);
      globalPassthrough.push(...ex.passthrough);
      notes.push(...ex.notes);
    }
  }

  // Scope mode is a single job decomposed by phase -> merge same-type room sections.
  const sections = (mode === 'scope') ? mergeRoomSections(roomSections) : roomSections;

  // Apply job-wide add-ons / long-tail items to the primary room section.
  if (sections.length && (globalAddOns.length || globalPassthrough.length)) {
    const first = sections[0];
    if (globalAddOns.length) first.add_ons = unionAddons(first.add_ons, globalAddOns);
    if (globalPassthrough.length) first.passthrough = [...(first.passthrough || []), ...globalPassthrough];
  }

  // Flag FINAL sections that ran on an assumed (not stated) area — only after the merge, so a
  // phase subsection that folds into a stated section never leaves a stray "assumed" note.
  for (const s of sections) {
    if (s.confidence === 'assumed') notes.push(`"${s.label}": no area stated — assumed ${s.area_sqft} sqft (verify).`);
  }
  if (skipped.length) notes.push(`Skipped ${skipped.length} non-work heading(s): ${skipped.slice(0, 8).join(', ')}.`);

  if (!sections.length) {
    return { ok: false, reason: 'no_scope_extracted', source: 'heuristic',
      notes: notes.concat('No kitchen, bathroom, or flooring work area found in the proposal.') };
  }

  // Legacy heading-less blob that names >1 trade only captures the top-priority one.
  if (mode === 'legacy' && blocks.length === 1) {
    const matched = TYPE_RULES.filter(r => r.re.test(blocks[0].text));
    if (matched.length > 1) {
      notes.push(`Multiple trades detected in one block; only "${sections[0].project_type}" captured — add markdown headings (## Scope of Work with ### subsections) or enable the LLM extractor for full multi-section.`);
    }
  }

  assignBudgets(sections, budget_total, budget_sections);
  return { ok: true, source: 'heuristic', extracted_scope: { sections, notes } };
}

/** Attach a per-section materials budget: match budget_sections by keyword, else the total for a lone section. */
function assignBudgets(sections, budgetTotal, budgetSections) {
  const bs = Array.isArray(budgetSections) ? budgetSections : [];
  for (const s of sections) {
    const trade = s.project_type.split('_')[0];                 // kitchen | bathroom | flooring
    const match = bs.find(b => b && typeof b.label === 'string' && b.label.toLowerCase().includes(trade));
    if (match && Number(match.amount) > 0) s.budget_hint = Number(match.amount);
  }
  if (sections.length === 1 && sections[0].budget_hint == null && Number(budgetTotal) > 0) {
    sections[0].budget_hint = Number(budgetTotal);
  }
}

function createHeuristicExtractionProvider() {
  return { id: 'heuristic', source: 'heuristic', async extract(req) { return heuristicExtract(req || {}); } };
}

// ─── LLM extraction provider (the seam a production LLM plugs into) ──────────────
function buildLlmRequest(model, req) {
  const schema = '{"sections":[{"label":string,"project_type":"kitchen_remodel|bathroom_remodel|flooring_only",'
    + '"inputs":{...engine inputs, e.g. kitchenSqft/bathroomSqft/floorSqft...},"add_ons":["demolition","subfloor",'
    + '"paint","trim","hardware","site_protection"],"budget_hint":number,"passthrough":[{"key":string,"label":string,'
    + '"qty":number,"unit":string,"source_quote":string,"confidence":"stated|inferred|assumed"}],"source_quote":string,'
    + '"confidence":"stated|inferred|assumed"}],"notes":[string]}';
  const system = 'You convert a renovation PROPOSAL into a STRICT JSON build scope. Output ONLY JSON matching the schema, '
    + 'nothing else. Prefer STATED quantities over inferred and set confidence accordingly (stated|inferred|assumed). '
    + 'Remove-and-reinstall of the SAME item generates NO new item. If there is no build scope, return '
    + '{"sections":[],"notes":["no_scope_extracted"]}.';
  const user = `SCHEMA: ${schema}\n\nBUDGET_TOTAL: ${req.budget_total || ''}\nPROJECT_TYPE_HINT: ${req.project_type_hint || ''}\n\nPROPOSAL:\n${req.proposal_markdown || ''}`;
  return { model, max_tokens: 1500, temperature: 0, system, messages: [{ role: 'user', content: user }] };
}

function parseLlmScope(json) {
  if (!json) return null;
  let text = null;
  if (Array.isArray(json.content)) text = json.content.map(c => c && c.text).filter(Boolean).join('\n');
  else if (typeof json.completion === 'string') text = json.completion;
  else if (typeof json.text === 'string') text = json.text;
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);           // tolerate prose around the JSON
  if (!m) return null;
  let parsed; try { parsed = JSON.parse(m[0]); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.sections)) return null;
  return { sections: parsed.sections, notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
}

function createLlmExtractionProvider(opts = {}) {
  const apiKey = opts.apiKey || process.env.EXTRACTION_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('createLlmExtractionProvider: missing EXTRACTION_API_KEY / ANTHROPIC_API_KEY.');
  const apiUrl = opts.apiUrl || process.env.EXTRACTION_API_URL || 'https://api.anthropic.com/v1/messages';
  const model = opts.model || process.env.EXTRACTION_MODEL || 'claude-sonnet-5';
  const fetchImpl = opts.fetchImpl || httpsRequestJson;
  const timeoutMs = opts.timeoutMs || 20000;
  const cache = opts.cache || new Map();          // proposal hash -> result (deterministic re-runs)

  return {
    id: 'llm', source: 'llm',
    async extract(req = {}) {
      const key = `${hashProposal(req.proposal_markdown)}|${req.project_type_hint || ''}`;
      if (cache.has(key)) return { ...cache.get(key), cached: true };

      let result;
      try {
        const res = await fetchImpl(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: buildLlmRequest(model, req),
          timeoutMs,
        });
        if (!res || !res.ok) {
          result = { ok: false, reason: 'extraction_unavailable', source: 'llm', status: res && res.status };
        } else {
          let json; try { json = await res.json(); } catch { json = null; }
          const scope = parseLlmScope(json);
          result = (scope && scope.sections.length)
            ? { ok: true, source: 'llm', extracted_scope: scope }
            : { ok: false, reason: 'no_scope_extracted', source: 'llm' };
        }
      } catch (err) {
        result = { ok: false, reason: 'extraction_error', source: 'llm', detail: String((err && err.message) || err) };
      }
      cache.set(key, result);
      return result;
    },
  };
}

/**
 * Auto-select an extraction provider (mirrors selectPricingProvider):
 *   EXTRACTION_API_KEY / ANTHROPIC_API_KEY set → LLM provider
 *   else                                       → deterministic heuristic (always available)
 */
function selectExtractionProvider(env = process.env) {
  const key = String(env.EXTRACTION_API_KEY || env.ANTHROPIC_API_KEY || '').trim();
  if (key) {
    return {
      provider: createLlmExtractionProvider({ apiKey: key, apiUrl: env.EXTRACTION_API_URL, model: env.EXTRACTION_MODEL }),
      label: 'llm (via EXTRACTION_API_KEY)',
    };
  }
  return {
    provider: createHeuristicExtractionProvider(),
    label: 'heuristic (deterministic; set EXTRACTION_API_KEY for LLM extraction)',
  };
}

module.exports = {
  hashProposal,
  heuristicExtract,
  createHeuristicExtractionProvider,
  createLlmExtractionProvider,
  selectExtractionProvider,
  buildLlmRequest,
  parseLlmScope,
};
