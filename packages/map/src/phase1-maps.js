// @secforge/map/phase1-maps — write the portable, cited `phase1-maps/` bundle from an already-built
// SecForge graph. A PURE PROJECTION: no re-analysis, no LLM, no live source reads. Ported from
// codengram-master/packages/markdown-renderer/index.js (SQLite queries → in-memory Maps built once).
// Contract: README, AI_CONTEXT, graph/*.jsonl, inventories/, features/<slug>.md (13 sections),
// ledgers/<slug>.jsonl, roles/, consolidated/, manifest.json (written last). No phase2_review_queue —
// the Assess tab owns findings; §11 of each feature hands off counts only.
import fs from 'node:fs';
import path from 'node:path';
// Same reach-past-exports convention as map/src/index.js (recon/src/index.js doesn't re-export it).
import { INVENTORY_KEYS } from '../../recon/src/semantic-planner.js';
import {
  cell, list, table, interfaceOf, renderEntryPoints, renderLedger, renderCodePaths, renderAuthorization,
  renderDataExposure, renderSiblings, renderAssessHandoff, renderRoles, renderIndex, renderCoverageMatrix,
  renderSourceCoverage, renderSameFunctionality, renderArchitecture, renderGate,
} from './phase1-maps-sections.js';

const EXPORTER_VERSION = '1';
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
const handlerKey = (n) => { const f = n.data?.file || n.claims?.[0]?.file; return f ? `${f}:${n.data?.line || n.claims?.[0]?.line || 0}` : null; };
const uniq = (nodes) => [...new Map(nodes.map((n) => [n.id, n])).values()];
// File/link slug: the FEATURE id minus its prefix (unique across domains, unlike data.slug alone).
const slugOf = (f) => f.id.replace(/^feature:/, '') || f.data?.slug || 'feature';

// Build the adjacency indexes once; every renderer below reads from these.
function indexGraph(graph) {
  const nodes = graph?.nodes || [], edges = graph?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(), inn = new Map();
  const push = (m, k, e) => { if (!m.has(k)) m.set(k, []); m.get(k).push(e); };
  for (const e of edges) { push(out, e.src, e); push(inn, e.dst, e); }
  return { nodes, edges, byId, out, inn, byType: (t) => nodes.filter((n) => n.type === t) };
}

// Everything one feature document / ledger needs, derived from the feature's direct edges plus the
// one-hop edges of its endpoints and services (auth wiring, roles, data flows, boundary crossings).
function featureContext(idx, f, recon) {
  const targets = (n, ...types) => (idx.out.get(n.id) || []).filter((e) => types.includes(e.type)).map((e) => idx.byId.get(e.dst)).filter(Boolean);
  const direct = uniq((idx.out.get(f.id) || []).map((e) => idx.byId.get(e.dst)).filter(Boolean));
  const ofType = (...types) => direct.filter((n) => types.includes(n.type));
  // A bare ROUTE ("action show") whose handler file:line is already an ENDPOINT of this feature is the
  // same handler seen by two extractors — one ledger row, never two (the auth edges hang off the ENDPOINT).
  const rawEntries = ofType('ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION'), jobs = ofType('JOB');
  const handlerKeys = new Set(rawEntries.filter((n) => n.type === 'ENDPOINT').map(handlerKey).filter(Boolean));
  const entries = rawEntries.filter((n) => !(n.type === 'ROUTE' && handlerKeys.has(handlerKey(n))));
  const authCache = new Map();
  const authOf = (n) => {
    if (!authCache.has(n.id)) {
      const authn = targets(n, 'AUTHENTICATED_BY'), authz = targets(n, 'AUTHORIZED_BY', 'GUARDED_BY'), roleNodes = targets(n, 'REQUIRES_ROLE');
      authCache.set(n.id, { interface: interfaceOf(n), authn: authn.length > 0, authz: authz.length > 0,
        guards: [...new Set([...authn, ...authz].map((x) => x.name || x.id))], roles: roleNodes.map((r) => r.name), nodes: [...authn, ...authz], roleNodes });
    }
    return authCache.get(n.id);
  };
  const auth = uniq([...ofType('AUTH_CHECK', 'TOKEN'), ...entries.flatMap((n) => authOf(n).nodes)]);
  const permissions = ofType('PERMISSION');
  const roles = uniq([...entries.flatMap((n) => authOf(n).roleNodes), ...permissions.flatMap((p) => targets(p, 'REQUIRES_ROLE'))]);
  const models = ofType('MODEL', 'DATA_STORE'), services = ofType('SERVICE');
  const flows = uniq(services.flatMap((s) => targets(s, 'RETURNS_DATA')));
  const crossings = entries.flatMap((n) => targets(n, 'CROSSES_BOUNDARY').map((b) => [n, b]));
  const siblings = uniq([...(idx.out.get(f.id) || []), ...(idx.inn.get(f.id) || [])]
    .filter((e) => e.type === 'SHARES_IMPLEMENTATION_WITH')
    .map((e) => idx.byId.get(e.src === f.id ? e.dst : e.src)).filter((n) => n && n.type === 'FEATURE'));
  const rows = recon.filter((r) => r.feature_id === f.id);
  const files = [...new Set([...rows.map((r) => r.file), ...direct.flatMap((n) => (n.claims || []).map((c) => c.file))].filter(Boolean))].sort();
  return { direct, entries, jobs, authOf, auth, permissions, roles, models, services, flows, crossings, siblings, rows, files };
}

