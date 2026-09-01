// @secforge/assess/graph-utils — small shared helpers for reading the store's node/edge graph.
// No LLM, no external engine: plain lookups over the arrays readGraph() already returns.

export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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

// Authentication present (who are you): an AUTHENTICATED_BY edge touches the endpoint.
export function hasAuthn(idx, endpointId) {
  return touching(idx, endpointId).some((e) => e.type === 'AUTHENTICATED_BY');
}

// Authorization present (may you): an AUTHORIZED_BY / GUARDED_BY edge touches the endpoint.
export function hasAuthz(idx, endpointId) {
  return touching(idx, endpointId).some((e) => e.type === 'AUTHORIZED_BY' || e.type === 'GUARDED_BY');
}

const PARAM_RE = /:\w+|<\w+>|\{\w+\}/;
// A GET whose route carries a path parameter — the object-read shape an IDOR needs.
export function isObjectRead(ep) {
  return (ep.data?.method || '').toUpperCase() === 'GET' && PARAM_RE.test(ep.data?.route || '');
}

// POSITIVE cookie/session-auth evidence — never inferred from the mere absence of a bearer token.
// An AUTHENTICATED_BY edge to an AUTH_CHECK{kind:'session-cookie'} node: explicit session[]/
// cookies.signed/cookies.encrypted usage, a Rails ActionController::Base ancestry, or a universal
// express-session/req.session/cookie-session/Set-Cookie/form-render signal. An ActionController::API
// app or a bearer-token API surfaces none of these, so CSRF correctly never fires there.
export function hasCookieSessionAuth(idx, endpointId) {
  return touching(idx, endpointId).some(
    (e) => e.type === 'AUTHENTICATED_BY' && idx.nodeById.get(e.dst)?.data?.kind === 'session-cookie',
  );
}

// A CSRF guard is present: a GUARDED_BY edge to an AUTH_CHECK{kind:'csrf-guard'} node.
export function hasCsrfGuard(idx, endpointId) {
  return touching(idx, endpointId).some(
    (e) => e.type === 'GUARDED_BY' && idx.nodeById.get(e.dst)?.data?.kind === 'csrf-guard',
  );
}

export function hasRateLimitGuard(idx, endpointNode) {
  if (endpointNode.data?.rateLimited) return true;
  return touching(idx, endpointNode.id).some((e) => {
    if (e.type !== 'GUARDED_BY') return false;
    const other = idx.nodeById.get(e.src === endpointNode.id ? e.dst : e.src);
    return other && RATE_LIMIT_NAME_RE.test(other.name || '');
  });
}

// DATA_STORE/MODEL nodes a feature HANDLED_BY-reaches (src === featureId, per map.js's own
// convention). MODEL is included alongside DATA_STORE because the mapper wires ORM model classes
// (feature-scoped) via HANDLED_BY the same way config-level data stores are (see recon/graph.js).
export function dataStoresOfFeature(idx, featureId) {
  return (idx.edgesBySrc.get(featureId) || [])
    .filter((e) => e.type === 'HANDLED_BY')
    .map((e) => idx.nodeById.get(e.dst))
    .filter((n) => n && (n.type === 'DATA_STORE' || n.type === 'MODEL'));
}

// ENDPOINT nodes a feature EXPOSES (src === featureId, per map.js's own convention).
export function endpointsOfFeature(idx, featureId) {
  return (idx.edgesBySrc.get(featureId) || [])
    .filter((e) => e.type === 'EXPOSES')
    .map((e) => idx.nodeById.get(e.dst))
    .filter((n) => n && n.type === 'ENDPOINT');
}
