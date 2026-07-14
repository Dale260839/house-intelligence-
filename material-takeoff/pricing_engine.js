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
  const lineCfg = pricingCfg.lines || {};

  // 1-3: price each material line at the chosen tier.
  const lines = [];
  const unpriced = [];
  for (const m of takeoff.materials) {
    const cfg = lineCfg[m.key];
    const query = cfg && cfg.search && cfg.search[tier];
    const base = {
      key: m.key, label: m.label, tier,
      order_qty: m.order_qty, order_unit: m.order_unit,
      price_unit: (cfg && cfg.price_unit) || m.order_unit,
      field_estimate: !!(cfg && cfg.field_estimate) || !!m.field_verify,
    };

    if (!cfg || !query) {
      unpriced.push({ ...base, priced: false, reason: 'no_pricing_config' });
      continue;
    }

    const res = await provider.lookup({ key: m.key, query, tier, priceUnit: base.price_unit });
    if (!res || !res.ok) {
      unpriced.push({ ...base, priced: false, reason: (res && res.reason) || 'lookup_failed', query });
      continue;
    }

    const unitPrice = res.unit_price;
    const lineCost = round2(unitPrice * m.order_qty);
    lines.push({
      ...base,
      priced: true,
      unit_price: round2(unitPrice),
      line_cost: lineCost,
      currency: res.currency || 'USD',
      product_title: res.product_title || null,
      product_url: res.product_url || null,
      query,
    });
  }

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

module.exports = { priceTakeoff, renderPricingText, resolvePricingOpts };
