// @secforge/assess/rules — the deterministic rule engine. Pure function over a graph → candidates.
// No LLM: three hand-written rules, each a plain predicate over nodes/edges/claims.
import { ID } from '@secforge/schemas';
import {
  STATE_CHANGING_METHODS, indexGraph, featureOfEndpoint, hasAuthzGuard,
  hasRateLimitGuard, dataStoresOfFeature,
} from './graph-utils.js';

function evidenceOf(node) {
  const claim = node.claims?.[0] || {};
  return { file: claim.file || null, line: claim.line || null };
}

// ACX / CWE-639: an endpoint with no authorization/authentication guard edge at all.
function ruleAcx(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT' || hasAuthzGuard(idx, ep.id)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    out.push({
      family: 'ACX', cwe: 'CWE-639', rule: 'ACX-no-authz-guard',
      title: `${ep.name} has no authorization guard`,
      featureId: feature?.id || null, endpointId: ep.id,
      method: ep.data?.method || null, route: ep.data?.route || null,
      severity: 'high', evidence: evidenceOf(ep),
    });
  }
  return out;
}

// REX / CWE-770: a state-changing endpoint (POST/PUT/PATCH/DELETE) with no rate-limit signal.
function ruleRex(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT') continue;
    const method = (ep.data?.method || '').toUpperCase();
    if (!STATE_CHANGING_METHODS.has(method) || hasRateLimitGuard(idx, ep)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    out.push({
      family: 'REX', cwe: 'CWE-770', rule: 'REX-no-rate-limit',
      title: `${ep.name} is state-changing with no rate-limit signal`,
      featureId: feature?.id || null, endpointId: ep.id,
      method, route: ep.data?.route || null,
      severity: 'medium', evidence: evidenceOf(ep),
    });
  }
  return out;
}

// SDX / CWE-200: a data store reachable (same feature) from an endpoint with no auth guard.
function ruleSdx(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT' || hasAuthzGuard(idx, ep.id)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    if (!feature) continue;
    for (const ds of dataStoresOfFeature(idx, feature.id)) {
      out.push({
        family: 'SDX', cwe: 'CWE-200', rule: 'SDX-unauth-datastore-reachable',
        title: `${ds.name} data store reachable from unauthenticated ${ep.name}`,
        featureId: feature.id, endpointId: ep.id,
        method: ep.data?.method || null, route: ep.data?.route || null,
        severity: 'critical', evidence: evidenceOf(ep),
      });
    }
  }
  return out;
}

const RULES = [
  { family: 'ACX', run: ruleAcx },
  { family: 'REX', run: ruleRex },
  { family: 'SDX', run: ruleSdx },
];

// Re-check a single already-produced candidate against a (possibly re-read) graph — the
// independent VALIDATE pass. Re-derives from the same node/edge predicates, but against the
// candidate alone rather than a fresh batch scan.
const REVERIFY = {
  'ACX-no-authz-guard': (c, idx) => !hasAuthzGuard(idx, c.endpointId),
  'REX-no-rate-limit': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && !hasRateLimitGuard(idx, ep);
  },
  'SDX-unauth-datastore-reachable': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && !hasAuthzGuard(idx, c.endpointId) && dataStoresOfFeature(idx, c.featureId).length > 0;
  },
};

export function validateCandidate(candidate, graph) {
  const idx = indexGraph(graph);
  const fn = REVERIFY[candidate.rule];
  return fn ? fn(candidate, idx) : true;
}

function inScope(featureId, scope) {
  if (!scope || !scope.mode || scope.mode === 'all') return true;
  if (scope.mode === 'feature') {
    const want = scope.feature;
    if (!want) return true;
    return featureId === want || featureId === ID.feature(want);
  }
  if (scope.mode === 'pick') {
    const list = scope.features || [];
    if (!list.length) return true;
    return list.some((f) => featureId === f || featureId === ID.feature(f));
  }
  return true;
}

function familyAllowed(family, patterns) {
  if (!patterns || !patterns.length) return true;
  if (patterns.includes('<applicable>') || patterns.includes('<prompt>')) return true;
  return patterns.includes(family);
}

/**
 * Pure rule engine: graph -> candidates. No I/O, no LLM.
 * @param {{nodes:Array, edges:Array}} graph
 * @param {{scope?:object, patterns?:string[]}} opts
 * @returns {Array<object>} candidates, each {id, family, cwe, title, featureId, endpointId,
 *   method, route, severity, evidence:{file,line}, rule}
 */
export function analyze(graph, { scope = {}, patterns = [] } = {}) {
  const idx = indexGraph(graph);
  // A prompt-driven run still exercises every applicable rule — the prompt is metadata, not a filter.
  const effectivePatterns = scope.method === 'prompt' ? [] : (patterns.length ? patterns : (scope.patterns || []));

  const raw = [];
  for (const r of RULES) {
    if (!familyAllowed(r.family, effectivePatterns)) continue;
    raw.push(...r.run(idx, graph));
  }

  const scoped = raw.filter((c) => inScope(c.featureId, scope));
  let n = 0;
  return scoped.map((c) => ({
    id: ID.candidate(++n),
    ...c,
    ...(scope.method === 'prompt' ? { prompt: scope.prompt || null } : {}),
  }));
}

export { RULES };
