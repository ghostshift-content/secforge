// @secforge/assess/graph-utils — small shared helpers for reading the store's node/edge graph.
// No LLM, no external engine: plain lookups over the arrays readGraph() already returns.

export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const AUTHZ_EDGE_TYPES = new Set(['AUTHORIZED_BY', 'GUARDED_BY', 'AUTHENTICATED_BY']);
export const RATE_LIMIT_NAME_RE = /rate.?limit|throttle/i;

// Index a {nodes, edges} graph for O(1) neighbour lookups by node id.
export function indexGraph(graph) {
  const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const edgesBySrc = new Map();
  const edgesByDst = new Map();
  for (const e of graph.edges || []) {
    if (!edgesBySrc.has(e.src)) edgesBySrc.set(e.src, []);
    edgesBySrc.get(e.src).push(e);
    if (!edgesByDst.has(e.dst)) edgesByDst.set(e.dst, []);
    edgesByDst.get(e.dst).push(e);
  }
  return { nodeById, edgesBySrc, edgesByDst };
}

// Every edge that touches nodeId, either direction.
export function touching(idx, nodeId) {
  return [...(idx.edgesBySrc.get(nodeId) || []), ...(idx.edgesByDst.get(nodeId) || [])];
}

// The FEATURE node that EXPOSES this endpoint, if any.
export function featureOfEndpoint(idx, endpointId) {
  const e = (idx.edgesByDst.get(endpointId) || []).find((edge) => edge.type === 'EXPOSES');
  return e ? idx.nodeById.get(e.src) : null;
}

export function hasAuthzGuard(idx, endpointId) {
  return touching(idx, endpointId).some((e) => AUTHZ_EDGE_TYPES.has(e.type));
}

export function hasRateLimitGuard(idx, endpointNode) {
  if (endpointNode.data?.rateLimited) return true;
  return touching(idx, endpointNode.id).some((e) => {
    if (e.type !== 'GUARDED_BY') return false;
    const other = idx.nodeById.get(e.src === endpointNode.id ? e.dst : e.src);
    return other && RATE_LIMIT_NAME_RE.test(other.name || '');
  });
}

// DATA_STORE nodes a feature HANDLED_BY-reaches (src === featureId, per map.js's own convention).
export function dataStoresOfFeature(idx, featureId) {
  return (idx.edgesBySrc.get(featureId) || [])
    .filter((e) => e.type === 'HANDLED_BY')
    .map((e) => idx.nodeById.get(e.dst))
    .filter((n) => n && n.type === 'DATA_STORE');
}

// ENDPOINT nodes a feature EXPOSES (src === featureId, per map.js's own convention).
export function endpointsOfFeature(idx, featureId) {
  return (idx.edgesBySrc.get(featureId) || [])
    .filter((e) => e.type === 'EXPOSES')
    .map((e) => idx.nodeById.get(e.dst))
    .filter((n) => n && n.type === 'ENDPOINT');
}
