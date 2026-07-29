/**
 * Material Takeoff — multi-section scope aggregator (v2)
 * -----------------------------------------------------
 * BuildSuite sends a whole job as a SCOPE: an array of sections, each with its own project
 * type + measurements (a kitchen, a bathroom, a floor). This module runs the existing
 * per-type builder for EACH section and merges the results into one takeoff — every
 * material line stamped with the section it came from — WITHOUT changing the single-section
 * engine (takeoff_engine.js) at all.
 *
 * Deterministic + zero-dependency, exactly like the rest of the service. Pricing stays a
 * separate async pass (priceScopeTakeoff in pricing_engine.js), so this stays pure.
 *
 *   POST /material-takeoff/from-scope
 *     { sections: [{ section_id?, label?, project_type, inputs{}, add_ons?[], budget_hint? }],
 *       price?, tier?, markupPct?, laborPct?, laborCost?, budget_total?, budget_sections?, location? }
 */

const { buildTakeoff } = require('./takeoff_engine.js');
const { passthroughLine } = require('./line_builders.js');

// add_ons[] is the v2 way to switch on optional material groups; the builders still speak
// the include* booleans. Map one to the other so the CONTRACT is a clean add_ons array but
// nothing inside the builders has to change. (site_protection lands in U5.)
const ADDON_TOGGLES = {
  demolition: 'includeDemolition',
  subfloor: 'includeSubfloor',
  paint: 'includePaint',
  trim: 'includeTrim',
  hardware: 'includeHardware',
  site_protection: 'includeSiteProtection',
};

/** Map an add_ons[] array to the engine's include* boolean inputs. Unknown names ignored. */
function addOnsToToggles(addOns) {
  const out = {};
  if (!Array.isArray(addOns)) return out;
  for (const a of addOns) {
    const key = ADDON_TOGGLES[String(a == null ? '' : a).trim().toLowerCase()];
    if (key) out[key] = true;
  }
  return out;
}

/** kebab-case a label/id into a stable section slug. Empty in -> '' (caller falls back). */
function slugify(s) {
  return String(s == null ? '' : s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function posNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build a merged, multi-section takeoff.
 * Returns { ok:true, project_type:'composite'|<type>, source_type:'scope', sections:[meta],
 *   materials:[merged — each carries .section_id], fixtures_checklist, derived_by_section,
 *   section_takeoffs:[…] (INTERNAL — the server strips this before responding) }
 * or { ok:false, error, message } (the server maps ok:false to HTTP 400) — a single bad
 * section fails the call with a message naming which one, and never throws.
 */
function buildScopeTakeoff(body, dataset) {
  const sections = body && body.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    return { ok: false, error: 'missing_sections',
      message: 'Provide a non-empty "sections" array. Each section needs at least { project_type, inputs }.' };
  }

  const usedIds = new Set();
  const sectionTakeoffs = [];
  const mergedMaterials = [];
  const plumbing = [];
  const electrical = [];
  const derivedBySection = {};
  const sectionMeta = [];

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i] || {};

    // Stable, unique section id: explicit section_id > slug(label) > section-N.
    let sid = slugify(s.section_id) || slugify(s.label) || `section-${i + 1}`;
    if (usedIds.has(sid)) sid = `${sid}-${i + 1}`;
    usedIds.add(sid);

    const input = {
      projectType: s.project_type,
      ...(s.inputs || {}),
      ...addOnsToToggles(s.add_ons),
      sectionId: sid,
    };

    const t = buildTakeoff(input, dataset);
    if (!t.ok) {
      return { ok: false, error: 'invalid_section',
        message: `Section ${i + 1}${s.label ? ` (${s.label})` : ''} [${s.project_type || 'no project_type'}]: ${t.message}`,
        section_index: i, section_error: t };
    }

    // Long-tail passthrough items (U5): scope/proposal lines the builders can't derive
    // from geometry. Appended as ESTIMATED material lines, stamped with this section's id.
    if (Array.isArray(s.passthrough)) {
      for (const p of (s.passthrough || [])) {
        const line = passthroughLine(p.key, p.label, p.qty, p.unit,
          { basis: p.basis, source_quote: p.source_quote, confidence: p.confidence, note: p.note });
        line.section_id = sid;
        t.materials.push(line);
      }
    }

    // buildTakeoff already stamped section_id = sid on every material line.
    mergedMaterials.push(...t.materials);
    for (const f of t.fixtures_checklist.plumbing) plumbing.push({ ...f, section_id: sid });
    for (const f of t.fixtures_checklist.electrical) electrical.push({ ...f, section_id: sid });
    derivedBySection[sid] = t.derived;

    const budgetHint = posNumOrNull(s.budget_hint);
    sectionMeta.push({
      section_id: sid,
      label: s.label || t.project_label,
      project_type: t.project_type,
      summary: t.summary,
      material_count: t.materials.length,
      add_ons: Array.isArray(s.add_ons) ? s.add_ons : [],
      budget_hint: budgetHint,
    });
    sectionTakeoffs.push({
      section_id: sid, project_type: t.project_type,
      materials: t.materials, budget_hint: budgetHint,
    });
  }

  const composite = sectionMeta.length > 1;
  const single = sectionMeta[0];

  return {
    ok: true,
    project_type: composite ? 'composite' : single.project_type,
    project_label: composite ? `Composite scope — ${sectionMeta.length} sections` : single.label,
    source_type: 'scope',
    sections: sectionMeta,
    materials: mergedMaterials,
    fixtures_checklist: { plumbing, electrical },
    derived_by_section: derivedBySection,
    field_verify_items: mergedMaterials.filter(m => m.field_verify).map(m => m.key),
    budget_total: posNumOrNull(body.budget_total),
    budget_sections: Array.isArray(body.budget_sections) ? body.budget_sections : undefined,
    location: (body.location && typeof body.location === 'object') ? body.location : undefined,
    summary: composite
      ? `${sectionMeta.length}-section scope: ${sectionMeta.map(m => m.project_type).join(', ')}`
      : single.summary,
    disclaimer: (dataset && dataset._meta && dataset._meta.disclaimer) || undefined,
    // INTERNAL: the full per-section takeoffs, used by priceScopeTakeoff. The server strips
    // this key before sending the response (it would just duplicate `materials`).
    section_takeoffs: sectionTakeoffs,
  };
}

