// @secforge/map/phase1-maps-sections — section renderers for the portable `phase1-maps/` bundle.
// Pure string functions over the in-memory graph index built by phase1-maps.js (no I/O, no
// re-analysis). Ported from codengram-master/packages/markdown-renderer/index.js and adapted to
// SecForge's array graph: per-endpoint auth comes from edges touching THAT endpoint, never from a
// shared same-file heuristic.

export const cell = (v) => String(v == null || v === '' ? '—' : v).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
// Every cited line comes from node.claims[0] first, then data.file/line — never invented.
export const sourceRef = (n) => {
  const c = n?.claims?.[0];
  if (c?.file) return `${c.file}:${c.line || 1}`;
  return n?.data?.file ? `${n.data.file}:${n.data.line || 1}` : '';
};
export const cite = (n) => { const s = sourceRef(n); return s ? `\`${s}\`` : ''; };
const withCite = (n) => `${n.name || n.id}${cite(n) ? ' ' + cite(n) : ''}`;
export const table = (header, rows) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
export const list = (nodes, slug, max = 60) => nodes.length
  ? [...nodes.slice(0, max).map((n) => `- ${withCite(n)}`),
    ...(nodes.length > max ? [`- _… ${nodes.length - max} more in \`../ledgers/${slug}.jsonl\`_`] : [])].join('\n')
  : '- _none found_';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isStateChanging = (n) => STATE_CHANGING.has(String(n.data?.method || '').toUpperCase());
export const interfaceOf = (n) => n.data?.interface_kind || (n.type === 'GRAPHQL_OPERATION' ? 'graphql' : n.type === 'JOB' ? 'worker' : 'web');

// Empty-state tokens (spec): "not extracted" is NEVER "none exist". A channel the extractors cover
// but this feature has none of → COVERAGE_GAP. A channel no extractor covers (RPC/WS/CLI/Events) →
// EXTRACTOR_UNSUPPORTED.
const emptyLine = (title, state) => state === 'EXTRACTOR_UNSUPPORTED'
  ? `**EXTRACTOR_UNSUPPORTED** — _no extractor covers ${title.toLowerCase()} for this stack; absence here is not evidence that none exist._`
  : `**COVERAGE_GAP** — _no ${title.toLowerCase()} entries were mapped to this feature; an explicit gap, not proof that none exist._`;

