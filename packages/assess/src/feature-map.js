// @secforge/assess/feature-map — per-feature security map, section-for-section aligned to
// retrieveFeatureContext()'s own dossier fields (packages/retrieval/src/index.js:119-195) plus
// two graph-only lookups (CROSSES_BOUNDARY, SHARES_IMPLEMENTATION_WITH) and the already-emitted
// RETURNS_DATA edge. Pure, zero I/O — same honesty rule as report.js: a missing/empty section
// prints `_none detected_`, never a guess. See docs' feature-maps design doc §1/§3.

const cite = (citations, nodeId) => {
  const c = (citations || []).find((x) => x.node === nodeId);
  return c && c.file ? `\`${c.file}${c.line ? ':' + c.line : ''}\`` : '';
};

const list = (rows, toLine) => (rows && rows.length ? rows.map(toLine).join('\n') : '_none detected_');

// Endpoints crossing the shared TRUST_BOUNDARY node (graph §2a). Degrades to empty when the graph
// carries no CROSSES_BOUNDARY edges yet (e.g. a graph.js build that predates the enrichment).
function crossesBoundary(graph, endpoints) {
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const endpointIds = new Set(endpoints.map((e) => e.id));
  return (graph.edges || [])
    .filter((e) => e.type === 'CROSSES_BOUNDARY' && endpointIds.has(e.src))
    .map((e) => ({ endpoint: endpoints.find((ep) => ep.id === e.src), boundary: nodeById.get(e.dst) }))
    .filter((row) => row.endpoint && row.boundary);
}

// Sibling FEATURE nodes this feature shares a SERVICE/AUTH_CHECK with (graph §2b).
function sharedWith(graph, featureId) {
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const siblingIds = new Set();
  for (const e of graph.edges || []) {
    if (e.type !== 'SHARES_IMPLEMENTATION_WITH') continue;
    if (e.src === featureId) siblingIds.add(e.dst);
    else if (e.dst === featureId) siblingIds.add(e.src);
  }
  return [...siblingIds].map((id) => nodeById.get(id)).filter(Boolean);
}

// RETURNS_DATA edges out of this feature's own services (already emitted, packages/recon/src/
// graph.js:155-161 'response_shaping' case) — surfaced here, never re-derived.
function dataFlowsFor(graph, services) {
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const serviceIds = new Set(services.map((s) => s.id));
  return (graph.edges || [])
    .filter((e) => e.type === 'RETURNS_DATA' && serviceIds.has(e.src))
    .map((e) => nodeById.get(e.dst))
    .filter((n) => n && n.type === 'DATA_FLOW');
}

function endpointsTable(endpoints, citations) {
  if (!endpoints.length) return '_none detected_';
  const rows = endpoints.map((e) =>
    `| ${e.method || '—'} | ${e.route || e.name || '—'} | ${e.authn ? '✓' : '✗'} | ${e.authz ? '✓' : '✗'} | ${cite(citations, e.id) || '—'} |`);
  return ['| Method | Route | Authn | Authz | Evidence |', '|---|---|---|---|---|', ...rows].join('\n');
}

// Coverage-gap document: honest, never throws, never fabricates a section.
function coverageGapDoc(ctx) {
  return [
    '# Coverage gap',
    '',
    ctx?.reason || 'coverage gap: feature not found',
    '',
  ].join('\n');
}

/**
 * renderFeatureMap(ctx, graph) — pure function, zero I/O.
 * @param ctx   retrieveFeatureContext()'s return value. If ctx.ok === false, renders an honest
 *              coverage-gap document instead of throwing.
 * @param graph readGraph()'s return value ({nodes, edges}) for the SAME snapshot ctx was built
 *              from — used ONLY for the trust-boundary/shared-implementation/data-flow lookups
 *              retrieveFeatureContext's own scoped facts filter drops. Optional: omitting it (or
 *              passing one without the new edge types) degrades those three rows to "none
 *              detected", never an error.
 */
export function renderFeatureMap(ctx, graph = { nodes: [], edges: [] }) {
  if (!ctx || ctx.ok === false) return coverageGapDoc(ctx);

  const f = ctx.feature || {};
  const citations = ctx.citations || [];
  const endpoints = ctx.endpoints || [];
  const boundaryRows = crossesBoundary(graph, endpoints);
  const siblings = sharedWith(graph, f.id);
  const flows = dataFlowsFor(graph, ctx.services || []);

  const lines = [
    `# ${f.name || f.id || 'Feature'}`,
    '',
    '## 1. Feature Identity',
    `- Domain: \`${f.domain || 'core'}\``,
    `- Planning: \`${f.planning_method || 'agent-lead'}\` · confidence \`${f.confidence || 'medium'}\``,
    '',
    '## 2. Purpose',
    f.purpose ? f.purpose : '_not established — no purpose was derived for this feature_',
    '',
    '## 3. Endpoints',
    endpointsTable(endpoints, citations),
    '',
    '## 4. Actors / Roles / Permissions',
    `- Actors: ${list(ctx.actors, (a) => `${a.name} ${cite(citations, a.id)}`.trim())}`,
    `- Roles: ${list(ctx.roles, (r) => `${r.name} ${cite(citations, r.id)}`.trim())}`,
    `- Permissions: ${list(ctx.permissions, (p) => `${p.name}`)}`,
    '',
    '## 5. Services',
    list(ctx.services, (s) => `- ${s.name} ${cite(citations, s.id)}`.trim()),
    '',
    '## 6. Jobs',
    list(ctx.jobs, (j) => `- ${j.name} ${cite(citations, j.id)}`.trim()),
    '',
    '## 7. Data stores & data flows',
    `- Data stores: ${list(ctx.dataStores, (d) => `${d.name} ${cite(citations, d.id)}`.trim())}`,
    flows.length
      ? `- Data flows:\n${flows.map((n) => `  - ${n.name}${n.data?.direction ? ` (${n.data.direction})` : ''}`).join('\n')}`
      : '- Data flows: _none detected — no response-shaping row was mapped to this feature_',
    '',
    '## 8. Trust boundary',
    boundaryRows.length
      ? ['| Endpoint | Crosses boundary | Evidence |', '|---|---|---|',
          ...boundaryRows.map(({ endpoint: e, boundary: b }) => `| ${e.method || ''} ${e.route || e.name || ''} | ${b.name || 'trust boundary'} | ${cite(citations, e.id) || '—'} |`)].join('\n')
      : '_none detected — no client-facing endpoint crosses a trust boundary in this graph_',
    '',
    '## 9. Same-functionality (shared implementation)',
    siblings.length ? siblings.map((s) => `- ${s.name}`).join('\n') : '_no shared implementation detected_',
    '',
    '## 10. Files',
    list(ctx.files, (path) => `- \`${path}\``),
    '',
    '## 11. Coverage',
    `- Endpoints: ${endpoints.length} · Auth checks: ${(ctx.authChecks || []).length} · Services: ${(ctx.services || []).length} · Jobs: ${(ctx.jobs || []).length}`,
    `- Depth: reaches ${ctx.depth?.memberCount ?? 0} node(s) across ${ctx.depth?.filesTouched ?? 0} file(s), ${ctx.depth?.maxChainLength ?? 0} hop(s) deep`,
  ];
  return lines.join('\n');
}