/**
 * Build a takeoff FROM A PROPOSAL (U6 / U7). The extraction provider (LLM or the
 * deterministic heuristic) turns free-text markdown into the from-scope shape; we then run
 * the SAME deterministic aggregator. Every material line inherits its section's
 * `source_quote` + `confidence` (passthrough lines keep their own), and the raw
 * `extracted_scope` is echoed back so BuildSuite can show provenance.
 *
 * Async because extraction may hit an LLM. Never throws. Degrades cleanly:
 *   - no scope found            -> { ok:false, error:'no_scope_extracted', source_type:'proposal' }
 *   - extracted an invalid scope -> the aggregator's ok:false, with extracted_scope attached
 */
async function buildProposalTakeoff(body, dataset, provider) {
  const ex = await provider.extract({
    proposal_markdown: body && body.proposal_markdown,
    budget_total: body && body.budget_total,
    budget_sections: body && body.budget_sections,
    project_type_hint: body && body.project_type,
  });

  if (!ex || !ex.ok) {
    // U7: "no scope extracted" is a clean ok:false the caller can act on — NOT a crash.
    return {
      ok: false, source_type: 'proposal',
      error: (ex && ex.reason) || 'no_scope_extracted',
      message: 'Could not extract a build scope from the proposal. Add clearer scope (rooms, areas) or POST /from-scope directly.',
      extraction_source: ex && ex.source,
      extracted_scope: { sections: [], notes: (ex && ex.notes) || [] },
    };
  }

  const scope = buildScopeTakeoff({
    sections: ex.extracted_scope.sections,
    budget_total: body && body.budget_total,
    budget_sections: body && body.budget_sections,
    location: body && body.location,
  }, dataset);

  if (!scope.ok) {
    return { ...scope, source_type: 'proposal', extraction_source: ex.source, extracted_scope: ex.extracted_scope };
  }

  // Align the extracted sections to the generated section ids, and stamp source_quote +
  // confidence onto every material line (a passthrough line keeps the ones it already has).
  const exBySid = {};
  scope.sections.forEach((meta, i) => {
    const exSec = ex.extracted_scope.sections[i] || {};
    exSec.id = meta.section_id;               // scope-level id (BuildSuite reads .id)
    exSec.section_id = meta.section_id;       // keep the existing key too (additive)
    if (exSec.area_sqft == null && exSec.inputs) {
      const areaKey = Object.keys(exSec.inputs).find(k => /sqft$/i.test(k));
      if (areaKey) exSec.area_sqft = exSec.inputs[areaKey];
    }
    exBySid[meta.section_id] = exSec;
  });
  scope.materials = scope.materials.map(m => {
    const exSec = exBySid[m.section_id] || {};
    return {
      ...m,
      source_quote: m.source_quote != null ? m.source_quote : (exSec.source_quote || null),
      confidence: m.confidence != null ? m.confidence : (exSec.confidence || null),
    };
  });

  scope.source_type = 'proposal';
  scope.extraction_source = ex.source;
  scope.extraction_cached = !!ex.cached;
  scope.extracted_scope = ex.extracted_scope;
  return scope;
}

module.exports = { buildScopeTakeoff, buildProposalTakeoff, addOnsToToggles, slugify, ADDON_TOGGLES };
