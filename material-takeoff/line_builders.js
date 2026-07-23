/**
 * Material Takeoff — shared line-item builders + helpers
 * ------------------------------------------------------
 * Project-type-agnostic building blocks used by every per-project builder
 * (builders/kitchen_remodel.js, builders/bathroom_remodel.js, …). Each builder
 * returns a fully self-describing material line: the raw measurement, the transparency
 * of the math (waste % or coverage rate), and the final order quantity. Zero deps.
 */

// ─── number helpers ──────────────────────────────────────────────────────────
const round1 = n => Math.round(n * 10) / 10;       // 1 decimal for raw/measured values
const ceil   = n => Math.ceil(n - 1e-9);           // whole units (bags, sheets, sqft to buy)
const isPosNum = v => Number.isFinite(Number(v)) && Number(v) > 0;

// ─── line-item builders ──────────────────────────────────────────────────────

// Made-to-measure (cabinets, vanities): raw == order, no blind waste, field-verify.
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

// Waste-factor item (countertop, tile, drywall/backer area): order = raw * (1 + waste).
// opts.wholeUnits rounds up (e.g. sheets); opts.orderUnit overrides the order unit;
// opts.perUnitSqft divides the ordered area into whole units (e.g. backer-board sheets);
// opts.pack = { size, unit } rounds the ordered area into whole vendor PACKS (tile boxes,
//   countertop slabs) -> a `pack_round` line that also reports the covered area + pack size,
//   so pricing can multiply per-BOX/SLAB price instead of per-sqft.
function wasteFactorLine(key, label, raw, unit, wastePct, basis, opts = {}) {
  const ordered = raw * (1 + wastePct);

  // Pack rounding: order in whole boxes/slabs when a pack size is known.
  if (opts.pack && isPosNum(opts.pack.size)) {
    const packUnit = opts.pack.unit || 'box';
    return {
      key, label, type: 'pack_round',
      raw: round1(raw), raw_unit: unit,
      waste_pct: Math.round(wastePct * 100),
      covered_qty: round1(ordered), covered_unit: unit,     // area incl. waste that the packs cover
      pack_size: opts.pack.size, pack_unit: packUnit,       // e.g. 15.5 sqft per box
      order_qty: ceil(ordered / opts.pack.size),            // whole packs to buy
      order_unit: packUnit,
      field_verify: !!opts.fieldVerify,
      basis, note: opts.note,
    };
  }

  let orderQty, orderUnit;
  if (opts.perUnitSqft) {                 // convert ordered area -> whole panels/sheets
    orderQty = ceil(ordered / opts.perUnitSqft);
    orderUnit = opts.orderUnit || unit;
  } else {
    orderQty = opts.wholeUnits ? ceil(ordered) : round1(ordered);
    orderUnit = opts.orderUnit || unit;
  }
  return {
    key, label, type: 'waste_factor',
    raw: round1(raw), raw_unit: unit,
    waste_pct: Math.round(wastePct * 100),
    order_qty: orderQty, order_unit: orderUnit,
    field_verify: !!opts.fieldVerify,
    basis,
    note: opts.note,
  };
}

// Coverage / consumable item (thinset, grout, compound, tape, screws, membrane): the
// buffer is baked into a deliberately conservative coverage rate, not a waste %.
// Order = whole units to cover the raw driver.
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
 * Resolve a fixtures template (plumbing/electrical rough-in) into concrete quantities.
 * Generic over any `qty_per_<driver>` key: it multiplies by ctx[<driver>] (snake_case),
 * so a builder just passes the drivers it has (e.g. { base_lf, upper_lf, vanity_lf }).
 *   - entry.qty            -> fixed count
 *   - entry.qty_per_circuit_ft -> circuit_count * rate (footage estimate; flagged est.)
 *   - entry.qty_per_<x>    -> max(qty_min||0, ceil(ctx[x] * rate))
 * circuit_count is derived here from the electrical lines whose unit === 'circuit'.
 */
function buildFixtures(template, ctx = {}) {
  const circuitCount = (template.electrical || [])
    .filter(e => e.unit === 'circuit')
    .reduce((sum, e) => sum + (e.qty != null ? e.qty : 0), 0);
  const c = { ...ctx, circuit_count: circuitCount };

  const resolve = (entry) => {
    const out = { item: entry.item, unit: entry.unit, note: entry.note };
    if (entry.qty != null) { out.qty = entry.qty; return out; }

    const perKey = Object.keys(entry).find(k => k.startsWith('qty_per_'));
    if (perKey) {
      const rate = entry[perKey];
      if (perKey === 'qty_per_circuit_ft') {
        out.qty = c.circuit_count != null ? c.circuit_count * rate : rate;
        out.estimate = true;
      } else {
        const driver = perKey.slice('qty_per_'.length);   // e.g. base_lf, upper_lf, vanity_lf
        const driverVal = c[driver];
        out.qty = Math.max(entry.qty_min || 0, driverVal != null ? ceil(driverVal * rate) : (entry.qty_min || 0));
      }
    }
    return out;
  };

  return {
    plumbing: (template.plumbing || []).map(resolve),
    electrical: (template.electrical || []).map(resolve),
  };
}

module.exports = {
  round1, ceil, isPosNum,
  madeToMeasureLine, wasteFactorLine, coverageLine, buildFixtures,
};