// §3 — the 8 channels the contract requires, each a table when populated else the honest token.
export function renderEntryPoints(entries, jobs, authOf, slug) {
  const blocks = [];
  const max = 80;
  const add = (title, header, rows, values, emptyState = 'COVERAGE_GAP') => {
    blocks.push(`### ${title}`);
    if (!rows.length) { blocks.push(emptyLine(title, emptyState), ''); return; }
    blocks.push(table(header, rows.slice(0, max).map(values)));
    if (rows.length > max) blocks.push(`_… ${rows.length - max} more ${title.toLowerCase()} entries in \`../ledgers/${slug}.jsonl\`._`);
    blocks.push('');
  };
  const notes = (n) => { const g = authOf(n).guards; return g.length ? g.join('; ') : 'no per-endpoint guard mapped'; };
  const purpose = (n, fallback) => n.data?.purpose || fallback;
  const of = (k) => entries.filter((n) => interfaceOf(n) === k);
  const web = entries.filter((n) => !['rest', 'graphql', 'rpc', 'websocket', 'cli', 'event'].includes(interfaceOf(n)));
  const rest = of('rest'), graphql = of('graphql'), rpc = of('rpc'), ws = of('websocket'), cli = of('cli'), events = of('event');
  const unsupported = (rows) => (rows.length ? 'COVERAGE_GAP' : 'EXTRACTOR_UNSUPPORTED');
  add('Web Routes / Controllers', ['Route/Action', 'Handler', 'Method', 'Purpose', 'Auth/Authz Notes'], web,
    (n) => [n.name || n.id, sourceRef(n), n.data?.method, purpose(n, 'Web controller action'), notes(n)]);
  add('REST API', ['Endpoint', 'Handler', 'Method', 'Purpose', 'Auth/Authz Notes'], rest,
    (n) => [n.data?.route || n.name || n.id, sourceRef(n), n.data?.method, purpose(n, 'REST API operation'), notes(n)]);
  add('GraphQL', ['Query/Mutation/Resolver', 'File', 'Purpose', 'Auth/Authz Notes'], graphql,
    (n) => [n.name || n.id, sourceRef(n), purpose(n, n.data?.operation_type ? `GraphQL ${n.data.operation_type} ${n.data.field_name}` : 'GraphQL field, mutation, or resolver'), notes(n)]);
  add('RPC', ['Method', 'Service/File', 'Purpose', 'Auth/Authz Notes'], rpc,
    (n) => [n.name || n.id, sourceRef(n), purpose(n, 'RPC method'), notes(n)], unsupported(rpc));
  add('WebSocket', ['Channel/Event', 'File', 'Purpose', 'Auth/Authz Notes'], ws,
    (n) => [n.name || n.id, sourceRef(n), purpose(n, 'WebSocket channel'), notes(n)], unsupported(ws));
  add('CLI', ['Command', 'File', 'Purpose', 'Auth/Authz Notes'], cli,
    (n) => [n.name || n.id, sourceRef(n), purpose(n, 'CLI command'), notes(n)], unsupported(cli));
  add('Workers / Async', ['Worker', 'Enqueued From', 'Inputs', 'Purpose', 'Auth/Authz Notes'], jobs,
    (n) => [n.name || n.id, n.data?.enqueued_from || sourceRef(n), n.data?.inputs || 'Not mapped', purpose(n, 'Background job or enqueue'), 'Shared control / not mapped to this entry']);
  add('Events', ['Event', 'Emitted From', 'Purpose', 'Auth/Authz Notes'], events,
    (n) => [n.name || n.id, sourceRef(n), purpose(n, 'Domain/event emission'), notes(n)], unsupported(events));
  return blocks.join('\n');
}

// §4 — PER-ENDPOINT ledger: ✓/✗ computed from the edges touching that one endpoint.
export function renderLedger(entries, authOf, slug) {
  if (!entries.length) return '_no entry points_';
  const max = 200;
  const rows = entries.slice(0, max).map((n) => {
    const a = authOf(n);
    return [a.interface, n.data?.method, n.data?.route || n.data?.path || n.name || n.id, sourceRef(n),
      a.authn ? '✓' : '✗', a.authz ? '✓' : '✗', a.guards.join(', '), a.roles.join(', '), 'mapped'];
  });
  return table(['Interface', 'Method', 'Route / action', 'Handler (file:line)', 'Authn', 'Authz', 'Guards', 'Roles', 'Status'], rows)
    + (entries.length > max ? `\n\n_… ${entries.length - max} more ledger rows in \`../ledgers/${slug}.jsonl\`._` : '');
}

// §5 — entry → handler file. Services/models are feature-level: the graph carries no per-endpoint call
// edges, so they are listed once instead of being pasted onto every entry as if traced.
export function renderCodePaths(entries, services, models) {
  if (!entries.length) return '_no executable entry path mapped_';
  const rows = entries.slice(0, 50).map((n) => `- **${n.name || n.id}** → \`${sourceRef(n) || 'handler coverage gap'}\``);
  if (entries.length > 50) rows.push(`- _… ${entries.length - 50} more paths in the exhaustive feature ledger._`);
  const names = (list) => list.slice(0, 12).map((x) => `\`${x.name}\``).join(', ') + (list.length > 12 ? `, _… ${list.length - 12} more_` : '');
  const shared = [];
  if (services.length) shared.push(`- Services used by this feature (feature-level, not traced per entry): ${names(services)}`);
  if (models.length) shared.push(`- Data touched: ${names(models)}`);
  return [...rows, ...(shared.length ? ['', ...shared] : [])].join('\n');
}

