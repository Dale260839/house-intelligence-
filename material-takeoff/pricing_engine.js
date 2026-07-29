/**
 * Material Takeoff — Pricing & Profit layer
 * -----------------------------------------
 * Additive layer on top of takeoff_engine.js. The takeoff engine stays pure and
 * synchronous (quantities only); pricing is a SEPARATE async pass so the deterministic
 * engine + its tests never depend on the network.
 *
 * Given a built takeoff + a pricing provider it:
 *   1. picks a quality tier (good / better / best) per the request;
 *   2. fetches a live unit price for each material line at that tier;
 *   3. costs each line (unit_price x order_qty);
 *   4. adds a labor line (rough % of materials, override per job);
 *   5. lays out profit BOTH ways — the applied markup % AND the gross margin % it implies.
 *
 * Fixtures (plumbing/electrical rough-in) stay an unpriced checklist: they are the
 * install scope, covered by the labor line, not a shopping list.
 *
 * IMPORTANT: prices are matched to a per-tier SEARCH TERM, not your exact SKU, so the
 * layout is a budgetary estimate — never a quote.
 */

const round2 = n => Math.round(n * 100) / 100;   // money
const round1 = n => Math.round(n * 10) / 10;     // percentages

// PER-LINE-KEY SANITY BANDS (Issue 1 backstop): plausible ranges in each line's OWN price_unit.
// After pack/case normalization, a price still outside its band is a unit mismatch — not a real
// price — so the matcher drops it and the line degrades to unpriced/budget-fallback rather than
// shipping a 5x–25x error. A dataset `min_unit_price`/`max_unit_price` on the line overrides these.
const PRICE_BANDS = {
  // flooring + tile — per sqft
  flooring_lvp: { min: 1, max: 8 }, flooring_laminate: { min: 1, max: 7 },
  flooring_engineered: { min: 3, max: 15 }, flooring_hardwood: { min: 4, max: 18 },
  flooring_tile: { min: 1, max: 15 },
  floor_tile: { min: 1, max: 15 }, backsplash_tile: { min: 1, max: 30 }, wall_tile: { min: 1, max: 30 },
  // slabs — per sqft
  countertop: { min: 8, max: 150 }, vanity_top: { min: 8, max: 150 },
  // trim — per 16 ft stick
  baseboard: { min: 8, max: 70 },
  // drywall — per sheet
  drywall_sheets: { min: 8, max: 40 },
  // cabinets — per LF (rough budget, wide band)
  base_cabinets: { min: 30, max: 900 }, upper_cabinets: { min: 25, max: 700 },
  // dumpster — reject the ~$30 consumer bag matched against a 20 cu yd rental line
  demolition_dumpster: { min: 200 },
};

// Run fn over items with at most `limit` in flight at once, preserving input order.
// Lets the per-line price lookups overlap (a full takeoff prices in ~one slow call
// instead of the sum of 11) without hammering a rate-limited API with all 11 at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** Coerce + clamp the pricing request options against the dataset defaults. */
function resolvePricingOpts(rawOpts, pricingCfg) {
  const d = (pricingCfg && pricingCfg.defaults) || {};
  const tiers = (pricingCfg && pricingCfg.tiers) || ['good', 'better', 'best'];
  const warnings = [];

  let tier = String(rawOpts.tier || d.tier || 'better').toLowerCase();
  if (!tiers.includes(tier)) {
    warnings.push(`Unknown tier "${rawOpts.tier}"; using "${d.tier || 'better'}". Allowed: ${tiers.join(', ')}.`);
    tier = d.tier || 'better';
  }

  const markupPct = numOr(rawOpts.markupPct, d.markup_pct != null ? d.markup_pct : 20);

  // Labor: an explicit dollar figure wins; else a percent of material cost.
  let laborCost = rawOpts.laborCost != null && rawOpts.laborCost !== '' ? Number(rawOpts.laborCost) : null;
  if (laborCost != null && (!Number.isFinite(laborCost) || laborCost < 0)) laborCost = null;
  const laborPct = numOr(rawOpts.laborPct, d.labor_pct_of_materials != null ? d.labor_pct_of_materials : 100);

  return { tier, tiers, markupPct, laborCost, laborPct, warnings };
}

function numOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PRICE_CONCURRENCY = 5;  // overlap lookups but stay under free-tier rate limits

