// @secforge/recon/semantic-planner — turns low-level inventory rows into coherent business
// capabilities. Ported from codengram-master/packages/recon/semantic-planner.js. No hardcoded
// product taxonomy: a small repo clusters by capability NOUN, a large one by MODULE directory.
// Zero deps, stdlib-only.

// ponytail: @secforge/inventories doesn't export INVENTORY_KEYS/kind lists yet (Package A is a
// placeholder as of this writing) — defined locally so B isn't blocked; D reconciles once A lands.
export const INVENTORY_KEYS = Object.freeze([
  'routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies',
  'response_shaping', 'downloads_uploads_exports', 'search_aggregation', 'tokens_actors',
  'processes_ipc', 'datastores_integrations',
]);
// Which inventories describe user-facing capabilities (→ features) vs shared infrastructure.
export const FEATURE_KINDS = new Set([
  'routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies',
  'response_shaping', 'tokens_actors', 'downloads_uploads_exports', 'search_aggregation',
]);
export const INFRA_KINDS = new Set(['processes_ipc', 'datastores_integrations']);

export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const titleize = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const singular = (s) => {
  const value = String(s || '');
  if (/(?:status|news|analysis|basis|series|species)$/i.test(value)) return value;
  if (value.length > 4 && /ies$/i.test(value)) return value.slice(0, -3) + 'y';
  if (value.length > 4 && /(?:ches|shes|xes|zes)$/i.test(value)) return value.slice(0, -2);
  return value.length > 3 && /s$/i.test(value) && !/(?:ss|us|is)$/i.test(value) ? value.slice(0, -1) : value;
};
const STRIP_SUFFIX = /_(controller|service|finder|policy|worker|job|type|serializer|presenter|resolver|mutation|ability|spec|test)$/;
const STRIP_VERB = /^(create|update|delete|destroy|list|show|new|edit|fetch|get|build|generate|bulk)_/;

