/**
 * Shared add-on line groups (Phase 4)
 * -----------------------------------
 * Optional material groups that apply to ANY project type: demolition debris, subfloor,
 * paint, trim, and cabinet hardware. Each group is OFF by default and switched on by its
 * own `include*` input, so adding this never changes an existing takeoff.
 *
 * Every project builder calls buildAddonLines() with the geometry it already derived, so
 * the rules live in one place and a new project type gets all five groups for free.
 *
 * Rates come from the project's `rates.addons` block (data-driven, tunable per type).
 */
const { round1, ceil, wasteFactorLine, coverageLine } = require('../line_builders.js');

/**
 * @param v    resolved inputs (toggles: includeDemolition/Subfloor/Paint/Trim/Hardware, paintCoats)
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

  return lines;
}

module.exports = { buildAddonLines };
