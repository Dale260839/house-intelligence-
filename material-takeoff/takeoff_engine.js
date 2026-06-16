/**
 * Material Takeoff — Lookup Engine
 * --------------------------------
 * Sibling to House Intelligence's lookup_engine.js, same shape (a JSON dataset of
 * rules + a deterministic, dependency-free, unit-tested lookup engine) pointed at a
 * different question:
 *
 *   House Intelligence:  property -> what to INSPECT (era-based hazards)
 *   Material Takeoff:    project scope + size -> what to BUY (a quantified order list)
 *
 * Input:  a project type (v1: "kitchen_remodel") + the kitchen's square footage, plus
 *         optional known measurements (ceiling height, cabinet LF, countertop sqft,
 *         tile layout, floor-tile yes/no, openings, ...).
 * Output: an ORDER-READY material list whose quantities already include standard waste
 *         factors, WHILE ALSO reporting each line's raw measurement + waste % (or
 *         coverage rate) so the math is transparent and auditable, plus a plumbing /
 *         electrical rough-in checklist.
 *
 * Design intent (matches the spec): tell a contractor exactly what to order — no waste,
 * no shortage — as a STARTING POINT, never a substitute for field measurement. Cabinets
 * and countertops are made-to-measure and always flagged "field-verify".
 *
 * IMPORTANT: output is an estimate to order against, not a guarantee of jobsite reality.
 */

const fs = require('fs');
const path = require('path');