// The module/domain a file belongs to — works across ecosystems (Rails app/<domain>, monorepo
// packages/<pkg>, Django <app>/, src/<module>, …). Falls back to the top directory, then 'core'.
function moduleOf(file) {
  const generic = /^(controllers?|services?|models?|views?|helpers?|utils?|lib|libs|src|common|core|main|index|tests?|spec|dist|private|shared|internal|handlers?|routes?|api|app)$/i;
  const m = file.match(/(?:^|\/)(?:apps|packages|services|modules|features|domains?|bundles|plugins)\/([^/]+)\//i);
  if (m && m[1] && !generic.test(m[1])) return slug(m[1]);
  const rails = file.match(/(?:app|lib)\/(?:controllers|services|finders|policies|workers|graphql)\/([^/]+)\/[^/]+$/)?.[1];
  if (rails && !generic.test(rails)) return slug(rails);
  return 'core';
}
// A LARGE, generic repo clusters by module directory (tens of real modules, not thousands of
// one-file features): pick the first meaningful path segment, skipping framework-structural roots.
const GENERIC_SEG = /^(controllers?|services?|models?|views?|helpers?|utils?|util|lib|libs|src|source|common|core|main|index|tests?|spec|specs|dist|build|private|public|shared|internal|handlers?|routes?|route|api|app|apps|packages|package|bundle|bundles|vendor|includes?|inc|classes?|class|modules?|component|components|pkg|cmd|domain|domains|feature|features|3rdparty|node_modules)$/i;
export function moduleCluster(row) {
  const segs = String(row.file || '').split('/').filter(Boolean); segs.pop();
  let mod = segs.find((s) => !GENERIC_SEG.test(s) && !s.includes('.'));
  if (!mod) mod = [...segs].reverse().find((s) => !GENERIC_SEG.test(s) && !s.includes('.')) || 'core';
  mod = singular(slug(mod) || 'core');
  const file = String(row.file || '');
  const domain = /^(?:apps|plugins|extensions)\//i.test(file) ? 'applications'
    : /^(?:packages|modules|services|bundles)\//i.test(file) ? 'modules' : 'core';
  return { domain, slug: mod, name: titleize(mod) };
}
export function fallbackKey(row) {
  const file = String(row.file || '');
  const entry = String(row.entry || '');
  const resource = entry.match(/resources?\s+:(\w+)/)?.[1];
  const routePath = entry.match(/(?:get|post|put|patch|delete|match)\s+['"]\/?([^/'"]+)/i)?.[1];
  let noun = resource || routePath || file.split('/').pop()?.replace(/\.[^.]+$/, '') || 'misc';
  noun = singular(slug(noun.replace(STRIP_SUFFIX, '').replace(STRIP_VERB, ''))) || 'misc';
  return { domain: moduleOf(file), slug: noun, name: titleize(noun) };
}

export function inventoryRows(inventories) {
  const rows = [];
  for (const kind of INVENTORY_KEYS) if (FEATURE_KINDS.has(kind)) {
    for (const row of inventories[kind] || []) rows.push({ kind, row, key: `${kind}:${row.file}:${row.line}:${row.entry}` });
  }
  return rows;
}

// ONE universal rule for every language — NO hardcoded taxonomy. A large codebase clusters by
// MODULE directory (its real modules), a small one by capability NOUN. Precision beyond structure
// comes from validateLeadPlan (reads the actual code via the AI ontology), never a curated list.
export function deterministicSemanticPlan(inventories, { moduleThreshold = 80, splitThreshold = 40 } = {}) {
  const rows = inventoryRows(inventories);
  const bigRepo = rows.length >= moduleThreshold;
  const features = new Map();
  for (const wrapped of rows) {
    const selected = bigRepo ? moduleCluster(wrapped.row) : fallbackKey(wrapped.row);
    const key = bigRepo ? `${selected.domain}/${selected.slug}` : selected.slug;
    if (!features.has(key)) features.set(key, { slug: selected.slug, domain: selected.domain, name: selected.name, rows: [],
      confidence: 'low', planning_method: bigRepo ? 'module-cohesion' : 'local-cohesion' });
    else if (!bigRepo && features.get(key).domain === 'core' && selected.domain !== 'core') features.get(key).domain = selected.domain;
    features.get(key).rows.push({ kind: wrapped.kind, row: wrapped.row });
  }
  // Second level, rules-only precision: a MODULE cluster that lumps more than `splitThreshold` rows
  // (a flat Rails app/, one big src/) is re-partitioned by capability NOUN (route resource / file
  // stem) so a no-LLM map still reads "Rails Api · Expense", "Rails Api · Approval" instead of one
  // 70-endpoint blob. Singleton nouns stay together in "<Module> · Other" — never 1-row features.
  const out = [];
  for (const f of features.values()) {
    if (!bigRepo || f.rows.length <= splitThreshold) { out.push(f); continue; }
    const byNoun = new Map();
    for (const r of f.rows) { const n = fallbackKey(r.row); const k = n.slug || 'other'; if (!byNoun.has(k)) byNoun.set(k, { slug: k, name: n.name, rows: [] }); byNoun.get(k).rows.push(r); }
    const other = { slug: `${f.slug}-other`, domain: f.domain, name: `${f.name} · Other`, rows: [], confidence: 'low', planning_method: 'module-noun-cohesion' };
    for (const n of byNoun.values()) {
      if (n.rows.length < 2) { other.rows.push(...n.rows); continue; }
      out.push({ slug: `${f.slug}-${n.slug}`, domain: f.domain, name: `${f.name} · ${n.name}`, rows: n.rows, confidence: 'low', planning_method: 'module-noun-cohesion' });
    }
    if (other.rows.length) out.push(other);
  }
  return out.sort((a, b) => a.domain.localeCompare(b.domain) || a.slug.localeCompare(b.slug));
}

// Context-budget scaffolding for the AI-semantic layer: a BOUNDED summary of the deterministic
// technical clusters — name, domain, representative paths, per-kind counts, sample entries — with
// each sample carrying {kind, file, line, entry} verbatim (the model never re-reads the file
// itself over the one-shot adapter, so the line number must be handed over for it to cite anything
// legitimately).
export function summarizeClusters(clusters, { maxClusters = 400, samplesPerCluster = 4 } = {}) {
  const top = clusters.slice(0, maxClusters);
  return top.map((c) => {
    const kinds = {}; for (const { kind } of c.rows) kinds[kind] = (kinds[kind] || 0) + 1;
    const dirs = new Set(); for (const { row } of c.rows) { const p = String(row.file || '').split('/').slice(0, 3).join('/'); if (p) dirs.add(p); if (dirs.size >= 6) break; }
    const samples = c.rows.slice(0, samplesPerCluster).map(({ kind, row }) => ({ kind, file: row.file, line: row.line, entry: String(row.entry || '').slice(0, 120) }));
    return { slug: c.slug, domain: c.domain, name: c.name, row_count: c.rows.length, kinds, paths: [...dirs], samples };
  });
}

// Turn the AI-derived, evidence-validated ontology's feature SELECTORS into actual inventory-row
// membership — scored by explicit inventory_keys > include_paths > include_symbols >
// include_entries > include_terms, then a directory-inheritance second pass. Rows no feature
// claimed become archClusters (never silently dropped, never promoted to a feature).
export function validateLeadPlan(plan, inventories) {
  if (!plan || !Array.isArray(plan.features) || !plan.features.length) return null;
  const sourceRows = inventoryRows(inventories);
  const claimed = new Set(), definitions = [];
  for (const raw of plan.features) {
    const featureSlug = slug(raw.slug || raw.name), domain = slug(raw.domain || 'core');
    if (!featureSlug) continue;
    definitions.push({ slug: featureSlug, domain, name: String(raw.name || titleize(featureSlug)).slice(0, 100),
      purpose: String(raw.purpose || '').trim().slice(0, 1200), rows: [],
      evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
      actors: Array.isArray(raw.actors) ? raw.actors : [],
      permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
      explicit: new Set(Array.isArray(raw.inventory_keys) ? raw.inventory_keys : []),
      paths: (raw.include_paths || []).map((p) => String(p).toLowerCase()).filter(Boolean),
      terms: (raw.include_terms || []).map((p) => String(p).toLowerCase()).filter((p) => p.length > 2),
      symbols: (raw.include_symbols || []).map((p) => String(p).toLowerCase()).filter((p) => p.length > 2),
      entries: (raw.include_entries || []).map((p) => String(p).toLowerCase()).filter((p) => p.length > 2),
      excludePaths: (raw.exclude_paths || []).map((p) => String(p).toLowerCase()).filter(Boolean),
      excludeTerms: (raw.exclude_terms || []).map((p) => String(p).toLowerCase()).filter((p) => p.length > 2),
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
      planning_method: 'agent-lead' });
  }
  for (const item of sourceRows) {
    const file = String(item.row.file || '').toLowerCase();
    const entry = String(item.row.entry || '').toLowerCase();
    const text = `${file} ${entry} ${item.row.detail || ''}`.toLowerCase();
    let winner = null;
    for (const def of definitions) {
      if (def.excludePaths.some((p) => file.includes(p)) || def.excludeTerms.some((p) => text.includes(p))) continue;
      let score = def.explicit.has(item.key) ? 10_000 : 0;
      for (const p of def.paths) if (file.includes(p)) score += 100 + p.length;
      for (const symbol of def.symbols) if (text.includes(symbol)) score += 80 + symbol.length;
      for (const selectedEntry of def.entries) if (entry.includes(selectedEntry)) score += 120 + selectedEntry.length;
      for (const term of def.terms) if (text.includes(term)) score += 10 + term.length;
      if (score > 0 && (!winner || score > winner.score || (score === winner.score && def.slug < winner.def.slug))) winner = { def, score };
    }
    if (winner) { winner.def.rows.push({ kind: item.kind, row: item.row }); claimed.add(item.key); }
  }

  // SECOND PASS — directory inheritance (coverage, evidence-grounded, NOT name-based): a feature
  // the Lead confirmed owns the directories its claimed rows live in, so an unmatched sibling row
  // inherits that owner (deepest specific dir, ≥60% majority). No owned dir → stays in archClusters.
  const GENERIC_DIR = /^(app|apps|lib|libs|src|source|core|common|main|config|test|tests|spec|specs|vendor|node_modules|public|private|internal|shared|dist|build|packages|modules|bundles|components|controllers|models|views|helpers|policies|workers|jobs|finders|serializers|presenters|services|api|apis|graphql|routes|handlers|util|utils)$/i;
  const dirClaims = new Map();
  for (const def of definitions) for (const { row } of def.rows) {
    const segs = String(row.file || '').split('/'); segs.pop();
    if (segs.length < 2) continue;
    const dir = segs.join('/'); if (!dirClaims.has(dir)) dirClaims.set(dir, new Map());
    const m = dirClaims.get(dir); m.set(def, (m.get(def) || 0) + 1);
  }
  const dirOwner = new Map();
  for (const [dir, m] of dirClaims) {
    if (GENERIC_DIR.test(dir.split('/').pop())) continue;
    let total = 0, best = null; for (const [def, n] of m) { total += n; if (!best || n > best.n) best = { def, n }; }
    if (best && best.n / total >= 0.6) dirOwner.set(dir, best.def);
  }
  for (const item of sourceRows) {
    if (claimed.has(item.key)) continue;
    const segs = String(item.row.file || '').split('/'); segs.pop();
    while (segs.length >= 2) { const dir = segs.join('/'); if (dirOwner.has(dir)) { dirOwner.get(dir).rows.push({ kind: item.kind, row: item.row }); claimed.add(item.key); break; } segs.pop(); }
  }

  const leadFeatures = definitions.filter((d) => d.rows.length)
    .map(({ explicit, paths, terms, symbols, entries, excludePaths, excludeTerms, ...d }) => d);
  if (!leadFeatures.length) return null;
  // Coalesce duplicate Lead definitions (same domain/slug) so one capability is never rendered twice.
  const merged = new Map();
  for (const feature of leadFeatures) {
    const key = `${feature.domain}/${feature.slug}`;
    if (!merged.has(key)) { merged.set(key, { ...feature, rows: [...feature.rows] }); continue; }
    const current = merged.get(key);
    const seen = new Set(current.rows.map(({ kind, row }) => `${kind}:${row.file}:${row.line}:${row.entry}`));
    for (const wrapped of feature.rows) { const sig = `${wrapped.kind}:${wrapped.row.file}:${wrapped.row.line}:${wrapped.row.entry}`; if (!seen.has(sig)) { seen.add(sig); current.rows.push(wrapped); } }
  }
  // STRICT RULE: rows the Lead did NOT confirm are NEVER features — preserved as technical
  // ARCHITECTURE (directory clusters), never silently dropped, never dressed up as a capability.
  const missing = sourceRows.filter((r) => !claimed.has(r.key));
  let archClusters = [];
  if (missing.length) {
    const fallbackInventories = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));
    for (const m of missing) fallbackInventories[m.kind].push(m.row);
    archClusters = deterministicSemanticPlan(fallbackInventories).map((f) => ({ ...f, planning_method: 'lead-gap-fallback' }));
  }
  return { features: [...merged.values()], archClusters };
}