const isAuthz = (n) => n.data?.kind === 'policy' || n.data?.kind === 'ability';

function featureDoc(idx, f, recon) {
  const c = featureContext(idx, f, recon);
  const slug = slugOf(f);
  const roleText = c.roles.length ? c.roles.slice(0, 12).map((r) => `\`${r.name}\``).join(', ') : '_not established_';
  const objects = c.models.slice(0, 24).map((m) => `\`${m.name}\``).join(', ');
  const objectText = c.models.length ? `${objects}${c.models.length > 24 ? `, _… ${c.models.length - 24} more_` : ''}` : '_not established_';
  const serializers = c.services.filter((n) => n.data?.kind === 'serializer');
  return [
    `# ${f.name}`, '',
    '## 1. Feature Identity', `- Slug: \`${f.data?.slug || slug}\``, `- Domain: \`${f.data?.domain || 'core'}\``,
    `- Main business objects: ${objectText}`, `- Observed roles: ${roleText}`,
    `- Planning: \`${f.data?.planning_method || 'deterministic'}\` · confidence \`${f.data?.confidence || 'medium'}\``, '',
    '## 2. Feature Purpose', f.data?.purpose || '_n/a_', '',
    '## 3. Entry Points', renderEntryPoints(c.entries, c.jobs, c.authOf, slug), '',
    '## 4. Endpoint / Action Ledger', renderLedger(c.entries, c.authOf, slug), '',
    '## 5. Full Code Paths', renderCodePaths(c.entries, c.services, c.models), '',
    '## 6. Authorization Map', renderAuthorization(c.auth.filter(isAuthz), c.permissions, c.roles), '',
    '## 7. Authentication / Actor Context Map', renderAuthorization(c.auth.filter((n) => !isAuthz(n)), [], c.roles), '',
    '## 8. Data Exposure Map', renderDataExposure(serializers, c.flows, c.models, c.crossings, slug), '',
    '## 9. Background Job Map', list(c.jobs, slug), '',
    '## 10. Same-Functionality Map', renderSiblings(c.siblings, slugOf), '',
    '## 11. Assess Handoff', renderAssessHandoff(c.entries, c.authOf), '',
    '## 12. Files Reviewed', c.files.length
      ? [...c.files.slice(0, 140).map((x) => `- \`${x}\``), ...(c.files.length > 140 ? [`- _… ${c.files.length - 140} more; exhaustive rows are in \`../ledgers/${slug}.jsonl\`_`] : [])].join('\n')
      : '- _none_', '',
    '## 13. Coverage Notes', `- Inventory rows mapped: ${c.rows.length || f.data?.row_count || 0}`, `- Files connected: ${c.files.length}`,
    `- Entry points: ${c.entries.length}; auth checks: ${c.auth.length}; models: ${c.models.length}; services: ${c.services.length}; jobs: ${c.jobs.length}`,
    `- Depth: ${f.data?.planning_method === 'agent-lead' ? 'Lead-planned and source-grounded' : 'structure-mapped; semantic interpretation remains estimated'}.`, '',
  ].join('\n');
}