// §6 / §7 — one table shape for both the authorization and the authentication/actor maps.
export function renderAuthorization(checks, permissions, roles) {
  if (!checks.length && !permissions.length && !roles.length) return '_no grounded authorization context mapped_';
  const permText = permissions.map((p) => p.name).slice(0, 6).join(', ');
  const roleText = roles.map((r) => r.name).slice(0, 6).join(', ');
  const rows = checks.slice(0, 60).map((n) => [n.name, n.data?.kind, permText, roleText, cite(n)]);
  if (!rows.length) rows.push(['_implicit / shared_', '—', permissions.map((p) => p.name).join(', '), roles.map((r) => r.name).join(', '), '—']);
  return table(['Check', 'Kind', 'Permissions', 'Roles', 'Evidence'], rows);
}

// §8 — serializers, data flows, models, then the trust boundaries this feature's endpoints cross.
export function renderDataExposure(serializers, flows, models, crossings, slug) {
  return [list([...serializers, ...flows, ...models], slug), '', '### Trust boundary crossings',
    crossings.length ? crossings.slice(0, 60).map(([ep, b]) => `- ${ep.name || ep.id} → ${b.name || b.id}${cite(ep) ? ' ' + cite(ep) : ''}`).join('\n') : '- _none recorded_',
  ].join('\n');
}

// §10 — siblings linked to their own feature document.
export const renderSiblings = (siblings, slugOf) => siblings.length
  ? siblings.map((s) => `- [${s.name}](./${slugOf(s)}.md) — shares implementation`).join('\n')
  : '- _no shared implementation detected_';

// §11 — counts only. Findings are the Assess tab's job, never this document's.
export function renderAssessHandoff(entries, authOf) {
  let authn = 0, authz = 0, unguarded = 0;
  for (const n of entries) {
    const a = authOf(n);
    if (a.authn) authn++;
    if (a.authz) authz++;
    if (isStateChanging(n) && !a.authz) unguarded++;
  }
  return [`- Endpoints total: ${entries.length}`, `- With authentication edge: ${authn}`,
    `- With authorization/guard edge: ${authz}`, `- State-changing without authorization: ${unguarded}`, '',
    'Vulnerability assessment is performed by the Assess tab over this map; this document asserts no findings.'].join('\n');
}

