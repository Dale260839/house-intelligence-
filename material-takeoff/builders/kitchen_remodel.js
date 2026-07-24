/**
 * Builder — kitchen_remodel
 * -------------------------
 * The kitchen quantity derivation, extracted verbatim from the original engine so
 * buildTakeoff() can dispatch by project type. Consumes resolved inputs `v` + the
 * project `def` (geometry + rates), returns the computed parts; the engine wraps them
 * in the standard response envelope.
 */
const {
  round1, isPosNum, ceil,
  madeToMeasureLine, wasteFactorLine, coverageLine, buildFixtures,
} = require('../line_builders.js');
const { buildAddonLines } = require('./addons.js');

function build(v, def) {
  const g = def.geometry;
  const r = def.rates;

  // ── derive cabinet linear feet (calibrated to floor area, not perimeter) ──
  // An island adds a cabinet/counter run when roomShape is 'island' (unless cabinetLF given).
  let derivedTotalLF = v.kitchenSqft * g.cabinet_lf_per_sqft;
  if (v.roomShape === 'island' && g.island_cabinet_factor) derivedTotalLF *= g.island_cabinet_factor;
  const totalLF = isPosNum(v.cabinetLF) ? v.cabinetLF : derivedTotalLF;
  const baseLF  = isPosNum(v.baseCabinetLF)  ? v.baseCabinetLF  : totalLF * g.base_share;
  const upperLF = isPosNum(v.upperCabinetLF) ? v.upperCabinetLF : totalLF * g.upper_share;

  // ── geometry: wall perimeter (shape-aware) + areas ──
  // Perimeter = shape factor * sqrt(area); 'square' (4.0) is the original model.
  // An exact wallPerimeterLF always wins.
  const shapeFactor = (g.perimeter_factor_by_shape && g.perimeter_factor_by_shape[v.roomShape]) || 4;
  const perimeter = isPosNum(v.wallPerimeterLF) ? v.wallPerimeterLF : shapeFactor * Math.sqrt(v.kitchenSqft);
  const grossWall = perimeter * v.ceilingHeight;
  const ceilingArea = v.includeCeiling ? v.kitchenSqft : 0;
  const wallArea = Math.max(0, grossWall - v.openings * g.opening_deduct_sqft) + ceilingArea;

  // ── tile areas + per-surface layout (Phase 3: floor and backsplash can differ) ──
  const backsplashLayout = v.backsplashTileLayout || v.tileLayout;
  const floorLayout = v.floorTileLayout || v.tileLayout;
  const backsplashRaw = (v.backsplashHeight > 0) ? baseLF * (v.backsplashHeight / 12) : 0;
  const floorRaw = v.floorTile ? v.kitchenSqft : 0;
  const tiledSubstrate = backsplashRaw + floorRaw;            // area thinset/grout cover

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
  // Slab rounding when the slab size is known (countertopSlabSqft) -> order in whole slabs.
  const counterPack = isPosNum(v.countertopSlabSqft) ? { size: v.countertopSlabSqft, unit: 'slab' } : null;
  materials.push(wasteFactorLine('countertop', `Countertop slab (${v.countertopType})`, counterFinished, 'sqft', counterWaste,
    isPosNum(v.countertopSqft) ? 'provided finished sqft' : `${r.countertop.sqft_per_base_lf} sqft per base LF (${round1(baseLF)} LF)`,
    { wholeUnits: true, fieldVerify: true, note: r.countertop.note, pack: counterPack }));

  // Backsplash tile (per-surface layout; round to boxes if backsplashTileBoxSqft given).
  if (backsplashRaw > 0) {
    const pack = isPosNum(v.backsplashTileBoxSqft) ? { size: v.backsplashTileBoxSqft, unit: 'box' } : null;
    materials.push(wasteFactorLine('backsplash_tile', 'Backsplash tile', backsplashRaw, 'sqft', r.tile.waste_by_layout[backsplashLayout],
      `${round1(baseLF)} base LF x ${v.backsplashHeight}in high (${backsplashLayout} layout)`,
      { wholeUnits: true, note: r.tile.waste_note, pack }));
  }

  // Floor tile (per-surface layout; round to boxes if floorTileBoxSqft given).
  if (floorRaw > 0) {
    const pack = isPosNum(v.floorTileBoxSqft) ? { size: v.floorTileBoxSqft, unit: 'box' } : null;
    materials.push(wasteFactorLine('floor_tile', 'Floor tile', floorRaw, 'sqft', r.tile.waste_by_layout[floorLayout],
      `floor area (${floorLayout} layout)`,
      { wholeUnits: true, note: r.tile.waste_note, pack }));
  }

  // Thinset + grout — sized to the actual tiled substrate (raw, pre-tile-waste).
  if (tiledSubstrate > 0) {
    materials.push(coverageLine('thinset', 'Thinset mortar', tiledSubstrate, 'sqft',
      r.thinset.coverage_sqft_per_bag, 'sqft/bag', `${r.thinset.bag_lb} lb bag`,
      `backsplash ${round1(backsplashRaw)} + floor ${round1(floorRaw)} sqft set`, r.thinset.note));

    const anyMosaic = floorLayout === 'mosaic' || backsplashLayout === 'mosaic';
    const groutCov = anyMosaic
      ? r.grout.coverage_sqft_per_bag_small_tile
      : r.grout.coverage_sqft_per_bag;
    materials.push(coverageLine('grout', 'Grout', tiledSubstrate, 'sqft',
      groutCov, 'sqft/bag', `${r.grout.bag_lb} lb bag`,
      `tiled area (floor ${floorLayout} / backsplash ${backsplashLayout})`, r.grout.note));
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

  // ── optional add-on groups (demolition, subfloor, paint, trim, hardware) ──
  // All off by default; each is switched on by its own include* input.
  materials.push(...buildAddonLines(v, r.addons, {
    floorSqft: v.kitchenSqft,
    paintArea: wallArea,
    perimeter,
    hardwareLF: baseLF + upperLF,
    openings: v.openings,
  }));

  // ── fixtures / rough-in checklist ──
  const fixtures_checklist = buildFixtures(def.fixtures, { base_lf: baseLF, upper_lf: upperLF });

  const orderCount = materials.length;
  const fx = fixtures_checklist.plumbing.length + fixtures_checklist.electrical.length;
  const summary = `${def.label} - ${v.kitchenSqft} sqft: ${orderCount} material line${orderCount === 1 ? '' : 's'} quantified (order-ready, waste included) plus a ${fx}-item plumbing/electrical rough-in checklist. Cabinets & countertops are made-to-measure - field-verify before ordering.`;

  return {
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
    fixtures_checklist,
    summary,
  };
}

module.exports = { id: 'kitchen_remodel', build };