// Normalized JSONL: feature-wide context once, then every reconciliation row, then one
// source-grounded node per line (same record shapes as the reference renderer).
function featureLedger(idx, f, recon) {
  const c = featureContext(idx, f, recon);
  const authNames = c.auth.map((n) => n.name);
  const rows = [{ record_type: 'feature_summary', feature_id: f.id, feature: f.name, domain: f.data?.domain || 'core',
    mapped_inventory_rows: c.rows.length, unique_graph_nodes: c.direct.length,
    auth_check_count: authNames.length, auth_checks_sample: authNames.slice(0, 100), roles: c.roles.map((r) => r.name) }];
  rows.push(...c.rows.map((r) => ({ record_type: 'inventory_row', feature_id: f.id, inventory_id: r.id, kind: r.kind, file: r.file, line: r.line, entry: r.entry, status: r.status })));
  rows.push(...c.direct.map((n) => ({ record_type: 'mapped_node', feature_id: f.id, node_id: n.id, type: n.type, name: n.name, data: n.data || {},
    evidence: (n.claims || []).map((cl) => ({ file: cl.file, line_start: cl.line, line_end: cl.line, method: cl.method, confidence: cl.confidence })) })));
  return jsonl(rows);
}

/** Markdown for one feature, so the server can serve a single document without rendering the bundle. */
export function renderFeatureDoc(graph, featureNode, reconciliation = []) {
  return featureDoc(indexGraph(graph), featureNode, normalizeRecon(reconciliation));
}
// Reconciliation rows straight from buildGraph() carry no id; the store's rows do. Index fallback.
const normalizeRecon = (rows) => (rows || []).map((r, i) => ({ ...r, id: r.id ?? i }));

