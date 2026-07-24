/**
 * Builder — flooring_only
 * -----------------------
 * A flooring-only job: cover a floor area with one material and everything that goes
 * under and around it. What gets added is driven by `flooringType`:
 *
 *   tile              -> cement backer board + thinset + grout
 *   lvp / laminate    -> foam / moisture-barrier underlayment (floating install)
 *   engineered / hardwood -> underlayment + fasteners (nail-down)
 *
 * Plus transition strips per doorway, and the shared optional add-ons (demolition,
 * subfloor, baseboard trim). There is no plumbing/electrical rough-in for a floor, so
 * the fixtures checklist is intentionally empty.
 */
const {
  round1, ceil, isPosNum,
  wasteFactorLine, coverageLine, buildFixtures,
} = require('../line_builders.js');
const { buildAddonLines } = require('./addons.js');

function build(v, def) {
  const g = def.geometry;
  const r = def.rates;
  const type = v.flooringType;

  // Perimeter is only needed by the optional baseboard add-on.
  const shapeFactor = (g.perimeter_factor_by_shape && g.perimeter_factor_by_shape[v.roomShape]) || 4;
  const perimeter = isPosNum(v.wallPerimeterLF) ? v.wallPerimeterLF : shapeFactor * Math.sqrt(v.floorSqft);

  const area = v.floorSqft;
  const waste = r.flooring.waste_by_layout[v.tileLayout];
  const materials = [];

  // ── the flooring itself ──
  // Key is per-type (flooring_tile, flooring_lvp, …) so pricing can search the right
  // product for each material rather than one generic "flooring" term.
  const pack = isPosNum(v.flooringBoxSqft) ? { size: v.flooringBoxSqft, unit: 'box' } : null;
  materials.push(wasteFactorLine(`flooring_${type}`, r.flooring.labels[type], area, 'sqft', waste,
    `floor area ${round1(area)} sqft (${v.tileLayout} layout)`,
    { wholeUnits: true, note: r.flooring.waste_note, pack }));

  // ── underlayment (type-aware: backer board for tile, foam/rosin otherwise) ──
  const u = r.underlayment_by_type[type];
  if (v.includeUnderlayment && u) {
    materials.push(wasteFactorLine(u.key, u.label, area, 'sqft', u.waste_pct,
      `floor area ${round1(area)} sqft, /${u.unit_sqft} sqft per ${u.order_unit}`,
      { perUnitSqft: u.unit_sqft, orderUnit: u.order_unit, note: u.note }));
  }

  // ── setting materials, by type ──
  const setting = r.setting_by_type[type] || [];

  if (setting.includes('thinset')) {
    materials.push(coverageLine('thinset', 'Thinset mortar', area, 'sqft',
      r.thinset.coverage_sqft_per_bag, 'sqft/bag', `${r.thinset.bag_lb} lb bag`,
      `floor area ${round1(area)} sqft set`, r.thinset.note));
  }
  if (setting.includes('grout')) {
    const groutCov = v.tileLayout === 'mosaic'
      ? r.grout.coverage_sqft_per_bag_small_tile
      : r.grout.coverage_sqft_per_bag;
    materials.push(coverageLine('grout', 'Grout', area, 'sqft',
      groutCov, 'sqft/bag', `${r.grout.bag_lb} lb bag`,
      `tiled area (${v.tileLayout})`, r.grout.note));
  }
  if (setting.includes('fasteners')) {
    materials.push(coverageLine('fasteners', 'Flooring cleats / staples', area, 'sqft',
      r.fasteners.coverage_sqft_per_box, 'sqft/box', r.fasteners.order_unit,
      `nail-down install over ${round1(area)} sqft`, r.fasteners.note));
  }

  // ── transition strips (one per doorway) ──
  if (v.includeTransitions && v.openings > 0) {
    materials.push(wasteFactorLine('transitions', 'Transition strips', v.openings, 'ea', 0,
      `${v.openings} doorway/opening${v.openings === 1 ? '' : 's'}`,
      { wholeUnits: true, orderUnit: r.transitions.order_unit, note: r.transitions.note }));
  }

  // ── optional add-on groups (demolition / subfloor / trim) ──
  // paintArea + hardwareLF are 0: a flooring job has no walls to paint or cabinets.
  materials.push(...buildAddonLines(v, r.addons, {
    floorSqft: area,
    paintArea: 0,
    perimeter,
    hardwareLF: 0,
    openings: v.openings,
  }));

  // No plumbing/electrical rough-in on a flooring-only job.
  const fixtures_checklist = buildFixtures(def.fixtures, {});

  const orderCount = materials.length;
  const summary = `${def.label} - ${area} sqft of ${r.flooring.labels[type].toLowerCase()} (${v.tileLayout} layout): ${orderCount} material line${orderCount === 1 ? '' : 's'} quantified (order-ready, waste included). No plumbing/electrical rough-in on a flooring-only job.`;

  return {
    derived: {
      floor_area_sqft: round1(area),
      flooring_type: type,
      waste_pct: Math.round(waste * 100),
      wall_perimeter_lf: round1(perimeter),
      transitions_count: v.includeTransitions ? v.openings : 0,
    },
    materials,
    fixtures_checklist,
    summary,
  };
}

module.exports = { id: 'flooring_only', build };
