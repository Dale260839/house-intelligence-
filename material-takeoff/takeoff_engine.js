/**
 * Material Takeoff — Lookup Engine (dispatcher)
 * ---------------------------------------------
 * Sibling to House Intelligence's lookup_engine.js: a JSON dataset of rules + a
 * deterministic, dependency-free, unit-tested engine, pointed at "what to BUY".
 *
 *   project scope + size  ->  an ORDER-READY material list (quantities already include
 *   standard waste factors, and each line reports its raw measurement + waste %/coverage
 *   so the math is auditable) + a plumbing/electrical rough-in checklist.
 *
 * Each project type plugs in as its own BUILDER module (builders/<type>.js). This engine
 * validates input against the dataset's per-type `inputs` spec, then dispatches to the
 * matching builder and wraps its output in a standard response envelope. Adding a project
 * type = a dataset block + a builder module; no change to this dispatcher.
 *
 * IMPORTANT: output is an estimate to order against, not a guarantee of jobsite reality.
 */

const fs = require('fs');
const path = require('path');

// ─── builder registry ─────────────────────────────────────────────────────────
// Maps projectType -> a module exporting build(v, def, ds) -> { derived, materials,
// fixtures_checklist, summary }. To add a type: add a dataset block + a builder here.
const BUILDERS = {
  kitchen_remodel: require('./builders/kitchen_remodel.js'),
  bathroom_remodel: require('./builders/bathroom_remodel.js'),
};

function loadDataset(datasetPath) {
  const p = datasetPath || path.join(__dirname, 'material_dataset.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── input validation + defaulting ───────────────────────────────────────────
// Drives both buildTakeoff() and the GET /project-types form contract from the same
// `inputs` spec in the dataset, so the API and the engine can never drift apart.
function resolveInputs(rawInput, projectDef) {
  const out = {};
  const errors = [];

  for (const spec of projectDef.inputs) {
    let v = rawInput[spec.name];
    const missing = v === undefined || v === null || v === '';

    if (missing) {
      if (spec.required) { errors.push(`Missing required field "${spec.name}" (${spec.description})`); continue; }
      out[spec.name] = spec.default !== undefined ? spec.default : null;
      continue;
    }

    if (spec.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`Field "${spec.name}" must be a number, got "${v}"`); continue; }
      if (spec.min !== undefined && n < spec.min) { errors.push(`Field "${spec.name}" must be >= ${spec.min}, got ${n}`); continue; }
      out[spec.name] = n;
    } else if (spec.type === 'boolean') {
      out[spec.name] = (v === true || v === 'true' || v === 1 || v === '1');
    } else if (spec.type === 'enum') {
      const s = String(v).toLowerCase();
      if (!spec.allowed.includes(s)) { errors.push(`Field "${spec.name}" must be one of ${spec.allowed.join(', ')}, got "${v}"`); continue; }
      out[spec.name] = s;
    } else {
      out[spec.name] = v;
    }
  }

  return { values: out, errors };
}

/**
 * Build the full material takeoff for a project type + measurements.
 * Returns { ok:true, ... } on success, or { ok:false, error, message } on bad input
 * (the server maps ok:false to HTTP 400).
 */
function buildTakeoff(input, dataset) {
  const ds = dataset || loadDataset();
  const pt = String(input && input.projectType || '').trim();

  if (!pt) {
    return { ok: false, error: 'missing_project_type',
      message: `Provide "projectType". Supported: ${ds._meta.supported_project_types.join(', ')}.` };
  }
  const def = ds.project_types[pt];
  const builder = BUILDERS[pt];
  if (!def || !builder) {
    return { ok: false, error: 'unsupported_project_type',
      message: `Unsupported projectType "${pt}". Supported: ${ds._meta.supported_project_types.join(', ')}.` };
  }

  const { values: v, errors } = resolveInputs(input, def);
  if (errors.length) {
    return { ok: false, error: 'invalid_input', message: errors.join('; '), fields: errors };
  }

  // Dispatch the quantity derivation to the project's builder.
  const result = builder.build(v, def, ds);
  const fieldVerifyKeys = result.materials.filter(m => m.field_verify).map(m => m.key);

  return {
    ok: true,
    project_type: pt,
    project_label: def.label,
    inputs: v,                          // resolved inputs (defaults applied)
    derived: result.derived,
    materials: result.materials,
    fixtures_checklist: result.fixtures_checklist,
    summary: result.summary,
    field_verify_items: fieldVerifyKeys,
    disclaimer: ds._meta.disclaimer,
  };
}