function loadDataset(datasetPath) {
  const p = datasetPath || path.join(__dirname, 'material_dataset.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── number helpers ──────────────────────────────────────────────────────────
const round1 = n => Math.round(n * 10) / 10;       // 1 decimal for raw/measured values
const ceil   = n => Math.ceil(n - 1e-9);           // whole units (bags, sheets, sqft to buy)
const isPosNum = v => Number.isFinite(Number(v)) && Number(v) > 0;

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

// ─── line-item builders ──────────────────────────────────────────────────────
// Each builder returns a fully self-describing line: the raw measurement, the
// transparency of the math (waste % or coverage), and the final order quantity.

// Made-to-measure (cabinets): raw == order, no blind waste, must be field-verified.
function madeToMeasureLine(key, label, rawLF, basis, note) {
  return {
    key, label, type: 'made_to_measure',
    raw: round1(rawLF), raw_unit: 'LF',
    waste_pct: 0,
    order_qty: round1(rawLF), order_unit: 'LF',
    field_verify: true,
    basis, note,
  };
}

// Waste-factor item (countertop, tile, drywall area): order = raw * (1 + waste).
function wasteFactorLine(key, label, raw, unit, wastePct, basis, opts = {}) {
  const ordered = raw * (1 + wastePct);
  return {
    key, label, type: 'waste_factor',
    raw: round1(raw), raw_unit: unit,
    waste_pct: Math.round(wastePct * 100),
    order_qty: opts.wholeUnits ? ceil(ordered) : round1(ordered),
    order_unit: unit,
    field_verify: !!opts.fieldVerify,
    basis,
    note: opts.note,
  };
}

// Coverage / consumable item (thinset, grout, compound, tape, screws): the buffer is
// baked into a deliberately conservative coverage rate, not a waste %. Order = whole
// units to cover the raw driver.
function coverageLine(key, label, rawDriver, driverUnit, coverage, coverageUnit, orderUnit, basis, note) {
  const units = ceil(rawDriver / coverage);
  return {
    key, label, type: 'coverage',
    raw: round1(rawDriver), raw_unit: driverUnit,
    coverage, coverage_unit: coverageUnit,
    order_qty: units, order_unit: orderUnit,
    waste_pct: null,
    basis, note,
  };
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
  if (!def) {
    return { ok: false, error: 'unsupported_project_type',
      message: `Unsupported projectType "${pt}". Supported: ${ds._meta.supported_project_types.join(', ')}.` };
  }

  const { values: v, errors } = resolveInputs(input, def);
  if (errors.length) {
    return { ok: false, error: 'invalid_input', message: errors.join('; '), fields: errors };
  }

  const g = def.geometry;
  const r = def.rates;

  // ── derive cabinet linear feet (calibrated to floor area, not perimeter) ──
  const totalLF = isPosNum(v.cabinetLF) ? v.cabinetLF : v.kitchenSqft * g.cabinet_lf_per_sqft;
  const baseLF  = isPosNum(v.baseCabinetLF)  ? v.baseCabinetLF  : totalLF * g.base_share;
  const upperLF = isPosNum(v.upperCabinetLF) ? v.upperCabinetLF : totalLF * g.upper_share;

  // ── geometry: wall perimeter + areas ──
  const perimeter = isPosNum(v.wallPerimeterLF) ? v.wallPerimeterLF : 4 * Math.sqrt(v.kitchenSqft);
  const grossWall = perimeter * v.ceilingHeight;
  const ceilingArea = v.includeCeiling ? v.kitchenSqft : 0;
  const wallArea = Math.max(0, grossWall - v.openings * g.opening_deduct_sqft) + ceilingArea;

  // ── tile areas ──
  const backsplashRaw = (v.backsplashHeight > 0) ? baseLF * (v.backsplashHeight / 12) : 0;
  const floorRaw = v.floorTile ? v.kitchenSqft : 0;
  const tiledSubstrate = backsplashRaw + floorRaw;            // area thinset/grout cover
  const tileWaste = r.tile.waste_by_layout[v.tileLayout];

  const materials = [];

  // Cabinets — made-to-measure, no waste factor, field-verify.
  materials.push(madeToMeasureLine('base_cabinets', 'Base cabinets', baseLF,
    isPosNum(v.cabinetLF) || isPosNum(v.baseCabinetLF) ? 'provided' : `${g.cabinet_lf_per_sqft} LF/sqft total x ${g.base_share * 100}% base`,
    r.cabinets.note));
  materials.push(madeToMeasureLine('upper_cabinets', 'Upper cabinets', upperLF,
    isPosNum(v.cabinetLF) || isPosNum(v.upperCabinetLF) ? 'provided' : `${g.cabinet_lf_per_sqft} LF/sqft total x ${g.upper_share * 100}% upper`,
    r.cabinets.note));

  // Countertop — finished sqft from base run; slab order adds cutting waste. Field-verify.
  const counterFinished = isPosNum(v.countertopSqft) ? v.countertopSqft : baseLF * r.countertop.sqft_per_base_lf;
  const counterWaste = v.countertopType === 'veined' ? r.countertop.waste_pct_veined : r.countertop.waste_pct_solid;
  materials.push(wasteFactorLine('countertop', `Countertop slab (${v.countertopType})`, counterFinished, 'sqft', counterWaste,
    isPosNum(v.countertopSqft) ? 'provided finished sqft' : `${r.countertop.sqft_per_base_lf} sqft per base LF (${round1(baseLF)} LF)`,
    { wholeUnits: true, fieldVerify: true, note: r.countertop.note }));

  // Backsplash tile.
  if (backsplashRaw > 0) {
    materials.push(wasteFactorLine('backsplash_tile', 'Backsplash tile', backsplashRaw, 'sqft', tileWaste,
      `${round1(baseLF)} base LF x ${v.backsplashHeight}in high (${v.tileLayout} layout)`,
      { wholeUnits: true, note: r.tile.waste_note }));
  }

  // Floor tile.
  if (floorRaw > 0) {
    materials.push(wasteFactorLine('floor_tile', 'Floor tile', floorRaw, 'sqft', tileWaste,
      `floor area (${v.tileLayout} layout)`,
      { wholeUnits: true, note: r.tile.waste_note }));
  }

  // Thinset + grout — sized to the actual tiled substrate (raw, pre-tile-waste).
  if (tiledSubstrate > 0) {
    materials.push(coverageLine('thinset', 'Thinset mortar', tiledSubstrate, 'sqft',
      r.thinset.coverage_sqft_per_bag, 'sqft/bag', `${r.thinset.bag_lb} lb bag`,
      `backsplash ${round1(backsplashRaw)} + floor ${round1(floorRaw)} sqft set`, r.thinset.note));

    const groutCov = v.tileLayout === 'mosaic'
      ? r.grout.coverage_sqft_per_bag_small_tile
      : r.grout.coverage_sqft_per_bag;
    materials.push(coverageLine('grout', 'Grout', tiledSubstrate, 'sqft',
      groutCov, 'sqft/bag', `${r.grout.bag_lb} lb bag`,
      `tiled area (${v.tileLayout})`, r.grout.note));
  }

  // Drywall sheets — wall area with kitchen waste, then 4x8 sheets.
  if (wallArea > 0) {
    const dwOrderedArea = wallArea * (1 + r.drywall.waste_pct);
    materials.push({
      key: 'drywall_sheets', label: 'Drywall (4x8 sheets)', type: 'waste_factor',
      raw: round1(wallArea), raw_unit: 'sqft',
      waste_pct: Math.round(r.drywall.waste_pct * 100),
      order_qty: ceil(dwOrderedArea / r.drywall.sheet_sqft), order_unit: 'sheet',
      basis: `perimeter ${round1(perimeter)} LF x ${v.ceilingHeight} ft - ${v.openings} openings${v.includeCeiling ? ' + ceiling' : ''}, /${r.drywall.sheet_sqft} sqft/sheet`,
      note: r.drywall.note,
    });

    // Joint compound, tape, screws scale with the drywall surface.
    const jcLb = wallArea / 100 * r.joint_compound.lb_per_100sqft;
    materials.push(coverageLine('joint_compound', 'Joint compound', jcLb, 'lb',
      r.joint_compound.bucket_lb, 'lb/bucket', '4.5-gal bucket',
      `${r.joint_compound.lb_per_100sqft} lb per 100 sqft of wall`, r.joint_compound.note));

    const tapeLF = wallArea / r.drywall_tape.sqft_per_lf;
    materials.push(coverageLine('drywall_tape', 'Drywall joint tape', tapeLF, 'LF',
      r.drywall_tape.roll_lf, 'LF/roll', `${r.drywall_tape.roll_lf} ft roll`,
      `wall area / ${r.drywall_tape.sqft_per_lf} sqft per LF of tape`, r.drywall_tape.note));

    const sheets = ceil(dwOrderedArea / r.drywall.sheet_sqft);
    const screwCount = sheets * r.drywall_screws.per_sheet;
    materials.push(coverageLine('drywall_screws', 'Drywall screws', screwCount, 'screws',
      r.drywall_screws.per_box, 'screws/box', '1 lb box',
      `${sheets} sheets x ${r.drywall_screws.per_sheet} screws/sheet`, r.drywall_screws.note));
  }

  // ── fixtures / rough-in checklist ──
  const fixtures = buildFixtures(def.fixtures, { baseLF, upperLF });

  const orderCount = materials.length;
  const fieldVerifyKeys = materials.filter(m => m.field_verify).map(m => m.key);

  return {
    ok: true,
    project_type: pt,
    project_label: def.label,
    inputs: {
      kitchenSqft: v.kitchenSqft,
      ceilingHeight: v.ceilingHeight,
      tileLayout: v.tileLayout,
      floorTile: v.floorTile,
      countertopType: v.countertopType,
      backsplashHeight: v.backsplashHeight,
      openings: v.openings,
      includeCeiling: v.includeCeiling,
      cabinetLF: v.cabinetLF, baseCabinetLF: v.baseCabinetLF, upperCabinetLF: v.upperCabinetLF,
      countertopSqft: v.countertopSqft, wallPerimeterLF: v.wallPerimeterLF,
    },
    derived: {
      total_cabinet_lf: round1(totalLF),
      base_cabinet_lf: round1(baseLF),
      upper_cabinet_lf: round1(upperLF),
      wall_perimeter_lf: round1(perimeter),
      wall_area_sqft: round1(wallArea),
      backsplash_sqft: round1(backsplashRaw),
      floor_tile_sqft: round1(floorRaw),
      tiled_substrate_sqft: round1(tiledSubstrate),
      countertop_finished_sqft: round1(counterFinished),
    },
    materials,
    fixtures_checklist: fixtures,
    summary: takeoffSummary(def, v, orderCount, fixtures),
    field_verify_items: fieldVerifyKeys,
    disclaimer: ds._meta.disclaimer,
  };
}

// Resolve the fixtures template into concrete quantities (some scale with cabinet LF).
function buildFixtures(template, ctx) {
  const resolve = (entry) => {
    const out = { item: entry.item, unit: entry.unit, note: entry.note };
    if (entry.qty != null) {
      out.qty = entry.qty;
    } else if (entry.qty_per_base_lf != null) {
      out.qty = Math.max(entry.qty_min || 0, ceil(ctx.baseLF * entry.qty_per_base_lf));
    } else if (entry.qty_per_upper_lf != null) {
      out.qty = ceil(ctx.upperLF * entry.qty_per_upper_lf);
    } else if (entry.qty_per_circuit_ft != null) {
      // Estimate total NM run from the number of circuits in this checklist.
      out.qty = ctx._circuitCount != null ? ctx._circuitCount * entry.qty_per_circuit_ft : entry.qty_per_circuit_ft;
      out.estimate = true;
    }
    return out;
  };

  // Count circuits first so the Romex line can estimate total footage.
  const circuitCount = (template.electrical || [])
    .filter(e => e.unit === 'circuit')
    .reduce((sum, e) => sum + (e.qty != null ? e.qty : 0), 0);
  ctx._circuitCount = circuitCount;

  return {
    plumbing: (template.plumbing || []).map(resolve),
    electrical: (template.electrical || []).map(resolve),
  };
}

function takeoffSummary(def, v, orderCount, fixtures) {
  const fx = (fixtures.plumbing.length + fixtures.electrical.length);
  return `${def.label} — ${v.kitchenSqft} sqft: ${orderCount} material line${orderCount === 1 ? '' : 's'} quantified (order-ready, waste included) plus a ${fx}-item plumbing/electrical rough-in checklist. Cabinets & countertops are made-to-measure — field-verify before ordering.`;
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
  lines.push(`MATERIAL TAKEOFF — ${t.project_label.toUpperCase()}  (${t.inputs.kitchenSqft} sqft)`);
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