/** Write `<outDir>/phase1-maps/` from the in-memory graph. Returns { root, files }. */
export function renderPhase1Maps({ graph, reconciliation, inventories, features, project, snapshotId, coverage, provenance, outDir }) {
  if (!outDir) throw new Error('renderPhase1Maps requires outDir');
  const idx = indexGraph(graph);
  const recon = normalizeRecon(reconciliation);
  const root = path.join(outDir, 'phase1-maps');
  const files = [];
  const emit = (rel, body) => { write(path.join(root, rel), body); files.push(rel); };
  const featureNodes = idx.byType('FEATURE'), clusters = idx.byType('ARCH_CLUSTER');
  const counts = { nodes: idx.nodes.length, edges: idx.edges.length, claims: idx.nodes.reduce((s, n) => s + (n.claims || []).length, 0) };

  // graph/ — every node and edge, so nothing in the graph is dropped.
  emit('graph/nodes.jsonl', jsonl(idx.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, data: n.data || {} }))));
  emit('graph/edges.jsonl', jsonl(idx.edges.map((e) => ({ id: e.id, type: e.type, from: e.src, to: e.dst, data: e.data || {} }))));

  // inventories/ — one file per kind, one line per row, always all kinds (fixed shape every run).
  const inv = inventories || {};
  INVENTORY_KEYS.forEach((k, i) => emit(`inventories/${String(i + 1).padStart(2, '0')}_${k}.txt`,
    (inv[k] || []).map((r) => `${r.file}:${r.line} · ${r.entry}${r.detail ? ` · ${r.detail}` : ''}`).join('\n') + (inv[k]?.length ? '\n' : '')));
  emit('inventories/00_MANIFEST.md', inventoryManifest(inv, recon));

  for (const f of featureNodes) {
    emit(`features/${slugOf(f)}.md`, featureDoc(idx, f, recon));
    emit(`ledgers/${slugOf(f)}.jsonl`, featureLedger(idx, f, recon));
  }

  const roles = renderRoles(idx);
  emit('roles/role-structure.md', roles.structure);
  emit('roles/role-ability-matrix.md', roles.matrix);
  emit('roles/role_authz_source_files.txt', roles.sourceFiles);
  emit('roles/role_structure_hints.txt', roles.hints);

  const entryCount = idx.nodes.filter((n) => ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION'].includes(n.type)).length;
  if (clusters.length) emit('consolidated/architecture.md', renderArchitecture(idx, clusters, coverage));
  emit('consolidated/00_INDEX.md', renderIndex(idx, featureNodes, slugOf, entryCount));
  emit('consolidated/feature_coverage_matrix.md', renderCoverageMatrix(featureNodes, slugOf, recon, coverage, INVENTORY_KEYS));
  emit('consolidated/source_inventory_coverage_matrix.md', renderSourceCoverage(recon, INVENTORY_KEYS, inv));
  emit('consolidated/same_functionality_cross_feature_map.md', renderSameFunctionality(idx, featureNodes, clusters));
  const gate = renderGate(recon, coverage, provenance);
  emit('consolidated/phase1_completion_gate.md', gate.text);

  // Cross-check each family independently (equal sums must not hide one missing node + one extra edge).
  const projected = { nodes: countLines(path.join(root, 'graph/nodes.jsonl')), edges: countLines(path.join(root, 'graph/edges.jsonl')) };
  const ok = projected.nodes === counts.nodes && projected.edges === counts.edges;
  emit('consolidated/phase1_crosscheck_verification.md',
    `# Cross-check\n\n- graph nodes: ${counts.nodes}; projected nodes: ${projected.nodes}\n- graph edges: ${counts.edges}; projected edges: ${projected.edges}\n- graph nodes+edges: ${counts.nodes + counts.edges}\n- projected nodes+edges: ${projected.nodes + projected.edges}\n- **match: ${ok ? 'YES' : 'NO'}**\n`);

  emit('README.md', readme({ project, snapshotId, counts, features: featureNodes, clusters, coverage, provenance, gate }));
  emit('AI_CONTEXT.md', aiContext({ project, snapshotId, counts, features: featureNodes, coverage }));

  const manifestFiles = [...files, 'manifest.json'];
  emit('manifest.json', JSON.stringify({ exporter_version: EXPORTER_VERSION, project: project?.id ?? null, snapshot: snapshotId ?? null,
    counts, gate: gate.status, crosscheck: ok, engine: provenance?.engine ?? null, model: provenance?.model ?? null,
    llm_called: provenance?.llmCalled ?? null, ai_semantic: provenance?.aiSemantic ?? null,
    lead_session_id: provenance?.leadSessionId ?? null, methodology_sha: provenance?.methodologySha ?? null,
    semantic_coverage: coverage?.semantic_coverage ?? null, technical_coverage: coverage?.technical_coverage ?? null,
    feature_count: featureNodes.length, technical_clusters: clusters.length, features: (features || featureNodes).map((f) => f.slug || f.data?.slug).filter(Boolean),
    files: manifestFiles }, null, 2));
  return { root, files };
}

const countLines = (file) => { const t = fs.readFileSync(file, 'utf8'); return t ? t.split('\n').filter(Boolean).length : 0; };

function inventoryManifest(inv, recon) {
  const terminal = new Map();
  for (const r of recon) terminal.set(`${r.kind}:${r.status}`, (terminal.get(`${r.kind}:${r.status}`) || 0) + 1);
  const rows = INVENTORY_KEYS.map((kind, i) => {
    const statuses = [...terminal.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([key, n]) => `${key.slice(kind.length + 1)}=${n}`).join(', ') || 'not reconciled';
    return [String(i + 1).padStart(2, '0'), `\`${kind}\``, (inv[kind] || []).length, statuses];
  });
  return `# Source Inventory Manifest

> Deterministic, stack-neutral source facts. These inventories do not define product features, roles, or permissions;
> those are derived separately and every row is reconciled on its own.

${table(['#', 'Inventory', 'Rows', 'Terminal reconciliation'], rows)}

## Reconciliation rule

Every row must terminate as \`MAPPED_TO_FEATURE\`, \`SHARED_INFRASTRUCTURE\`, or \`UNCLEAR_COVERAGE_GAP\`.
An absent row is never treated as proof that a surface does not exist.
`;
}

