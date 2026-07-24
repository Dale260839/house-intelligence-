/**
 * Builder — bathroom_remodel
 * --------------------------
 * Quantity derivation for a bathroom remodel. Scope is configurable and defaults to a
 * full remodel; inputs toggle major line groups off:
 *   - showerType: 'none'      -> drops shower/tub surround tile, waterproofing, backer board
 *   - floorTile: false        -> drops floor tile
 *   - includeVanity: false    -> drops vanity + vanity top
 *   - includeWaterproofing:false -> drops the membrane (keeps tile/backer)
 *
 * Reuses the shared line builders (tile/thinset/grout/drywall are the same primitives as
 * the kitchen). Wet-zone walls get cement backer board + waterproofing instead of drywall.
 */
const {
  round1, isPosNum, ceil,
  madeToMeasureLine, wasteFactorLine, coverageLine, buildFixtures,
} = require('../line_builders.js');
const { buildAddonLines } = require('./addons.js');

function build(v, def) {
  const g = def.geometry;
  const r = def.rates;

  // ── geometry: wall perimeter (shape-aware) + areas ──
  // Perimeter = shape factor * sqrt(area); 'square' (4.0) is the original model. Exact
  // wallPerimeterLF always wins.
  const shapeFactor = (g.perimeter_factor_by_shape && g.perimeter_factor_by_shape[v.roomShape]) || 4;
  const perimeter = isPosNum(v.wallPerimeterLF) ? v.wallPerimeterLF : shapeFactor * Math.sqrt(v.bathroomSqft);
  const grossWall = perimeter * v.ceilingHeight;
  const ceilingArea = v.includeCeiling ? v.bathroomSqft : 0;
  const totalWallArea = Math.max(0, grossWall - v.openings * g.opening_deduct_sqft) + ceilingArea;

  // ── wet zone (shower / tub surround) ──
  const showerWall = v.showerType === 'none'
    ? 0
    : (isPosNum(v.showerWallSqft) ? v.showerWallSqft : (g.shower_wall_sqft_by_type[v.showerType] || 0));
  // Tile-set shower pan only for a walk-in shower (tubs come with their own base).
  const showerFloor = v.showerType === 'shower' ? (g.shower_floor_sqft || 0) : 0;

  // Dry walls (get drywall) = everything that isn't the tiled wet surround.
  const dryWallArea = Math.max(0, totalWallArea - showerWall);

  // ── tile areas ──
  const wainscotArea = v.wainscotHeight > 0 ? perimeter * (v.wainscotHeight / 12) : 0;
  const wallTileArea = showerWall + wainscotArea;             // wet surround + optional wainscot
  const floorArea = v.floorTile ? v.bathroomSqft : 0;
  const tiledSubstrate = wallTileArea + floorArea;            // area thinset/grout cover
  // Per-surface layout (Phase 3): floor and wall tile can differ; fall back to tileLayout.
  const floorLayout = v.floorTileLayout || v.tileLayout;
  const wallLayout = v.wallTileLayout || v.tileLayout;

  const materials = [];

  // Floor tile (per-surface layout; round to boxes if floorTileBoxSqft given).
  if (floorArea > 0) {
    const pack = isPosNum(v.floorTileBoxSqft) ? { size: v.floorTileBoxSqft, unit: 'box' } : null;
    materials.push(wasteFactorLine('floor_tile', 'Floor tile', floorArea, 'sqft', r.tile.waste_by_layout[floorLayout],
      `floor area (${floorLayout} layout)`, { wholeUnits: true, note: r.tile.waste_note, pack }));
  }

  // Wall tile — shower/tub surround (+ optional wainscot). Boxes if wallTileBoxSqft given.
  if (wallTileArea > 0) {
    const pack = isPosNum(v.wallTileBoxSqft) ? { size: v.wallTileBoxSqft, unit: 'box' } : null;
    materials.push(wasteFactorLine('wall_tile', 'Wall tile (surround + wainscot)', wallTileArea, 'sqft', r.tile.waste_by_layout[wallLayout],
      `surround ${round1(showerWall)} + wainscot ${round1(wainscotArea)} sqft (${wallLayout} layout)`,
      { wholeUnits: true, note: r.tile.waste_note, pack }));
  }

  // Thinset + grout — sized to the actual tiled substrate.
  if (tiledSubstrate > 0) {
    materials.push(coverageLine('thinset', 'Thinset mortar', tiledSubstrate, 'sqft',
      r.thinset.coverage_sqft_per_bag, 'sqft/bag', `${r.thinset.bag_lb} lb bag`,
      `floor ${round1(floorArea)} + wall ${round1(wallTileArea)} sqft set`, r.thinset.note));

    const anyMosaic = floorLayout === 'mosaic' || wallLayout === 'mosaic';
    const groutCov = anyMosaic
      ? r.grout.coverage_sqft_per_bag_small_tile
      : r.grout.coverage_sqft_per_bag;
    materials.push(coverageLine('grout', 'Grout', tiledSubstrate, 'sqft',
      groutCov, 'sqft/bag', `${r.grout.bag_lb} lb bag`, `tiled area (floor ${floorLayout} / wall ${wallLayout})`, r.grout.note));
  }

  // Waterproofing membrane — the wet zone (surround walls + tiled shower pan).
  const wpArea = showerWall + showerFloor;
  if (v.includeWaterproofing && wpArea > 0) {
    materials.push(coverageLine('waterproofing_membrane', 'Waterproofing membrane', wpArea, 'sqft',
      r.waterproofing.coverage_sqft_per_roll, 'sqft/roll', r.waterproofing.roll_label,
      `wet zone: surround ${round1(showerWall)} + pan ${round1(showerFloor)} sqft`, r.waterproofing.note));
  }

  // Cement backer board — behind the wet-wall tile (instead of drywall).
  if (showerWall > 0) {
    materials.push(wasteFactorLine('cement_backer_board', 'Cement backer board', showerWall, 'sqft',
      r.backer_board.waste_pct, `wet-wall surround ${round1(showerWall)} sqft, /${r.backer_board.sheet_sqft} sqft/sheet`,
      { perUnitSqft: r.backer_board.sheet_sqft, orderUnit: 'sheet', note: r.backer_board.note }));
  }

  // Drywall — the dry walls (+ compound/tape/screws scaled to that surface).
  if (dryWallArea > 0) {
    const dwOrderedArea = dryWallArea * (1 + r.drywall.waste_pct);
    const sheets = ceil(dwOrderedArea / r.drywall.sheet_sqft);
    materials.push({
      key: 'drywall_sheets', label: 'Drywall (4x8 sheets)', type: 'waste_factor',
      raw: round1(dryWallArea), raw_unit: 'sqft', waste_pct: Math.round(r.drywall.waste_pct * 100),
      order_qty: sheets, order_unit: 'sheet',
      basis: `dry walls: perimeter ${round1(perimeter)} LF x ${v.ceilingHeight} ft - openings - wet surround, /${r.drywall.sheet_sqft} sqft/sheet`,
      note: r.drywall.note,
    });
    const jcLb = dryWallArea / 100 * r.joint_compound.lb_per_100sqft;
    materials.push(coverageLine('joint_compound', 'Joint compound', jcLb, 'lb',
      r.joint_compound.bucket_lb, 'lb/bucket', '4.5-gal bucket',
      `${r.joint_compound.lb_per_100sqft} lb per 100 sqft of wall`, r.joint_compound.note));
    const tapeLF = dryWallArea / r.drywall_tape.sqft_per_lf;
    materials.push(coverageLine('drywall_tape', 'Drywall joint tape', tapeLF, 'LF',
      r.drywall_tape.roll_lf, 'LF/roll', `${r.drywall_tape.roll_lf} ft roll`,
      `wall area / ${r.drywall_tape.sqft_per_lf} sqft per LF of tape`, r.drywall_tape.note));
    materials.push(coverageLine('drywall_screws', 'Drywall screws', sheets * r.drywall_screws.per_sheet, 'screws',
      r.drywall_screws.per_box, 'screws/box', '1 lb box',
      `${sheets} sheets x ${r.drywall_screws.per_sheet} screws/sheet`, r.drywall_screws.note));
  }

  // Vanity + vanity top — made-to-measure, field-verify.
  const vanityLF = v.includeVanity ? (isPosNum(v.vanityLF) ? v.vanityLF : 0) : 0;
  if (vanityLF > 0) {
    materials.push(madeToMeasureLine('vanity', 'Vanity cabinet', vanityLF, 'provided vanity LF', r.vanity.note));
    const vtSqft = vanityLF * r.vanity_top.sqft_per_lf;
    const vtWaste = v.vanityTopType === 'veined' ? r.vanity_top.waste_pct_veined : r.vanity_top.waste_pct_solid;
    const vtPack = isPosNum(v.vanityTopSlabSqft) ? { size: v.vanityTopSlabSqft, unit: 'slab' } : null;
    materials.push(wasteFactorLine('vanity_top', `Vanity top (${v.vanityTopType})`, vtSqft, 'sqft', vtWaste,
      `${r.vanity_top.sqft_per_lf} sqft per vanity LF (${round1(vanityLF)} LF)`,
      { wholeUnits: true, fieldVerify: true, note: r.vanity_top.note, pack: vtPack }));
  }

  // ── optional add-on groups (demolition, subfloor, paint, trim, hardware) ──
  // All off by default. Paint covers the DRY walls only — the wet zone is tiled.
  materials.push(...buildAddonLines(v, r.addons, {
    floorSqft: v.bathroomSqft,
    paintArea: dryWallArea,
    perimeter,
    hardwareLF: vanityLF,
    openings: v.openings,
  }));

  // ── fixtures / rough-in checklist ──
  const fixtures_checklist = buildFixtures(def.fixtures, { vanity_lf: vanityLF });

  const orderCount = materials.length;
  const fx = fixtures_checklist.plumbing.length + fixtures_checklist.electrical.length;
  const scope = v.showerType === 'none' ? 'no shower/tub' : v.showerType.replace('_', '/');
  const summary = `${def.label} - ${v.bathroomSqft} sqft (${scope}): ${orderCount} material line${orderCount === 1 ? '' : 's'} quantified (order-ready, waste included) plus a ${fx}-item plumbing/electrical rough-in checklist. Vanity & top are made-to-measure - field-verify before ordering.`;

  return {
    derived: {
      wall_perimeter_lf: round1(perimeter),
      total_wall_area_sqft: round1(totalWallArea),
      dry_wall_area_sqft: round1(dryWallArea),
      shower_wall_sqft: round1(showerWall),
      wall_tile_sqft: round1(wallTileArea),
      floor_tile_sqft: round1(floorArea),
      tiled_substrate_sqft: round1(tiledSubstrate),
      waterproofing_sqft: round1(wpArea),
      vanity_lf: round1(vanityLF),
    },
    materials,
    fixtures_checklist,
    summary,
  };
}

module.exports = { id: 'bathroom_remodel', build };
