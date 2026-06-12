/**
 * House Intelligence — Lookup Engine
 * -----------------------------------
 * Input:  a build year (and optional 2-letter state / metro) for a job address.
 * Output: the era band, the systems likely present, a deduped list of inspection
 *         items grouped into the 6 blueprint categories, a High/Medium/Low
 *         severity per item and for the row overall, and a blueprint-style
 *         region+era "row" (Layer 1 of the Dataset Blueprint).
 *
 * Design intent (matches the spec): "when a contractor enters a job address,
 * the scope of work automatically includes the right inspection items based on
 * the year the house was built." This module is the brain that produces those
 * items. It is deterministic, dependency-free, and unit-tested.
 *
 * Alignment with the Dataset Blueprint (#2):
 *   - Layer 1 (region+era row): see buildEraRow() / scope.row and buildRegionGrid().
 *   - Layer 2 (6 categories + severity flags): CATEGORY_OF + classifySeverity().
 *   - Layer 4 (address -> year -> era -> items): address_provider.js.
 * We keep the national-era + regional-modifier MODEL (DRY) and GENERATE the
 * blueprint's flat per-region rows from it, rather than duplicating the national
 * pattern into every region by hand.
 *
 * IMPORTANT: output is "likely / inspect for", never "guaranteed present".
 */

const fs = require('fs');
const path = require('path');