// roles/ — actor catalog + role ladder + ability matrix. Wiring: role→permission from GRANTS edges
// and from AUTHORIZED_BY edges whose src is a role; actor→role from HAS_ROLE.
export function renderRoles(idx) {
  const roles = idx.byType('ROLE'), actors = idx.byType('ACTOR'), perms = idx.byType('PERMISSION');
  const enables = new Map(roles.map((r) => [r.id, new Set()]));
  for (const e of idx.edges) {
    if ((e.type === 'GRANTS' || (e.type === 'AUTHORIZED_BY' && e.src.startsWith('role:'))) && enables.has(e.src)) enables.get(e.src).add(e.dst);
  }
  const rolesOf = (a) => (idx.out.get(a.id) || []).filter((e) => e.type === 'HAS_ROLE').map((e) => idx.byId.get(e.dst)?.name).filter(Boolean);
  const nonHuman = actors.filter((a) => a.data?.kind && a.data.kind !== 'human');
  const structure = [
    '# Role & Actor Structure', '',
    '> Source-grounded identity model projected from the mapped graph. Actor = who acts; role = privilege level; permission = ability. These are distinct axes.', '',
    `## Actors (${actors.length})`, '',
    actors.length ? table(['Actor', 'Roles', 'Obtained via', 'Hierarchical', 'Source'],
      actors.map((a) => [a.name, rolesOf(a).join(', '), a.data?.obtained_via, a.data?.hierarchical ? 'yes' : 'no', sourceRef(a)])) : '_none established_', '',
    `## Role ladder (${roles.length})`, '',
    roles.length ? table(['Role', 'Scope', 'Obtained via', 'Hierarchical', 'Abilities enabled', 'Source'],
      roles.map((r) => [r.name, r.data?.scope || 'not mapped', r.data?.obtained_via || 'not mapped', r.data?.hierarchical ? 'yes' : 'no', enables.get(r.id).size, sourceRef(r)]))
      : '_COVERAGE GAP — no authoritative role definition was established._', '',
    '## Token / non-human actors', '',
    nonHuman.length ? table(['Actor', 'Kind', 'Obtained via', 'Scopes', 'Source'],
      nonHuman.map((a) => [a.name, a.data.kind, a.data?.obtained_via || 'not mapped', (a.data?.scopes || []).join(', ') || 'not mapped', sourceRef(a)]))
      : '_COVERAGE GAP — no token or non-human actor was established._', '',
  ].join('\n');
  const cols = roles.slice(0, 24);
  const matrix = ['# Role → Ability Matrix', '', `- Roles: ${roles.length} · Abilities: ${perms.length}`, '',
    perms.length && cols.length
      ? table(['Ability', ...cols.map((r) => r.name), 'Source'],
        perms.slice(0, 400).map((p) => [p.name, ...cols.map((r) => (enables.get(r.id).has(p.id) ? '✓' : '○')), sourceRef(p)]))
      : '_no grounded role→ability wiring derived_', ''].join('\n');
  const identity = [...actors, ...roles, ...perms];
  const files = [...new Set(identity.flatMap((n) => (n.claims || []).map((c) => c.file)).filter(Boolean))].sort();
  const sourceFiles = files.join('\n') + (files.length ? '\n' : '');
  const hints = identity.length
    ? identity.map((n) => `${n.type}\t${n.name}\t${sourceRef(n) || 'source gap'}`).join('\n') + '\n'
    : 'COVERAGE_GAP\tNo source-grounded actor, role, or permission ontology was established.\n';
  return { structure, matrix, sourceFiles, hints };
}

// consolidated/00_INDEX.md — the 21 required outputs; feature queue grouped by DOMAIN node.
export function renderIndex(idx, features, slugOf, entryCount) {
  const required = [
    ['Application architecture overview', '../README.md + per-feature Feature Identity/Purpose'],
    ['Feature coverage matrix', 'feature_coverage_matrix.md'],
    ['File-to-feature map', '../features/*.md — Files Reviewed'],
    ['Entry-point-to-feature map', '../features/*.md — Entry Points'],
    ['Authorization map', '../features/*.md — Authorization Map'],
    ['Authentication/actor map', '../features/*.md — Authentication / Actor Context Map'],
    ['API map', '../inventories/*rest_api* + feature REST tables'],
    ['GraphQL map', '../inventories/*graphql* + feature GraphQL tables'],
    ['Worker/background job map', '../inventories/*workers_jobs* + feature job tables'],
    ['Serializer/entity/presenter map', '../inventories/*response_shaping* + Data Exposure maps'],
    ['Search/export/download map', '../inventories/*search* and *downloads*'],
    ['Token flow map', '../inventories/*tokens_actors* + role structure'],
    ['Same-functionality cross-feature map', 'same_functionality_cross_feature_map.md'],
    ['Shared infrastructure map', 'same_functionality_cross_feature_map.md'],
    ['Unmapped files/directories', 'phase1_completion_gate.md + Architecture'],
    ['Assess handoff (per-feature §11)', '../features/*.md — Assess Handoff'],
    ['Source inventory coverage matrix', 'source_inventory_coverage_matrix.md'],
    [`Endpoint/action ledger (${entryCount} graph rows)`, '../features/*.md + ../ledgers/*.jsonl'],
    ['Role / actor catalog + role ladder', '../roles/role-structure.md'],
    ['Role → ability matrix', '../roles/role-ability-matrix.md'],
    ['Token / non-human actor map', '../roles/role-structure.md — token actor table'],
  ];
  const featureIds = new Set(features.map((f) => f.id));
  const grouped = idx.byType('DOMAIN').map((d) => {
    const fs = (idx.out.get(d.id) || []).filter((e) => e.type === 'CONTAINS' && featureIds.has(e.dst)).map((e) => idx.byId.get(e.dst));
    return `## ${d.name}\n${fs.map((f) => `- [${f.name}](../features/${slugOf(f)}.md)`).join('\n') || '- _none_'}`;
  });
  return `# Phase 1 Artifact Index

## Required outputs (21/21 accounted)

${table(['#', 'Required output', 'Artifact / status'], required.map(([name, where], i) => [i + 1, name, where]))}

## Feature queue (${features.length})

${grouped.join('\n\n') || '_No features were published._'}

## Reading order for Assess

1. \`phase1_completion_gate.md\`
2. \`same_functionality_cross_feature_map.md\`
3. \`../features/<slug>.md\` (§11 Assess Handoff) and \`../ledgers/<slug>.jsonl\`
`;
}