const readme = ({ project, snapshotId, counts, features, clusters, coverage, provenance, gate }) => `# ${project?.name || 'SecForge'} White-Box Security Assessment — Phase 1 Artifacts

- Target: \`${project?.sourceRoot || project?.source_root || project?.id || 'unknown'}\`
- Snapshot: \`${snapshotId || ''}\`
- Engine: \`${provenance?.engine || 'rules'}\`${provenance?.model ? ` · model \`${provenance.model}\`` : ''}${provenance?.methodologySha ? ` · methodology \`${provenance.methodologySha}\`` : ''}
- Graph: ${counts.nodes} nodes · ${counts.edges} edges · ${counts.claims} provenance claims
- Features: ${features.length}${clusters.length ? ` · Technical clusters: ${clusters.length}` : ''}
- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%
- Gate: **${gate.status}**

This is **mapping, not vulnerability hunting**. No exploit work occurs in Phase 1; the Assess tab consumes this map.

## Directory layout

- \`inventories/\` — deterministic source facts and reconciliation manifest
- \`roles/\` — source-grounded actors, roles, permissions, and wiring
- \`features/\` — one 13-section feature map per mapped capability
- \`ledgers/\` — exhaustive machine-readable rows per feature
- \`consolidated/\` — coverage matrices, cross-feature links, architecture, and completion gate
- \`graph/\` — portable nodes and edges

## Method

1. **Inventories:** read-only, stack-neutral extraction of routes, APIs, GraphQL, jobs, services, policies, response
   shaping, data movement, identity clues, processes, and integrations.
2. **Feature mapping:** deterministic clustering of every inventory row into features, with per-endpoint auth wiring;
   when an LLM engine ran, an evidence-validated ontology enriches names, purposes, actors, roles, and permissions.
   Every citation points at the frozen snapshot and every inventory row is reconciled.
3. **Consolidation:** the stored graph is projected into this fixed artifact contract and cross-checked before publish.

## Depth-status meaning

| Depth | Meaning | Assess can rely? |
|---|---|---|
| Discovered | Surface found, implementation not connected | No |
| Mapped | Assigned to a grounded feature | Partially |
| Traced | Entry connected through relevant implementation | Yes, with cited gaps |
| AuthZ Verified | Actor/role/permission wiring grounded per entry | Yes |
| Deep Complete | All feature surfaces independently traced and reconciled | Yes |

## Feature queue (${features.length})

${features.length ? features.map((f) => `- \`${slugOf(f)}\` — ${cell(f.name)}`).join('\n') : '_No features were published._'}

Start with \`consolidated/phase1_completion_gate.md\`, then \`consolidated/00_INDEX.md\`.
`;

const aiContext = ({ project, snapshotId, counts, features, coverage }) => `# AI_CONTEXT — ${project?.name || 'project'}

You are reading a **code reconnaissance map** produced by SecForge (mapping only; it never asserts vulnerabilities).
Every claim is grounded to a file:line in the frozen snapshot. Coverage gaps are labelled, not hidden.

- Snapshot: \`${snapshotId || ''}\` — ${counts.nodes} nodes, ${counts.edges} edges.
- ${features.length} features across ${new Set(features.map((f) => f.data?.domain || 'core')).size} domains.
- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%.

To answer a question: start with \`consolidated/00_INDEX.md\`, read the relevant compact \`features/<slug>.md\`, then use
\`ledgers/<slug>.jsonl\` for every mapped row and its source evidence. Follow relationships in \`graph/edges.jsonl\`
(canonical direction from→to). The Markdown feature map is intentionally bounded for humans; the JSONL ledger is
exhaustive. If a fact isn't present, say "coverage gap" — do not guess. Findings belong to the Assess tab, not this map.
`;
