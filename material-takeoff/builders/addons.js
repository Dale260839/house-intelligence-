/**
 * Shared add-on line groups (Phase 4 + U5)
 * ----------------------------------------
 * Optional material groups that apply to ANY project type: demolition debris, subfloor,
 * paint, trim, cabinet hardware, and site protection / dust control. Each group is OFF by
 * default and switched on by its own `include*` input, so adding this never changes an
 * existing takeoff.
 *
 * Every project builder calls buildAddonLines() with the geometry it already derived, so
 * the rules live in one place and a new project type gets all six groups for free.
 *
 * Rates come from the project's `rates.addons` block (data-driven, tunable per type).
 */
const { round1, ceil, wasteFactorLine, coverageLine } = require('../line_builders.js');

/**
 * @param v    resolved inputs (toggles: includeDemolition/Subfloor/Paint/Trim/Hardware/SiteProtection, paintCoats)
 * @param a    def.rates.addons
 * @param ctx  { floorSqft, paintArea, perimeter, hardwareLF, openings }
 * @returns    array of material lines (empty when nothing is toggled on)
 */
function buildAddonLines(v, a, ctx = {}) {
  const lines = [];
  if (!a) return lines;

  const floorSqft = ctx.floorSqft || 0;
  const paintArea = ctx.paintArea || 0;
  const perimeter = ctx.perimeter || 0;
  const hardwareLF = ctx.hardwareLF || 0;
  const openings = ctx.openings || 0;

  // ── Demolition: debris volume -> dumpster count ──
  if (v.includeDemolition && a.demolition && floorSqft > 0) {
    const d = a.demolition;
    const debrisCy = floorSqft * d.debris_cy_per_sqft;
    lines.push(coverageLine('demolition_dumpster', 'Demolition dumpster', debrisCy, 'cu yd',
      d.dumpster_cy, 'cu yd/dumpster', d.dumpster_label,
      `${floorSqft} sqft x ${d.debris_cy_per_sqft} cu yd/sqft of debris`, d.note));
  }

  // ── Subfloor / underlayment: floor area -> whole panels ──
  if (v.includeSubfloor && a.subfloor && floorSqft > 0) {
    const s = a.subfloor;
    lines.push(wasteFactorLine('subfloor', 'Subfloor / underlayment', floorSqft, 'sqft', s.waste_pct,
      `floor area ${round1(floorSqft)} sqft, /${s.sheet_sqft} sqft per panel`,
      { perUnitSqft: s.sheet_sqft, orderUnit: 'sheet', note: s.note }));
  }

  // ── Paint: primer (1 coat) + topcoats over the paintable surface ──
  if (v.includePaint && a.paint && paintArea > 0) {
    const p = a.paint;
    const coats = Number.isFinite(Number(v.paintCoats)) && Number(v.paintCoats) > 0
      ? Number(v.paintCoats) : p.default_topcoats;

    lines.push(coverageLine('primer', 'Primer', paintArea * (p.primer_coats || 1), 'sqft',
      p.coverage_sqft_per_gal, 'sqft/gal', 'gal',
      `${round1(paintArea)} sqft x ${p.primer_coats || 1} coat`, p.note));

    lines.push(coverageLine('paint', `Paint (${coats} coat${coats === 1 ? '' : 's'})`,
      paintArea * coats, 'sqft', p.coverage_sqft_per_gal, 'sqft/gal', 'gal',
      `${round1(paintArea)} sqft x ${coats} coats`, p.note));
  }

  // ── Trim: baseboard around the room (less door openings) -> whole sticks ──
  if (v.includeTrim && a.trim && perimeter > 0) {
    const t = a.trim;
    const trimLF = Math.max(0, perimeter - openings * (t.door_width_ft || 0));
    if (trimLF > 0) {
      lines.push(wasteFactorLine('baseboard', 'Baseboard trim', trimLF, 'LF', t.waste_pct,
        `perimeter ${round1(perimeter)} LF - ${openings} openings, /${t.stick_lf} ft sticks`,
        { perUnitSqft: t.stick_lf, orderUnit: `${t.stick_lf} ft stick`, note: t.note }));
    }
  }

  // ── Hardware: cabinet/vanity pulls + knobs ──
  if (v.includeHardware && a.hardware && hardwareLF > 0) {
    const h = a.hardware;
    const count = ceil(hardwareLF * h.pulls_per_cabinet_lf);
    lines.push(wasteFactorLine('cabinet_hardware', 'Cabinet hardware (pulls / knobs)', count, 'ea', 0,
      `${round1(hardwareLF)} cabinet LF x ${h.pulls_per_cabinet_lf} pulls/LF`,
      { wholeUnits: true, orderUnit: 'ea', note: h.note }));
  }

  // ── Site protection / dust control (U5): every line DERIVED FROM AREA (no LLM). ──
  // Protects finished surfaces and contains dust during demo/sanding: floor protection,
  // plastic dust walls, masking tape, per-opening dust barriers, and HEPA air-scrubber
  // filters. Switched on by includeSiteProtection.
  if (v.includeSiteProtection && a.site_protection && (floorSqft > 0 || perimeter > 0)) {
    const sp = a.site_protection;

    if (sp.floor_protection && floorSqft > 0) {
      const fp = sp.floor_protection;
      lines.push(coverageLine('floor_protection', 'Floor protection (ram board / paper)', floorSqft, 'sqft',
        fp.coverage_sqft_per_roll, 'sqft/roll', fp.order_unit || 'roll',
        `floor area ${round1(floorSqft)} sqft`, fp.note));
    }

    if (sp.plastic_sheeting && floorSqft > 0) {
      const ps = sp.plastic_sheeting;
      const area = floorSqft * (ps.sqft_per_sqft_floor || 1);
      lines.push(coverageLine('plastic_sheeting', 'Plastic sheeting / dust walls', area, 'sqft',
        ps.coverage_sqft_per_roll, 'sqft/roll', ps.order_unit || 'roll',
        `${round1(floorSqft)} sqft x ${ps.sqft_per_sqft_floor || 1} containment`, ps.note));
    }

    if (sp.masking_tape && (perimeter > 0 || floorSqft > 0)) {
      const mt = sp.masking_tape;
      const seamLF = (perimeter > 0 ? perimeter : 4 * Math.sqrt(floorSqft)) + floorSqft * (mt.lf_per_sqft_floor || 0);
      lines.push(coverageLine('masking_tape', 'Masking / painters tape', seamLF, 'LF',
        mt.roll_lf, 'LF/roll', mt.order_unit || 'roll',
        `edges + seams ~${round1(seamLF)} LF`, mt.note));
    }

    if (sp.dust_barrier) {
      const db = sp.dust_barrier;
      const count = Math.max(db.min || 1, ceil(openings * (db.per_opening || 1)));
      lines.push(wasteFactorLine('dust_barrier', 'Dust barrier / zip-wall kit', count, 'ea', 0,
        `${openings} opening${openings === 1 ? '' : 's'} x ${db.per_opening || 1} (min ${db.min || 1})`,
        { wholeUnits: true, orderUnit: db.order_unit || 'kit', note: db.note }));
    }

    if (sp.hepa_filter && floorSqft > 0) {
      const hf = sp.hepa_filter;
      const count = Math.max(hf.min || 1, ceil(floorSqft / (hf.sqft_per_filter || 500)));
      lines.push(wasteFactorLine('hepa_filter', 'HEPA filter (air scrubber)', count, 'ea', 0,
        `${round1(floorSqft)} sqft / ${hf.sqft_per_filter || 500} sqft per filter (min ${hf.min || 1})`,
        { wholeUnits: true, orderUnit: hf.order_unit || 'ea', note: hf.note }));
    }
  }

  return lines;
}

module.exports = { buildAddonLines };