// consolidated/feature_coverage_matrix.md — features × inventory kinds, counts from reconciliation.
export function renderCoverageMatrix(features, slugOf, recon, coverage, kinds) {
  const count = new Map();
  for (const r of recon) if (r.feature_id) count.set(`${r.feature_id}|${r.kind}`, (count.get(`${r.feature_id}|${r.kind}`) || 0) + 1);
  const rows = features.map((f) => [`[${f.name}](../features/${slugOf(f)}.md)`, ...kinds.map((k) => count.get(`${f.id}|${k}`) || 0), f.data?.row_count || 0]);
  return `# Coverage Matrix

- Semantic coverage (mapped to features): ${coverage?.semantic_coverage ?? 0}%
- Technical coverage (source represented): ${coverage?.technical_coverage ?? '?'}%
- Features: ${features.length} · Mapped rows: ${coverage?.feature_rows ?? '?'} · Total inventory rows: ${coverage?.total_rows ?? '?'}

${rows.length ? table(['Feature', ...kinds, 'Rows'], rows) : '_none — no features derived_'}
`;
}

// consolidated/source_inventory_coverage_matrix.md — kind × reconciliation status.
export function renderSourceCoverage(recon, kinds, inventories) {
  const byKind = new Map(kinds.map((k) => [k, new Map()]));
  for (const r of recon) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, new Map());
    byKind.get(r.kind).set(r.status, (byKind.get(r.kind).get(r.status) || 0) + 1);
  }
  const rows = [...byKind.entries()].map(([kind, statuses]) => {
    const total = [...statuses.values()].reduce((s, n) => s + n, 0) || (inventories?.[kind] || []).length;
    return [`\`${kind}\``, total, [...statuses.entries()].map(([s, n]) => `${s}=${n}`).join(', ') || 'not reconciled'];
  });
  return `# Source Inventory Coverage Matrix

${table(['Inventory', 'Extracted rows', 'Reconciliation'], rows)}

Rows attached to technical clusters (ARCH_CLUSTER) remain coverage gaps; they are not semantic feature coverage.
`;
}

