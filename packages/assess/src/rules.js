// @secforge/assess/rules — the deterministic rule engine. Pure function over a graph → candidates.
// No LLM: hand-written rules, each a plain predicate over nodes/edges/claims. Auth edges emitted by
// the map engine let these distinguish guarded vs unguarded endpoints (precision over noise).
import { ID } from '@secforge/schemas';
import {
  STATE_CHANGING_METHODS, indexGraph, featureOfEndpoint,
  hasAuthn, hasAuthz, isObjectRead, hasRateLimitGuard, dataStoresOfFeature,
} from './graph-utils.js';

function evidenceOf(node) {
  const claim = node.claims?.[0] || {};
  return { file: claim.file || null, line: claim.line || null };
}

// CVSS v3.1 base metrics co-located with each rule so score/vector/severity stay in sync.
// Severity is DERIVED from score (standard v3.1 bands) — never hardcoded per rule.
export const RULE_CVSS = Object.freeze({
  'ACX-missing-authentication':     { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', score: 7.5 },
  'ACX-idor-no-owner-check':        { vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', score: 6.5 },
  'REX-no-rate-limit':              { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L', score: 5.3 },
  'SDX-unauth-datastore-reachable': { vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', score: 7.5 },
});

// The CWE each deterministic rule actually detects — the honest denominator for a per-CWE
// checklist (mirrors RULE_CVSS's pattern). Not the same as FAMILIES.<prefix>.cwe, which lists
// every CWE a family is *conceptually* about, whether or not a detector exists for it.
export const RULE_CWE = Object.freeze({
  'ACX-idor-no-owner-check':        'CWE-639',
  'ACX-missing-authentication':     'CWE-306',
  'REX-no-rate-limit':              'CWE-770',
  'SDX-unauth-datastore-reachable': 'CWE-200',
});

// Standard CVSS v3.1 qualitative severity bands.
export function severityFromScore(score) {
  if (typeof score !== 'number') return 'info';
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  if (score >= 0.1) return 'low';
  return 'info';
}

const severityOf = (rule) => severityFromScore(RULE_CVSS[rule]?.score);

// ACX / CWE-639 (IDOR): an object read (GET with an id path-param) that has authentication but
// NO authorization/ownership check — the classic "read any record by id" shape.
function ruleIdor(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT' || !isObjectRead(ep) || !hasAuthn(idx, ep.id) || hasAuthz(idx, ep.id)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    out.push({
      family: 'ACX', cwe: 'CWE-639', rule: 'ACX-idor-no-owner-check',
      title: `${ep.name} reads an object by id without an ownership/authorization check`,
      featureId: feature?.id || null, endpointId: ep.id,
      method: ep.data?.method || null, route: ep.data?.route || null,
      severity: severityOf('ACX-idor-no-owner-check'), evidence: evidenceOf(ep),
    });
  }
  return out;
}

// ACX / CWE-306: an endpoint reachable with NO authentication and NO authorization at all.
function ruleMissingAuth(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT' || hasAuthn(idx, ep.id) || hasAuthz(idx, ep.id)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    out.push({
      family: 'ACX', cwe: 'CWE-306', rule: 'ACX-missing-authentication',
      title: `${ep.name} is reachable without authentication`,
      featureId: feature?.id || null, endpointId: ep.id,
      method: ep.data?.method || null, route: ep.data?.route || null,
      severity: severityOf('ACX-missing-authentication'), evidence: evidenceOf(ep),
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
      severity: severityOf('REX-no-rate-limit'), evidence: evidenceOf(ep),
    });
  }
  return out;
}

// SDX / CWE-200: a data store reachable (same feature) from a fully-unauthenticated endpoint.
function ruleSdx(idx, graph) {
  const out = [];
  for (const ep of graph.nodes) {
    if (ep.type !== 'ENDPOINT' || hasAuthn(idx, ep.id) || hasAuthz(idx, ep.id)) continue;
    const feature = featureOfEndpoint(idx, ep.id);
    if (!feature) continue;
    for (const ds of dataStoresOfFeature(idx, feature.id)) {
      out.push({
        family: 'SDX', cwe: 'CWE-200', rule: 'SDX-unauth-datastore-reachable',
        title: `${ds.name} data store reachable from unauthenticated ${ep.name}`,
        featureId: feature.id, endpointId: ep.id,
        method: ep.data?.method || null, route: ep.data?.route || null,
        severity: severityOf('SDX-unauth-datastore-reachable'), evidence: evidenceOf(ep),
      });
    }
  }
  return out;
}

const RULES = [
  { family: 'ACX', run: ruleIdor },
  { family: 'ACX', run: ruleMissingAuth },
  { family: 'REX', run: ruleRex },
  { family: 'SDX', run: ruleSdx },
];

// Independent VALIDATE pass: re-derive a single candidate's predicate against the graph.
const REVERIFY = {
  'ACX-idor-no-owner-check': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && isObjectRead(ep) && hasAuthn(idx, c.endpointId) && !hasAuthz(idx, c.endpointId);
  },
  'ACX-missing-authentication': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && !hasAuthn(idx, c.endpointId) && !hasAuthz(idx, c.endpointId);
  },
  'REX-no-rate-limit': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && !hasRateLimitGuard(idx, ep);
  },
  'SDX-unauth-datastore-reachable': (c, idx) => {
    const ep = idx.nodeById.get(c.endpointId);
    return !!ep && !hasAuthn(idx, c.endpointId) && !hasAuthz(idx, c.endpointId) && dataStoresOfFeature(idx, c.featureId).length > 0;
  },
};

export function validateCandidate(candidate, graph) {
  const idx = indexGraph(graph);
  const fn = REVERIFY[candidate.rule];
  return fn ? fn(candidate, idx) : false; // no reverify logic for this rule id ⇒ REJECT, not pass
}

// Executor→verifier gate for LLM-nominated candidates: does the DETERMINISTIC engine, run fresh
// with no knowledge of the LLM's claim beyond "check this endpoint/family", independently flag
// the same endpoint? Reuses RULES' own producers (no second, parallel predicate implementation
// to drift out of sync with rules.js). Returns null (drop — never "verified") when it doesn't,
// including for any family with no deterministic rule at all (QIX, SX today): the `for` loop
// simply never matches, so those families can never be promoted via the LLM path either.
// On a hit, returns the DETERMINISTIC rule's own candidate (its rule id/cwe/severity/evidence),
// keeping only the LLM candidate's `id` — the model cannot self-certify its own guessed cwe/title.
export function reproveLlmCandidate(candidate, graph) {
  const idx = indexGraph(graph);
  if (!idx.nodeById.get(candidate.endpointId)) return null;
  for (const r of RULES) {
    if (r.family !== candidate.family) continue;
    const hit = r.run(idx, graph).find((c) => c.endpointId === candidate.endpointId);
    if (hit) return { ...hit, id: candidate.id, llmNominated: true };
  }
  return null; // no deterministic rule exists for this family → never verified
}

export function inScope(featureId, scope) {
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
 * @returns {Array<object>} candidates {id, family, cwe, title, featureId, endpointId,
 *   method, route, severity, evidence:{file,line}, rule}
 */
export function analyze(graph, { scope = {}, patterns = [] } = {}) {
  const idx = indexGraph(graph);
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