/**
 * Price a list of material lines against ONE project's pricing config. Shared by the
 * single-endpoint pricer (priceTakeoff) and the multi-section pricer (priceScopeTakeoff)
 * so the per-line lookup, the outlier/floor guards, and field tagging live in exactly one
 * place. Pure of labor/profit — callers apply those once over the merged set.
 *
 * Each returned line carries its `section_id` (from the material line) and, when priced,
 * its `price_source` (the provider that answered: homedepot_live | mock | …). Lookups run
 * CONCURRENTLY (capped) and input order is preserved. Never throws.
 */
async function priceMaterialLines(materials, pricingCfg, provider, tier) {
  const lineCfg = (pricingCfg && pricingCfg.lines) || {};

  const priceOne = async (m) => {
    const cfg = lineCfg[m.key];
    const query = cfg && cfg.search && cfg.search[tier];
    const base = {
      key: m.key, label: m.label, tier,
      section_id: m.section_id || null,           // U2: line -> section link
      order_qty: m.order_qty, order_unit: m.order_unit,
      // pack_round lines (tile boxes / countertop slabs) are priced PER PACK — the HD price
      // is per box/slab, so unit_price x order_qty (packs) is correct. Non-packed lines use
      // the configured price_unit (or the order unit).
      price_unit: (m.type === 'pack_round') ? m.order_unit : ((cfg && cfg.price_unit) || m.order_unit),
      field_estimate: !!(cfg && cfg.field_estimate) || !!m.field_verify,
    };
    if (!cfg || !query) return { ...base, priced: false, price_source: null, reason: 'no_pricing_config' };

    // Effective sanity band: the dataset line overrides the per-key default (PRICE_BANDS).
    const band = PRICE_BANDS[m.key] || {};
    const minPrice = (cfg.min_unit_price != null) ? cfg.min_unit_price : band.min;
    const maxPrice = (cfg.max_unit_price != null) ? cfg.max_unit_price : band.max;
    const res = await provider.lookup({ key: m.key, query, tier, priceUnit: base.price_unit,
      maxPrice, minPrice });
    if (!res || !res.ok) return { ...base, priced: false, price_source: null, reason: (res && res.reason) || 'lookup_failed', query };

    return {
      ...base,
      priced: true,
      unit_price: round2(res.unit_price),
      line_cost: round2(res.unit_price * m.order_qty),
      currency: res.currency || 'USD',
      price_source: res.source || (provider.source || provider.id) || 'unknown',  // U3
      product_title: res.product_title || null,
      product_url: res.product_url || null,
      query,
    };
  };

  const priced = await mapLimit(materials, PRICE_CONCURRENCY, priceOne);
  return { lines: priced.filter(p => p.priced), unpriced: priced.filter(p => !p.priced) };
}

/**
 * Price a built takeoff.
 *   takeoff  — the ok:true object from buildTakeoff()
 *   opts     — { provider (required), dataset, tier, markupPct, laborPct, laborCost }
 * Returns a `pricing` object (does NOT mutate the takeoff). Never throws.
 */
async function priceTakeoff(takeoff, opts = {}) {
  const provider = opts.provider;
  if (!provider) {
    return { ok: false, reason: 'pricing_unavailable',
      message: 'No pricing provider. Set HOMEDEPOT_API_KEY to enable live Home Depot pricing.' };
  }
  if (!takeoff || !takeoff.ok) {
    return { ok: false, reason: 'no_takeoff', message: 'Pricing needs a successful takeoff.' };
  }

  const ds = opts.dataset;
  const def = ds && ds.project_types && ds.project_types[takeoff.project_type];
  const pricingCfg = def && def.pricing;
  if (!pricingCfg) {
    return { ok: false, reason: 'no_pricing_config',
      message: `Project type "${takeoff.project_type}" has no pricing config.` };
  }

  const { tier, markupPct, laborCost, laborPct, warnings } =
    resolvePricingOpts(opts, pricingCfg);

  // 1-3: price each material line at the chosen tier (concurrent, capped, order-preserving).
  const { lines, unpriced } = await priceMaterialLines(takeoff.materials, pricingCfg, provider, tier);

  // 4: labor line.
  const materialsCost = round2(lines.reduce((s, l) => s + l.line_cost, 0));
  const laborBasis = laborCost != null ? 'explicit' : 'pct_of_materials';
  const laborTotal = laborCost != null ? round2(laborCost) : round2(materialsCost * (laborPct / 100));

  // 5: profit layout — markup applied, margin implied. Shown BOTH ways.
  const totalCost = round2(materialsCost + laborTotal);
  const price = round2(totalCost * (1 + markupPct / 100));
  const profit = round2(price - totalCost);
  const marginPct = price > 0 ? round1((profit / price) * 100) : 0;

  return {
    ok: true,
    source: provider.source || provider.id || 'unknown',
    currency: 'USD',
    tier,
    tier_label: (pricingCfg.tier_labels && pricingCfg.tier_labels[tier]) || tier,
    lines,
    unpriced_lines: unpriced,
    fully_priced: unpriced.length === 0,
    labor: {
      basis: laborBasis,
      pct_of_materials: laborBasis === 'pct_of_materials' ? laborPct : null,
      cost: laborTotal,
      note: pricingCfg.labor && pricingCfg.labor.note,
    },
    profit_layout: {
      materials_cost: materialsCost,
      labor_cost: laborTotal,
      total_cost: totalCost,
      markup_pct: round1(markupPct),      // the applied input
      price,                              // what the client pays
      profit,                             // price - cost
      margin_pct: marginPct,              // profit / price (the implied margin)
    },
    warnings: warnings.length ? warnings : undefined,
    disclaimer: (ds && ds._meta && ds._meta.pricing_disclaimer) || undefined,
  };
}