// consolidated/same_functionality_cross_feature_map.md
export function renderSameFunctionality(idx, features, clusters) {
  const names = new Map(features.map((f) => [f.id, f.name]));
  const shares = idx.edges.filter((e) => e.type === 'SHARES_IMPLEMENTATION_WITH' && names.has(e.src) && names.has(e.dst));
  const shared = idx.nodes.filter((n) => ['SERVICE', 'AUTH_CHECK', 'MODEL'].includes(n.type))
    .map((n) => ({ n, users: new Set((idx.inn.get(n.id) || []).map((e) => e.src).filter((s) => names.has(s))).size }))
    .filter((x) => x.users > 1).sort((a, b) => b.users - a.users || (a.n.name > b.n.name ? 1 : -1));
  return `# Same-Functionality & Shared-Implementation Map

## Feature siblings

${shares.length ? table(['Feature A', 'Feature B', 'Evidence relationship'], shares.map((e) => [names.get(e.src), names.get(e.dst), 'shared implementation'])) : '_No source-grounded sibling relationship was established._'}

## Shared infrastructure

${shared.length ? table(['Kind', 'Component', 'Feature users'], shared.map(({ n, users }) => [n.type, n.name, users])) : '_No component was linked to multiple mapped features._'}

## Technical clusters not accepted as features

${clusters.length ? clusters.map((c) => `- ${c.name} (${c.data?.row_count || 0} rows) — architecture/coverage gap`).join('\n') : '_none_'}
`;
}

// consolidated/architecture.md — ARCH_CLUSTER nodes grouped by domain (only emitted when any exist).
export function renderArchitecture(idx, clusters, coverage) {
  const byDomain = new Map();
  for (const c of clusters) { const d = c.data?.domain || 'core'; if (!byDomain.has(d)) byDomain.set(d, []); byDomain.get(d).push(c); }
  const sections = [...byDomain.entries()].sort().map(([d, cs]) => `## ${d}\n\n${table(['Technical cluster', 'Rows', 'Method', 'Note'],
    cs.sort((a, b) => (a.name > b.name ? 1 : -1)).map((c) => [c.name, (idx.out.get(c.id) || []).length || c.data?.row_count || 0, c.data?.planning_method || 'module-cohesion', c.data?.note]))}`);
  return `# Architecture — Technical Clusters (NOT business features)

> Directory/namespace groupings whose rows did not resolve to a confirmed feature. Code structure only; every row
> under a cluster is an honest UNCLEAR_COVERAGE_GAP in the reconciliation ledger.

- Technical clusters: ${clusters.length}
- Technical coverage (source files represented): ${coverage?.technical_coverage ?? '?'}%
- Semantic coverage (mapped to features): ${coverage?.semantic_coverage ?? 0}%

${sections.join('\n\n')}
`;
}

// consolidated/phase1_completion_gate.md — COMPLETE iff zero UNCLEAR_COVERAGE_GAP rows.
export function renderGate(recon, coverage, provenance) {
  const terminal = {}, gaps = {};
  for (const r of recon) {
    terminal[r.status] = (terminal[r.status] || 0) + 1;
    if (r.status === 'UNCLEAR_COVERAGE_GAP') gaps[r.kind] = (gaps[r.kind] || 0) + 1;
  }
  const status = Object.keys(gaps).length ? 'COMPLETE_WITH_GAPS' : 'COMPLETE';
  const text = `# Completion Gate

- Status: **${status}**
- Executed engine: \`${provenance?.engine || 'unknown'}\` · model \`${provenance?.model || 'none'}\` · LLM called: ${provenance?.llmCalled ? 'yes' : 'no'} · AI semantic: ${provenance?.aiSemantic ? 'yes' : 'no'}${provenance?.leadSessionId ? ` · Lead session \`${provenance.leadSessionId}\`` : ''}${provenance?.methodologySha ? ` · methodology \`${provenance.methodologySha}\`` : ''}
- Semantic coverage: ${coverage?.semantic_coverage ?? 0}% · Technical coverage: ${coverage?.technical_coverage ?? '?'}%
- Gaps (UNCLEAR_COVERAGE_GAP by inventory kind): ${Object.keys(gaps).length ? Object.entries(gaps).map(([k, n]) => `${k}=${n}`).join('; ') : 'none'}
- Terminal reconciliation: ${JSON.stringify(terminal)}
`;
  return { status, text, gaps, terminal };
}
