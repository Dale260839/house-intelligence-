/**
 * Material Takeoff — print-ready HTML export (U8)
 * -----------------------------------------------
 * A zero-dependency "PDF export path": a self-contained, print-optimised HTML document the
 * browser (or BuildSuite) turns into a PDF with Ctrl+P → Save as PDF. We DELIBERATELY do not
 * pull a server-side PDF engine (pdfkit / puppeteer / headless Chrome) — that would break the
 * service's zero-runtime-dependency guarantee, and House Intelligence has no PDF pattern to
 * share. The client owns the paper; we own a clean, deterministic render.
 *
 * Handles all three response shapes (manual / scope / proposal) plus the optional pricing
 * block, section grouping, and proposal provenance (source_quote + confidence).
 */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderTakeoffHtml(t) {
  if (!t || !t.ok) {
    return page('Material Takeoff', `<p class="err">${esc((t && t.message) || 'No takeoff to render.')}</p>`);
  }

  const priced = (t.pricing && t.pricing.ok) ? t.pricing : null;
  const priceByKey = {};
  if (priced) for (const l of priced.lines) priceByKey[`${l.section_id}|${l.key}`] = l;

  // Section order, in first-seen order across the merged material lines.
  const order = [];
  for (const m of t.materials) if (!order.includes(m.section_id)) order.push(m.section_id);
  const sectionLabel = {};
  (t.sections || []).forEach(s => { sectionLabel[s.section_id] = s.label; });
  const multi = order.length > 1;
  const cols = priced ? 5 : 3;

  const rows = order.map(sid => {
    const head = multi ? `<tr class="sec"><td colspan="${cols}">${esc(sectionLabel[sid] || sid)}</td></tr>` : '';
    const body = t.materials.filter(m => m.section_id === sid).map(m => {
      const pl = priceByKey[`${sid}|${m.key}`];
      const conf = m.confidence ? ` <span class="conf ${esc(m.confidence)}">${esc(m.confidence)}</span>` : '';
      const q = m.type === 'coverage' ? `${m.order_qty} &times; ${esc(m.order_unit)}` : `${esc(m.order_qty)} ${esc(m.order_unit)}`;
      return `<tr>
        <td>${esc(m.label)}${conf}${m.source_quote ? `<div class="sq">&ldquo;${esc(m.source_quote)}&rdquo;</div>` : ''}<div class="basis">${esc(m.basis || '')}</div></td>
        <td class="num">${q}</td>
        ${priced ? `<td class="num">${pl ? esc(money(pl.unit_price)) + '/' + esc(pl.price_unit) : '&mdash;'}</td>
                    <td class="num">${pl ? esc(money(pl.line_cost)) : '&mdash;'}</td>
                    <td class="num src">${pl ? esc(pl.price_source || '') : ''}</td>` : ''}
      </tr>`;
    }).join('');
    return head + body;
  }).join('');

  const badge = t.source_type ? `<span class="badge">${esc(t.source_type)}</span>` : '';
  const body = `
    <h1>${esc(t.project_label || 'Material Takeoff')} ${badge}</h1>
    <p class="sum">${esc(t.summary || '')}</p>
    <table class="mat">
      <thead><tr><th>Item</th><th class="num">Order</th>${priced ? '<th class="num">Unit</th><th class="num">Line</th><th class="num">Source</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${priced ? renderPricing(priced) : ''}
    ${renderFixtures(t.fixtures_checklist)}
    ${renderNotes(t.extracted_scope)}
    <p class="disc">${esc(t.disclaimer || '')}</p>`;
  return page(esc(t.project_label || 'Material Takeoff'), body);
}

function renderPricing(p) {
  const g = p.profit_layout;
  const laborNote = (p.labor && p.labor.basis === 'pct_of_materials') ? ` (${p.labor.pct_of_materials}% of materials)` : '';
  return `
    <h2>Pricing &mdash; ${esc(p.tier_label || p.tier)} <span class="src">(source: ${esc(p.source)})</span></h2>
    <table class="profit">
      <tr><td>Materials</td><td class="num">${esc(money(g.materials_cost))}</td></tr>
      <tr><td>Labor${laborNote}</td><td class="num">${esc(money(g.labor_cost))}</td></tr>
      <tr class="tot"><td>Total cost</td><td class="num">${esc(money(g.total_cost))}</td></tr>
      <tr><td>Markup</td><td class="num">${esc(g.markup_pct)}%</td></tr>
      <tr class="price"><td>Client price</td><td class="num">${esc(money(g.price))}</td></tr>
      <tr><td>Profit</td><td class="num">${esc(money(g.profit))} (${esc(g.margin_pct)}% margin)</td></tr>
    </table>
    ${p.disclaimer ? `<p class="disc">${esc(p.disclaimer)}</p>` : ''}`;
}

function renderFixtures(fc) {
  if (!fc) return '';
  const list = (arr) => (arr || []).map(f => `<li>${esc(f.item)}: ${esc(f.qty)} ${esc(f.unit)}${f.estimate ? ' (est.)' : ''}</li>`).join('');
  const p = list(fc.plumbing), e = list(fc.electrical);
  if (!p && !e) return '';
  return `<h2>Rough-in checklist</h2>
    ${p ? `<h3>Plumbing</h3><ul>${p}</ul>` : ''}
    ${e ? `<h3>Electrical</h3><ul>${e}</ul>` : ''}`;
}

function renderNotes(ex) {
  if (!ex || !Array.isArray(ex.notes) || !ex.notes.length) return '';
  return `<h2>Extraction notes</h2><ul>${ex.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; max-width: 850px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 22px 0 6px; border-bottom: 2px solid #0a6; padding-bottom: 3px; }
  h3 { font-size: 12px; margin: 10px 0 2px; color: #555; text-transform: uppercase; letter-spacing: .04em; }
  .sum { color: #555; margin: 0 0 12px; }
  .badge { font-size: 11px; background: #0a6; color: #fff; border-radius: 4px; padding: 2px 7px; vertical-align: middle; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; color: #888; border-bottom: 2px solid #ddd; }
  .num { text-align: right; white-space: nowrap; }
  .basis { color: #999; font-size: 11px; margin-top: 2px; }
  .src { color: #aaa; font-size: 11px; font-weight: 400; text-transform: none; }
  tr.sec td { background: #f4f8f6; font-weight: 600; color: #064; }
  .sq { color: #999; font-style: italic; font-size: 11px; }
  .conf { font-size: 10px; border-radius: 3px; padding: 1px 5px; text-transform: uppercase; }
  .conf.stated { background: #e6f7ee; color: #067; } .conf.inferred { background: #fef3d7; color: #85630a; } .conf.assumed { background: #fde8e8; color: #a33; }
  table.profit { max-width: 360px; } table.profit .tot td, table.profit .price td { font-weight: 700; border-top: 2px solid #ccc; }
  table.profit .price td { color: #0a6; font-size: 15px; }
  .disc { color: #999; font-size: 11px; margin-top: 16px; }
  .err { color: #a33; }
  @media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } tr { break-inside: avoid; } .badge, tr.sec td, table.profit .price td { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>${body}</body></html>`;
}

module.exports = { renderTakeoffHtml };
