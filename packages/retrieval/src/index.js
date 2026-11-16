// @secforge/retrieval — the zero-dep "RAG": fully-cited per-feature context for future scans.
// Reads only @secforge/store (readGraph/readFrozenSourceLines/readReconciliation). Never reads
// live source, never fabricates a fact that isn't a real graph edge. See docs/phase-a-design.md §3.
import { readGraph, readFrozenSourceLines, currentSnapshotId } from '@secforge/store';

// Resolve the snapshot ONCE per call. readGraph() resolves "current" on an undefined id, but
// readFrozenSourceLines() does not — so without pinning one id here, a caller that omits snapshotId
// (the GET /features/:fid/context route, the UI dossier) reads the current graph but gets null
// excerpts. Pin it so the graph read AND the frozen-source excerpts come from the SAME snapshot.
async function resolveSid(store, projectId, snapshotId) {
  return snapshotId || (await currentSnapshotId(store, projectId));
}

// ---- bfs: bounded multi-hop over a whole readGraph() snapshot ------------------------------
// neighbourhood() is frozen at 1-hop (packages/store/src/graph.js) — this is retrieval's own
// layer on top. Returns reached nodes/edges + the max hop distance actually reached, and whether
// the node cap truncated the walk (honesty signal, never silently hidden).
function bfs(graph, startId, hops, cap) {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeById.has(startId)) return null;
  const seen = new Map([[startId, 0]]); // id -> hop distance
  let frontier = [startId];
  for (let h = 0; h < hops && seen.size < cap; h++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of graph.edges) {
        if (e.src !== cur && e.dst !== cur) continue;
        for (const nb of [e.src, e.dst]) if (!seen.has(nb) && seen.size < cap) { seen.set(nb, h + 1); next.push(nb); }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  const ids = new Set(seen.keys());
  const edges = graph.edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
  const nodes = [...ids].map((id) => nodeById.get(id)).filter(Boolean);
  const maxChainLength = Math.max(0, ...seen.values());
  return { nodes, edges, maxChainLength, capped: seen.size >= cap };
}

const factOf = (n1, e, n2) => `${n1?.name || e.src} --${e.type}--> ${n2?.name || e.dst}`;