/**
 * U3 — budget-derived fallback. When a live price can't be matched for a line, an unpriced
 * line silently DROPS out of the total (understating the job). Instead, if the section came
 * with a `budget_hint` (its materials budget in dollars), spread whatever budget is left
 * after the live-priced lines EVENLY across the unmatched lines and tag them
 * `price_source: 'proposal_budget'`. No budget, or the priced lines already meet it → the
 * lines stay unpriced (we won't invent a number without a basis). Totals still reconcile.
 */
function budgetFallbackLines(pricedLines, unpricedLines, budgetHint) {
  if (!unpricedLines.length) return { estimated: [], remainingUnpriced: [] };
  const hint = Number(budgetHint);
  if (!Number.isFinite(hint) || hint <= 0) return { estimated: [], remainingUnpriced: unpricedLines };

  const pricedSum = pricedLines.reduce((s, l) => s + l.line_cost, 0);
  const remaining = round2(Math.max(0, hint - pricedSum));
  if (remaining <= 0) return { estimated: [], remainingUnpriced: unpricedLines };

  const share = round2(remaining / unpricedLines.length);
  const estimated = unpricedLines.map(u => ({
    ...u,
    priced: true,
    estimated: true,                                  // budget-derived, not a live price
    unit_price: u.order_qty > 0 ? round2(share / u.order_qty) : share,
    line_cost: share,
    currency: 'USD',
    price_source: 'proposal_budget',
    basis: 'budget_fallback',
    note: 'Budget-derived estimate (no live price matched); refine before quoting.',
  }));
  return { estimated, remainingUnpriced: [] };
}

/**
 * Price a MULTI-SECTION (scope / proposal) takeoff.
 *   sectionTakeoffs — [{ section_id, project_type, materials, budget_hint }] from scope_engine
 *   opts            — { provider (required), dataset, tier, markupPct, laborPct, laborCost }
 * Each section's lines are priced against ITS OWN project pricing config (a composite job
 * mixes a kitchen + a bath + a floor, each with different search terms), then merged and
 * costed ONCE: one labor line, one profit layout over the whole scope. Unmatched lines run
 * through the budget fallback. Same shape as priceTakeoff's output + a `sections[]`
 * per-section cost breakdown. Never throws.
 */