/** The supported project types + their input form contract (for GET /project-types). */
function getProjectTypes(dataset) {
  const ds = dataset || loadDataset();
  return ds._meta.supported_project_types.map(id => {
    const def = ds.project_types[id];
    const required = def.inputs.filter(i => i.required);
    const optional = def.inputs.filter(i => !i.required);
    const shape = (i) => {
      const o = { name: i.name, type: i.type, description: i.description };
      if (i.unit) o.unit = i.unit;
      if (i.allowed) o.allowed = i.allowed;
      if (i.min !== undefined) o.min = i.min;
      if (!i.required) o.default = i.default;
      return o;
    };
    return {
      id, label: def.label, summary: def.summary,
      required_inputs: required.map(shape),
      optional_inputs: optional.map(shape),
    };
  });
}

const COL = { made_to_measure: '~', waste_factor: '+', coverage: '=' };

/** Render a human-readable takeoff block (for an email, proposal, or the CLI). */
function renderTakeoffText(t) {
  if (!t.ok) return t.message;
  const lines = [];
  lines.push(`MATERIAL TAKEOFF - ${t.project_label.toUpperCase()}`);
  lines.push(t.summary);
  lines.push('');
  lines.push('ORDER LIST (raw  ->  +waste% / coverage  ->  ORDER):');
  for (const m of t.materials) {
    const tag = COL[m.type] || ' ';
    let math;
    if (m.type === 'made_to_measure') math = `${m.raw} ${m.raw_unit} (made-to-measure, no waste)`;
    else if (m.type === 'waste_factor') math = `${m.raw} ${m.raw_unit} +${m.waste_pct}%`;
    else math = `${m.raw} ${m.raw_unit} @ ${m.coverage} ${m.coverage_unit}`;
    const fv = m.field_verify ? '  [FIELD-VERIFY]' : '';
    const orderQty = m.type === 'coverage' ? `${m.order_qty} x ${m.order_unit}` : `${m.order_qty} ${m.order_unit}`;
    lines.push(`  ${tag} ${m.label}: ${math}  ->  ORDER ${orderQty}${fv}`);
  }
  lines.push('');
  lines.push('PLUMBING / ROUGH-IN CHECKLIST:');
  for (const f of t.fixtures_checklist.plumbing) lines.push(`  - ${f.item}: ${f.qty} ${f.unit}`);
  lines.push('ELECTRICAL / ROUGH-IN CHECKLIST:');
  for (const f of t.fixtures_checklist.electrical) lines.push(`  - ${f.item}: ${f.qty} ${f.unit}${f.estimate ? ' (est.)' : ''}`);
  lines.push('');
  lines.push('Note: ' + t.disclaimer);
  return lines.join('\n');
}

module.exports = {
  loadDataset, buildTakeoff, getProjectTypes, renderTakeoffText, resolveInputs,
};

// ---- CLI usage ----
//   node takeoff_engine.js 200                 kitchen_remodel, 200 sqft (defaults)
//   node takeoff_engine.js 200 --json          same, as JSON
//   node takeoff_engine.js --types             list supported project types
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--types') {
    console.log(JSON.stringify(getProjectTypes(), null, 2));
    process.exit(0);
  }
  const sqft = Number(args[0]);
  if (!Number.isFinite(sqft)) {
    console.log('Usage:');
    console.log('  node takeoff_engine.js <kitchenSqft> [--json]   kitchen_remodel takeoff');
    console.log('  node takeoff_engine.js --types                  list project types');
    process.exit(0);
  }
  const takeoff = buildTakeoff({ projectType: 'kitchen_remodel', kitchenSqft: sqft });
  if (args.includes('--json')) console.log(JSON.stringify(takeoff, null, 2));
  else console.log(renderTakeoffText(takeoff));
}