// Citations: pool every claim on every reached node (claims are INLINE per node — no join).
// Dedupe by file:line, cap, resolve excerpts from FROZEN source only (never live) — a missing
// frozen file is an honest `excerpt: null`, never a guess.
async function citationsFor(store, projectId, snapshotId, nodes, maxCitations, window = 2) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    for (const c of n.claims || []) {
      if (!c.file || out.length >= maxCitations) continue;
      const key = `${c.file}:${c.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const excerpt = await readFrozenSourceLines(store, projectId, snapshotId, c.file, c.line, (c.line || 1) + window);
      out.push({ node: n.id, file: c.file, line: c.line, method: c.method, confidence: c.confidence, excerpt });
    }
  }
  return out;
}

// ---- 3.1 getContextBundle ------------------------------------------------------------------
export async function getContextBundle(store, projectId, nodeId, { hops = 1, maxCitations = 20, snapshotId } = {}) {
  const sid = await resolveSid(store, projectId, snapshotId);
  const graph = await readGraph(store, projectId, sid);
  const sub = bfs(graph, nodeId, hops, 300);
  if (!sub) return { ok: false, reason: 'coverage gap: node not found', nodeId };
  const node = sub.nodes.find((n) => n.id === nodeId);
  const facts = sub.edges.map((e) => factOf(sub.nodes.find((n) => n.id === e.src), e, sub.nodes.find((n) => n.id === e.dst)));
  const citations = await citationsFor(store, projectId, sid, sub.nodes, maxCitations);
  return {
    ok: true,
    node: { id: node.id, type: node.type, name: node.name, data: node.data },
    neighbours: sub.nodes.filter((n) => n.id !== nodeId).map((n) => ({ id: n.id, type: n.type, name: n.name, data: n.data })),
    facts,
    citations,
  };
}

// ---- 3.2 retrieveFeatureContext -------------------------------------------------------------
// FEATURE-SCOPED, not a blind BFS: on a real graph, features share nodes (a common SERVICE, an
// AUTH_CHECK reused across controllers, ...), so a multi-hop BFS from one feature reaches its
// siblings' endpoints too. Walk only the feature's OWN ownership edges instead — each dossier
// list is exactly what THIS feature exposes/uses, never a sibling's. `depth` (below) is the one
// deliberate exception: a bounded walk from the feature's OWN endpoints along execution/data
// edges, reported as a separate "how far does this feature reach" metric — it must never feed
// nodes back into the member lists above it.
const pickFields = (n) => ({ id: n.id, type: n.type, name: n.name, ...n.data });
const dedupeNodes = (arr) => [...new Map(arr.map((n) => [n.id, n])).values()];
const otherSide = (e, id) => (e.src === id ? e.dst : e.src);
const DEPTH_EDGE_TYPES = ['CALLS', 'READS', 'USES_SERVICE', 'HANDLED_BY'];

// Bounded multi-source walk restricted to DEPTH_EDGE_TYPES, starting from the feature's own
// endpoints — measures the feature's execution/data reach, separate from the dossier lists.
function depthWalk(graph, startIds, hops, cap) {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Map(startIds.filter((id) => nodeById.has(id)).map((id) => [id, 0]));
  let frontier = [...seen.keys()];
  for (let h = 0; h < hops && seen.size < cap; h++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of graph.edges) {
        if (!DEPTH_EDGE_TYPES.includes(e.type) || (e.src !== cur && e.dst !== cur)) continue;
        for (const nb of [e.src, e.dst]) if (!seen.has(nb) && seen.size < cap) { seen.set(nb, h + 1); next.push(nb); }
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  const nodes = [...seen.keys()].map((id) => nodeById.get(id)).filter(Boolean);
  return {
    memberCount: nodes.length,
    maxChainLength: Math.max(0, ...seen.values()),
    filesTouched: new Set(nodes.map((n) => n.data?.file).filter(Boolean)).size,
    capped: seen.size >= cap,
  };
}

export async function retrieveFeatureContext(store, projectId, featureId, { hops = 3, maxCitations = 40, snapshotId } = {}) {
  const sid = await resolveSid(store, projectId, snapshotId);
  const graph = await readGraph(store, projectId, sid);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const feature = nodeById.get(featureId);
  if (!feature || feature.type !== 'FEATURE') return { ok: false, reason: 'coverage gap: feature not found', featureId };

  const edgesBySrc = new Map();
  for (const e of graph.edges) { if (!edgesBySrc.has(e.src)) edgesBySrc.set(e.src, []); edgesBySrc.get(e.src).push(e); }
  const outTo = (id, type, types) => (edgesBySrc.get(id) || [])
    .filter((e) => e.type === type)
    .map((e) => nodeById.get(e.dst))
    .filter((n) => n && types.includes(n.type));
  // Global (whole-snapshot) edge touch — never scoped to a subgraph: an auth edge exists on the
  // endpoint regardless of hop distance from the feature (graph-utils.js's hasAuthn/hasAuthz).
  const touching = (id, types) => graph.edges.filter((e) => types.includes(e.type) && (e.src === id || e.dst === id));

  const endpointNodes = dedupeNodes(outTo(featureId, 'EXPOSES', ['ENDPOINT', 'ROUTE', 'GRAPHQL_OPERATION']));
  const services = dedupeNodes(outTo(featureId, 'USES_SERVICE', ['SERVICE']));
  const jobs = dedupeNodes(outTo(featureId, 'HANDLED_BY', ['JOB']));
  const dataStores = dedupeNodes(outTo(featureId, 'HANDLED_BY', ['DATA_STORE', 'MODEL']));
  const fileNodes = dedupeNodes(outTo(featureId, 'CONTAINS', ['FILE']));
  const files = fileNodes.map((n) => n.data?.path || n.id.replace(/^file:/, ''));

  const actors = dedupeNodes(outTo(featureId, 'AUTHENTICATED_BY', ['ACTOR']));
  const roles = dedupeNodes(actors.flatMap((a) => outTo(a.id, 'HAS_ROLE', ['ROLE'])));
  const permissions = dedupeNodes(roles.flatMap((r) => outTo(r.id, 'GRANTS', ['PERMISSION'])));

  // Per-endpoint authn/authz + the AUTH_CHECK/TOKEN nodes those edges point to.
  const authCheckHits = [];
  const endpoints = endpointNodes.map((ep) => {
    const authnEdges = touching(ep.id, ['AUTHENTICATED_BY']);
    const authzEdges = touching(ep.id, ['AUTHORIZED_BY', 'GUARDED_BY']);
    for (const e of [...authnEdges, ...authzEdges]) {
      const other = nodeById.get(otherSide(e, ep.id));
      if (other && (other.type === 'AUTH_CHECK' || other.type === 'TOKEN')) authCheckHits.push(other);
    }
    return { ...pickFields(ep), authn: authnEdges.length > 0, authz: authzEdges.length > 0 };
  });
  const authChecks = dedupeNodes(authCheckHits).map(pickFields);

  // facts: real edges only, among the feature's own scoped member set (never a sibling's).
  const scopedIds = new Set([
    feature.id, ...endpointNodes, ...services, ...jobs, ...dataStores, ...actors, ...roles, ...permissions, ...authCheckHits,
  ].map((n) => n.id));
  const facts = graph.edges
    .filter((e) => scopedIds.has(e.src) && scopedIds.has(e.dst))
    .map((e) => factOf(nodeById.get(e.src), e, nodeById.get(e.dst)));

  // Citations: pool claims from the scoped member set, endpoints FIRST so an endpoint's own
  // claim line wins the file:line dedup over another member that happens to share it (e.g.
  // download_receipt's excerpt is its own controller-def line, not a sibling's).
  const citations = await citationsFor(
    store, projectId, sid,
    [...endpointNodes, feature, ...services, ...jobs, ...dataStores, ...actors, ...roles],
    maxCitations,
  );

  const depth = { hops, endpointCount: endpointNodes.length, ...depthWalk(graph, endpointNodes.map((n) => n.id), hops, 300) };

  return {
    ok: true,
    feature: { id: feature.id, name: feature.name, ...feature.data },
    endpoints,
    authChecks,
    dataStores: dataStores.map(pickFields),
    services: services.map(pickFields),
    jobs: jobs.map(pickFields),
    actors: actors.map(pickFields),
    roles: roles.map(pickFields),
    permissions: permissions.map(pickFields),
    files,
    facts,
    citations,
    depth,
  };
}

// ---- 3.3 search — scored LIKE scan, no FTS5 (see docs/phase-a-design.md §3.3) ---------------
const TYPE_WEIGHT = { FEATURE: 5, ENDPOINT: 3, AUTH_CHECK: 3, SERVICE: 3, DATA_STORE: 2, MODEL: 2, JOB: 2, ACTOR: 2, ROLE: 2, PERMISSION: 2, FILE: 1, SYMBOL: 1 };
export async function search(store, projectId, query, { limit = 40, snapshotId } = {}) {
  const terms = String(query || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!terms.length) return [];
  const graph = await readGraph(store, projectId, snapshotId);
  const scored = [];
  for (const n of graph.nodes) {
    const haystack = `${n.name || ''} ${n.id} ${(n.claims || []).map((c) => c.file || '').join(' ')}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (t.length > 2 && haystack.includes(t)) score += TYPE_WEIGHT[n.type] || 1;
    if (score > 0) scored.push({ id: n.id, type: n.type, name: n.name, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- 3.4 answer — model-free cited bundle with the coverageGap honesty signal ---------------
export const GROUNDING_PREAMBLE =
  'You are reading a SecForge feature-context store (mapping only — it never asserts vulnerabilities ' +
  'on its own). Every fact is grounded to a file:line citation in the frozen snapshot. Answer ONLY ' +
  'from the facts and citations below; if something is missing, say "coverage gap" — never guess.';

export async function answer(store, projectId, question, { maxCitations = 8, snapshotId } = {}) {
  const hits = await search(store, projectId, question, { snapshotId });
  if (!hits.length) return { ok: false, coverageGap: true, text: 'Coverage gap: nothing in the store matches that question.', citations: [] };
  const bundle = await getContextBundle(store, projectId, hits[0].id, { hops: 1, maxCitations, snapshotId });
  const lines = [
    `**${bundle.node.name || bundle.node.id}** (${bundle.node.type})`,
    bundle.node.data?.purpose ? `\n${bundle.node.data.purpose}` : '',
    bundle.facts.length ? `\nConnections:\n${bundle.facts.slice(0, 20).map((f) => `- ${f}`).join('\n')}` : '',
    bundle.citations.length ? `\nGrounded in:\n${bundle.citations.slice(0, maxCitations).map((c) => `- \`${c.file}:${c.line}\``).join('\n')}` : '',
  ].filter(Boolean);
  return { ok: true, coverageGap: false, node: bundle.node.id, text: lines.join('\n'), citations: bundle.citations.slice(0, maxCitations) };
}

// ---- 4. Feed-forward format ------------------------------------------------------------------
export async function buildFeedForward(store, projectId, featureId, opts = {}) {
  const bundle = await retrieveFeatureContext(store, projectId, featureId, opts);
  return { preamble: GROUNDING_PREAMBLE, generatedAt: new Date().toISOString(), ...bundle };
}

// ---- 5. The per-snapshot retrieval store ("where does X live?") --------------------------------
export { buildChunks, writeRagIndex, locate, rankChunks, tokenize, RAG_VERSION } from './rag.js';