async function priceScopeTakeoff(sectionTakeoffs, opts = {}) {
  const provider = opts.provider;
  if (!provider) {
    return { ok: false, reason: 'pricing_unavailable',
      message: 'No pricing provider. Set HOMEDEPOT_API_KEY to enable live Home Depot pricing.' };
  }
  if (!Array.isArray(sectionTakeoffs) || !sectionTakeoffs.length) {
    return { ok: false, reason: 'no_takeoff', message: 'Pricing needs at least one section.' };
  }
  const ds = opts.dataset;
  const firstDef = ds && ds.project_types && ds.project_types[sectionTakeoffs[0].project_type];
  const firstCfg = (firstDef && firstDef.pricing) || { tiers: ['good', 'better', 'best'] };
  const { tier, markupPct, laborCost, laborPct, warnings } = resolvePricingOpts(opts, firstCfg);

  const allLines = [];
  const allUnpriced = [];
  const sectionBreakdown = [];

  for (const st of sectionTakeoffs) {
    const def = ds && ds.project_types && ds.project_types[st.project_type];
    const cfg = def && def.pricing;
    if (!cfg) {
      // A section with no pricing config: report every line unpriced rather than crash.
      for (const m of st.materials) {
        allUnpriced.push({ key: m.key, label: m.label, section_id: st.section_id,
          priced: false, price_source: null, reason: 'no_pricing_config' });
      }
      sectionBreakdown.push({ section_id: st.section_id, project_type: st.project_type,
        materials_cost: 0, priced: 0, budget_estimated: 0, unpriced: st.materials.length });
      continue;
    }

    const { lines, unpriced } = await priceMaterialLines(st.materials, cfg, provider, tier);
    const { estimated, remainingUnpriced } = budgetFallbackLines(lines, unpriced, st.budget_hint);
    const sectionLines = [...lines, ...estimated];
    allLines.push(...sectionLines);
    allUnpriced.push(...remainingUnpriced);
    sectionBreakdown.push({
      section_id: st.section_id, project_type: st.project_type,
      materials_cost: round2(sectionLines.reduce((s, l) => s + l.line_cost, 0)),
      priced: lines.length, budget_estimated: estimated.length, unpriced: remainingUnpriced.length,
    });
  }

  // Cost the merged scope ONCE: one labor line, one profit layout.
  const materialsCost = round2(allLines.reduce((s, l) => s + l.line_cost, 0));
  const laborBasis = laborCost != null ? 'explicit' : 'pct_of_materials';
  const laborTotal = laborCost != null ? round2(laborCost) : round2(materialsCost * (laborPct / 100));
  const totalCost = round2(materialsCost + laborTotal);
  const price = round2(totalCost * (1 + markupPct / 100));
  const profit = round2(price - totalCost);
  const marginPct = price > 0 ? round1((profit / price) * 100) : 0;

  return {
    ok: true,
    source: provider.source || provider.id || 'unknown',
    currency: 'USD',
    tier,
    tier_label: (firstCfg.tier_labels && firstCfg.tier_labels[tier]) || tier,
    lines: allLines,
    unpriced_lines: allUnpriced,
    fully_priced: allUnpriced.length === 0,
    sections: sectionBreakdown,
    labor: {
      basis: laborBasis,
      pct_of_materials: laborBasis === 'pct_of_materials' ? laborPct : null,
      cost: laborTotal,
    },
    profit_layout: {
      materials_cost: materialsCost,
      labor_cost: laborTotal,
      total_cost: totalCost,
      markup_pct: round1(markupPct),
      price,
      profit,
      margin_pct: marginPct,
    },
    warnings: warnings.length ? warnings : undefined,
    disclaimer: (ds && ds._meta && ds._meta.pricing_disclaimer) || undefined,
  };
}

/** Render the profit layout as a human-readable block (append to renderTakeoffText). */
function renderPricingText(p) {
  if (!p) return '';
  if (!p.ok) return `PRICING: unavailable — ${p.message || p.reason}`;
  const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const L = [];
  L.push('');
  L.push(`PRICING — ${p.tier_label} tier  (source: ${p.source}, ${p.currency})`);
  for (const l of p.lines) {
    const fv = l.field_estimate ? '  [ESTIMATE]' : '';
    L.push(`  ${l.label}: ${l.order_qty} ${l.order_unit} x ${money(l.unit_price)}/${l.price_unit} = ${money(l.line_cost)}${fv}`);
    if (l.product_title || l.product_url) {
      L.push(`      ↳ ${[l.product_title, l.product_url].filter(Boolean).join('  —  ')}`);
    }
  }
  for (const u of p.unpriced_lines) L.push(`  ${u.label}: NOT PRICED (${u.reason})`);
  const g = p.profit_layout;
  L.push('');
  L.push('PROFIT LAYOUT:');
  L.push(`  Materials:   ${money(g.materials_cost)}`);
  L.push(`  Labor:       ${money(g.labor_cost)}${p.labor.basis === 'pct_of_materials' ? `  (${p.labor.pct_of_materials}% of materials)` : ''}`);
  L.push(`  Total cost:  ${money(g.total_cost)}`);
  L.push(`  Markup:      ${g.markup_pct}%`);
  L.push(`  PRICE:       ${money(g.price)}`);
  L.push(`  Profit:      ${money(g.profit)}  (${g.margin_pct}% margin)`);
  if (p.disclaimer) { L.push(''); L.push('Note: ' + p.disclaimer); }
  return L.join('\n');
}

module.exports = {
  priceTakeoff, priceScopeTakeoff, priceMaterialLines,
  renderPricingText, resolvePricingOpts,
};