function loadDataset(datasetPath) {
  const p = datasetPath || path.join(__dirname, 'era_dataset.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Find the era band whose [year_min, year_max] contains the year. */
function findEra(dataset, year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  return dataset.era_bands.find(b => y >= b.year_min && y <= b.year_max) || null;
}

/** All regional modifiers that apply to a given state code. */
function findRegions(dataset, stateCode) {
  if (!stateCode) return [];
  const sc = String(stateCode).toUpperCase();
  return (dataset.regional_modifiers || []).filter(r =>
    (r.match_states || []).includes(sc)
  );
}

// ─── Blueprint Layer 2: the 6 characteristic categories ──────────────────────
// Our fine-grained systems fold into the blueprint's 6 buckets.
const CATEGORY_OF = {
  electrical: 'Electrical', panel: 'Electrical',
  plumbing_supply: 'Plumbing', plumbing_waste: 'Plumbing',
  foundation: 'Structural',
  heating: 'HVAC',
  hazards: 'Hazards',
  insulation: 'Envelope', windows: 'Envelope', roofing: 'Envelope',
};
const CATEGORY_ORDER = ['Electrical', 'Plumbing', 'Structural', 'HVAC', 'Hazards', 'Envelope'];

// Content override that beats the system→category default, to honor the
// blueprint's explicit placement (e.g. framing is Structural, even though our
// balloon-framing item is stored in the insulation system block).
function categoryOverride(text) {
  if (/balloon[- ]?fram|framing/i.test(text)) return 'Structural';
  return null;
}

// Regional add-ons span categories; classify them by content so they merge into
// the same 6 buckets rather than living in a separate "Regional" column.
// Order matters: Structural (incl. seismic/framing/wind connections) first;
// Plumbing before Envelope so "frozen-pipe risk" is Plumbing, not weatherization.
function categorizeRegionalItem(text) {
  const t = String(text || '');
  if (/seismic|cripple|sill-plate|bolting|masonry|soft-story|foundation|footing|slab|expansive|post-tension|settlement|grading|balloon[- ]?fram|framing|tie-down|hurricane tie|roof strap|hold-down|wind uplift|water heater strapping|strapping/i.test(t)) return 'Structural';
  if (/oil tank|oil heat|furnace|hvac|refrigerant|evaporative cooler/i.test(t)) return 'HVAC';
  if (/asbestos|lead|radon|drywall|\bmold\b/i.test(t)) return 'Hazards';
  if (/\bpipe\b|plumb|galvanized|drain|frozen[- ]pipe/i.test(t)) return 'Plumbing';
  if (/wiring|panel|electrical|knob/i.test(t)) return 'Electrical';
  if (/moisture|crawlspace|insulation|window|roof|moss|stucco|ice-dam|sump|water intrusion|freeze|humidity|\brot\b|flood/i.test(t)) return 'Envelope';
  return 'Structural'; // safe default; every current regional item matches a rule above
}

// ─── Blueprint Layer 2: the severity "Flag" column (High / Medium / Low) ──────
// Ordered High -> Medium -> Low; first matching pattern wins; default Medium.
// Patterns trace directly to the blueprint's Layer-2 flag table.
const SEVERITY_RULES = [
  { level: 'High', patterns: [
    /knob-and-tube/i, /aluminum branch|aluminum wiring|aluminum feeder/i,
    /federal pacific|zinsco|stab-lok/i, /polybutylene/i,
    /lead service line/i, /lead pipe/i, /lead solder/i, /lead-based paint|lead paint/i,
    /asbestos/i, /chinese.*drywall|defective drywall/i,
    /unreinforced masonry/i, /buried oil tank|oil tank/i,
    /seismic|cripple-wall|cripple|sill-plate|bolting|soft-story/i,
    /hurricane|wind.*tie|roof strap/i, /\bflood\b/i,
  ]},
  { level: 'Medium', patterns: [
    /fuse (box|panel)/i, /ungrounded/i, /undersized service|service (capacity|upgrade)/i,
    /galvanized/i, /cast[- ]iron/i, /balloon[- ]fram/i,
    /\bUFFI\b|urea-formaldehyde/i, /expansive (clay|soil)|clay soil/i, /efflorescence/i,
    /moisture|crawlspace|sump|water intrusion|\bmold\b|humidity/i,
    /freeze-thaw|frozen-pipe|ice-dam/i, /post-tension|slab.*(crack|heave)|stucco crack/i,
    /heat exchanger/i, /radon/i, /overfusing|brittle insulation|cloth nm|rubber insulation/i,
    /settlement|cracking|mortar|footing/i, /pinhole|corrosion/i,
  ]},
  { level: 'Low', patterns: [
    /single[- ]pane/i, /\bR-?22\b|refrigerant/i, /thermal (inefficiency|bridging)/i,
    /air leakage|air sealing|counterweight/i,
    /no wall insulation|low\/no insulation|under-?insulat|below current code|empty wall/i,
    /failed (igu|early igu)|igu seal|seal failure|glazing/i,
    /workmanship|warranty|install quality|commissioning/i,
    /storm damage|moss|uv roof|layer count|multiple (roof )?layers|sheathing|ventilation/i,
    /generally|code-current|code-compliant|modern|serviceable|adequate|high performance|standard (checks|condition|settlement)/i,
  ]},
];

/** Classify a single inspection item's severity per the blueprint flags. */
function classifySeverity(itemText) {
  const t = String(itemText || '');
  for (const rule of SEVERITY_RULES) {
    if (rule.patterns.some(rx => rx.test(t))) return rule.level;
  }
  return 'Medium';
}

const SEVERITY_RANK = { Low: 1, Medium: 2, High: 3 };
function rollupSeverity(severities) {
  let best = null;
  for (const s of severities) if (!best || SEVERITY_RANK[s] > SEVERITY_RANK[best]) best = s;
  return best;
}

// ─── Region identity for blueprint row ids (SEA-1930, LA-1965, WA-1950 …) ─────
const KNOWN_METROS = {
  SEA: { label: 'Seattle, WA', state: 'WA' }, PDX: { label: 'Portland, OR', state: 'OR' },
  SF: { label: 'San Francisco, CA', state: 'CA' }, LA: { label: 'Los Angeles, CA', state: 'CA' },
  SD: { label: 'San Diego, CA', state: 'CA' }, NYC: { label: 'New York, NY', state: 'NY' },
  CHI: { label: 'Chicago, IL', state: 'IL' }, HOU: { label: 'Houston, TX', state: 'TX' },
  DAL: { label: 'Dallas, TX', state: 'TX' }, PHX: { label: 'Phoenix, AZ', state: 'AZ' },
  MIA: { label: 'Miami, FL', state: 'FL' }, ATL: { label: 'Atlanta, GA', state: 'GA' },
  BOS: { label: 'Boston, MA', state: 'MA' },
};
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

function regionIdentity(stateCode, metro) {
  if (metro) {
    const key = String(metro).toUpperCase();
    if (KNOWN_METROS[key]) return { label: KNOWN_METROS[key].label, prefix: key };
    return { label: String(metro), prefix: key.replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'MET' };
  }
  if (stateCode) {
    return { label: STATE_NAMES[stateCode] ? `${STATE_NAMES[stateCode]} (${stateCode})` : stateCode, prefix: stateCode };
  }
  return { label: 'National (US)', prefix: 'US' };
}

function eraToken(era) {
  return era.year_min === 0 ? 'pre1900' : String(era.year_min);
}

/**
 * Build the scope-of-work inspection package for a year + optional state/metro.
 * Returns a structured object the proposal engine / GHL can consume, including
 * the blueprint-aligned `categories`, `severity`, and `row`.
 */
function buildScope(input, dataset) {
  const ds = dataset || loadDataset();
  const year = Number(input.year);
  const metro = input.metro ? String(input.metro).toUpperCase() : '';
  let stateCode = input.state ? String(input.state).toUpperCase() : '';
  // A metro implies its state for regional matching (Seattle pilot: metro 'SEA' -> WA).
  if (!stateCode && metro && KNOWN_METROS[metro]) stateCode = KNOWN_METROS[metro].state;

  const era = findEra(ds, year);
  if (!era) {
    return {
      ok: false,
      reason: !Number.isFinite(year) ? 'no_valid_year' : 'year_out_of_range',
      year: input.year,
      message: 'Enter a valid build year (e.g. 1948) to generate era-based inspection items. If the year is unknown, a standard inspection scope will be used instead.'
    };
  }

  const regions = findRegions(ds, stateCode);

  // Collect inspection items across all covered systems for this era.
  const systems = ds._meta.systems_covered;
  const bySystem = {};
  const allInspect = [];

  for (const sys of systems) {
    const block = era[sys];
    if (!block) continue;
    bySystem[sys] = { likely: block.likely || [], inspect_for: block.inspect_for || [] };
    for (const item of (block.inspect_for || [])) {
      allInspect.push({ system: sys, item, source: 'era:' + era.id, category: categoryOverride(item) || CATEGORY_OF[sys] || 'Structural' });
    }
  }

  // Add region-specific inspection items (categorized by content).
  const regionItems = [];
  for (const r of regions) {
    for (const item of (r.add_inspect_for || [])) {
      const entry = { system: 'regional', item, source: 'region:' + r.id, region_label: r.label, category: categorizeRegionalItem(item) };
      allInspect.push(entry);
      regionItems.push(entry);
    }
  }

  // Dedupe inspection items by normalized text (case-insensitive, trimmed).
  const seen = new Set();
  const deduped = [];
  for (const e of allInspect) {
    const key = e.item.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    e.severity = classifySeverity(e.item);
    deduped.push(e);
  }

  // Group into the 6 blueprint categories.
  const categories = {};
  for (const cat of CATEGORY_ORDER) categories[cat] = [];
  for (const e of deduped) {
    (categories[e.category] || (categories[e.category] = [])).push({ item: e.item, severity: e.severity, source: e.source });
  }

  // High-priority flags == every High-severity item (blueprint "High" flag).
  const priorityFlags = deduped.filter(e => e.severity === 'High').map(e => e.item);
  const rowSeverity = rollupSeverity(deduped.map(e => e.severity)) || 'Low';

  const ident = regionIdentity(stateCode, metro);
  const row = eraRowFrom(era, categories, rowSeverity, ident);

  return {
    ok: true,
    year,
    state: stateCode || null,
    metro: metro || null,
    era: { id: era.id, label: era.label, range: [era.year_min, era.year_max] },
    regions_applied: regions.map(r => ({ id: r.id, label: r.label })),
    systems: bySystem,
    categories,                                   // blueprint 6 buckets -> [{item, severity, source}]
    severity: rowSeverity,                        // blueprint row-level High/Medium/Low
    inspection_items: deduped.map(e => e.item),
    inspection_items_detailed: deduped,           // now carries {category, severity}
    region_specific_items: regionItems.map(e => e.item),
    high_priority_flags: [...new Set(priorityFlags)],
    row,                                          // blueprint Layer-1 region+era row
    summary: scopeSummary(era, regions, deduped.length, priorityFlags.length, rowSeverity),
    disclaimer: ds._meta.disclaimer
  };
}

/** Assemble the blueprint Layer-1 row (one row per region+era) from grouped items. */
function eraRowFrom(era, categories, severity, ident) {
  const catText = (cat) => (categories[cat] || []).map(x => x.item).join('; ');
  const allItems = CATEGORY_ORDER.flatMap(c => (categories[c] || []).map(x => x.item));
  return {
    id: `${ident.prefix}-${eraToken(era)}`,
    region: ident.label,
    era_start: era.year_min,
    era_end: era.year_max >= 9999 ? 'Present' : era.year_max,  // don't leak the open-band sentinel
    electrical: catText('Electrical'),
    plumbing: catText('Plumbing'),
    structural: catText('Structural'),
    hvac: catText('HVAC'),
    hazards: catText('Hazards'),
    envelope: catText('Envelope'),
    inspection_items: allItems.join('; '),
    severity,
  };
}

/** Convenience: just the blueprint row for a year + optional state/metro. */
function buildEraRow(input, dataset) {
  const s = buildScope(input, dataset);
  return s.ok ? s.row : { ok: false, reason: s.reason, message: s.message };
}

/** Generate the full per-region era grid (the blueprint's Layer-1 table). */
function buildRegionGrid(input, dataset) {
  const ds = dataset || loadDataset();
  const state = input && input.state ? String(input.state) : '';
  const metro = input && input.metro ? String(input.metro) : '';
  return ds.era_bands.map(b => buildScope({ year: b.year_min, state, metro }, ds).row);
}

function scopeSummary(era, regions, itemCount, flagCount, severity) {
  const regionTxt = regions.length
    ? ' with ' + regions.map(r => r.label).join(' + ') + ' regional factors'
    : '';
  const flagTxt = flagCount
    ? ` ${flagCount} high-priority item${flagCount === 1 ? '' : 's'} flagged.`
    : '';
  return `Home built in the ${era.label} era${regionTxt}: ${itemCount} inspection item${itemCount === 1 ? '' : 's'} added to the scope of work (overall severity ${severity}).${flagTxt}`;
}

const SEV_TAG = { High: '[HIGH]', Medium: '[MED]', Low: '[LOW]' };

/** Render a human-readable scope block (for an email, proposal, or Slack). */
function renderScopeText(scope) {
  if (!scope.ok) return scope.message;
  const lines = [];
  lines.push(`SCOPE OF WORK — ERA-BASED INSPECTION ITEMS  ${SEV_TAG[scope.severity] || ''}`);
  lines.push(scope.summary);
  if (scope.row) lines.push(`Row ${scope.row.id} · ${scope.row.region} · ${scope.row.era_start}–${scope.row.era_end}`);
  lines.push('');

  // High-priority section (every High item, de-duplicated).
  const highSeen = new Set();
  const high = [];
  for (const cat of CATEGORY_ORDER) for (const it of (scope.categories[cat] || [])) {
    if (it.severity === 'High') { const k = it.item.toLowerCase(); if (!highSeen.has(k)) { highSeen.add(k); high.push(it.item); } }
  }
  if (high.length) {
    lines.push('HIGH PRIORITY (inspect first):');
    for (const f of high) lines.push('  ⚠ ' + f);
    lines.push('');
  }

  // The 6 blueprint categories, each item tagged with its severity.
  for (const cat of CATEGORY_ORDER) {
    const items = scope.categories[cat] || [];
    if (!items.length) continue;
    lines.push(cat + ':');
    for (const it of items) lines.push('  • ' + (SEV_TAG[it.severity] || '') + ' ' + it.item);
  }

  lines.push('');
  lines.push('Note: ' + scope.disclaimer);
  return lines.join('\n');
}

module.exports = {
  loadDataset, findEra, findRegions, buildScope, renderScopeText,
  classifySeverity, buildEraRow, buildRegionGrid,
  CATEGORY_OF, CATEGORY_ORDER,
};

// CSV helper for the --rows export.
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// ---- CLI usage ----
//   node lookup_engine.js <year> [stateCode]        scope for a year
//   node lookup_engine.js --rows <STATE|METRO>       blueprint Layer-1 grid (CSV)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--rows') {
    const region = args[1] || '';
    const isMetro = !!KNOWN_METROS[String(region).toUpperCase()];
    const grid = buildRegionGrid(isMetro ? { metro: region } : { state: region });
    const cols = ['id', 'region', 'era_start', 'era_end', 'severity', 'electrical', 'plumbing', 'structural', 'hvac', 'hazards', 'envelope', 'inspection_items'];
    console.log(cols.join(','));
    for (const r of grid) console.log(cols.map(c => csvCell(r[c])).join(','));
    process.exit(0);
  }
  const [yr, st] = args;
  if (!yr) {
    console.log('Usage:');
    console.log('  node lookup_engine.js <year> [stateCode]     scope for a build year');
    console.log('  node lookup_engine.js --rows <STATE|METRO>   blueprint region+era grid (CSV)');
    process.exit(0);
  }
  const scope = buildScope({ year: yr, state: st });
  console.log(renderScopeText(scope));
}
