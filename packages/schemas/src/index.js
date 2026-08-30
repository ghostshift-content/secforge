// @secforge/schemas — the one canonical contract: graph vocabulary, envelopes, ids, states.
// Prompts/plugins/agents may NOT invent types outside these frozen sets.

// Knowledge-graph node types. Codengram's recon vocabulary + SecForge's security layer.
export const NODE_TYPES = Object.freeze([
  // structure
  'PROJECT', 'SNAPSHOT', 'DOMAIN', 'FILE', 'SYMBOL', 'FEATURE', 'ROUTE', 'ENDPOINT',
  'GRAPHQL_OPERATION', 'JOB', 'SERVICE', 'MODEL', 'DATA_STORE', 'INTEGRATION',
  // identity
  'ACTOR', 'ROLE', 'PERMISSION', 'AUTH_CHECK', 'AUTH_MECHANISM', 'TOKEN', 'RESOURCE', 'OPERATION',
  'TRUST_BOUNDARY', 'DATA_FLOW', 'ARCH_CLUSTER', 'COVERAGE_GAP',
  // security layer (SecForge)
  'VULN_CANDIDATE', 'FINDING', 'PATTERN', 'CWE', 'COVERAGE_CELL', 'ASSESSMENT_RUN', 'TEST_ENV', 'EVIDENCE',
]);

export const EDGE_TYPES = Object.freeze([
  // structure
  'CONTAINS', 'DEFINES', 'EXPOSES', 'HANDLED_BY', 'CALLS', 'READS', 'WRITES', 'ENQUEUES',
  'AUTHENTICATED_BY', 'AUTHORIZED_BY', 'REQUIRES_ROLE', 'CROSSES_BOUNDARY', 'RETURNS_DATA',
  'USES_SERVICE', 'USES_INTEGRATION', 'SHARES_IMPLEMENTATION_WITH', 'HAS_ROLE', 'GRANTS',
  // security layer
  'CANDIDATE_IN', 'VIOLATES', 'GUARDED_BY', 'MAPS_TO_CWE', 'PROMOTED_TO', 'VALIDATED_BY', 'COVERS',
]);

export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const PROVENANCE_METHODS = Object.freeze(['grep', 'ast', 'symbol-index', 'manifest', 'config', 'repo-level', 'generated', 'llm-map']);

// Session lifecycle FSM (the scan = session model). See docs/BACKEND-ARCHITECTURE §2.
export const SESSION_STATES = Object.freeze(['created', 'running', 'paused', 'completed', 'cancelled']);
export const SESSION_TRANSITIONS = Object.freeze({
  created: ['running', 'cancelled'],
  running: ['paused', 'completed', 'cancelled'],
  paused: ['running', 'cancelled'],
  completed: [],
  cancelled: [],
});

// Assessment scope + method (the run screen).
export const SCOPE_KINDS = Object.freeze(['feature', 'pick', 'all']);
export const RUN_METHODS = Object.freeze(['pattern', 'prompt', 'full']);

// Finding: four orthogonal fields (lifecycle / outcome / verification / assessment-mode).
export const LIFECYCLE = Object.freeze(['planned', 'queued', 'running', 'awaiting_verification', 'retest_required', 'error', 'terminal']);
export const OUTCOME = Object.freeze(['pass', 'vulnerable', 'not_applicable', 'deduplicated', 'blocked']);
export const VERIFICATION = Object.freeze(['unverified', 'verified', 'rejected']);
export const ASSESSMENT_MODE = Object.freeze(['static_confirmed', 'runtime_confirmed', 'static_and_runtime_confirmed']);

// Agent roles that fan out inside a session.
export const AGENT_ROLES = Object.freeze(['framer', 'hunter', 'triager', 'validator', 'reporter']);

// Deterministic id builders → re-scans are idempotent.
const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const ID = Object.freeze({
  project: (name) => `project:${slug(name)}`,
  feature: (s) => `feature:${slug(s)}`,
  endpoint: (method, route) => `endpoint:${String(method).toUpperCase()}:${route}`,
  file: (rel) => `file:${rel}`,
  finding: (n, s) => `finding:F-${n}-${slug(s)}`,
  candidate: (n) => `candidate:C-${n}`,
  run: (sessionId) => `run:${sessionId}`,
  cwe: (id) => `cwe:${id}`,
  role: (name) => `role:${slug(name)}`,
  actor: (name) => `actor:${slug(name)}`,
  permission: (action, resource) => `permission:${slug(action)}${resource ? ':' + slug(resource) : ''}`,
});

// A job envelope dispatched to a fan-out agent; a result envelope comes back.
export function jobEnvelope({ id, role, scope, method, patterns = [], prompt = null, feature = null }) {
  return { id, role, scope, method, patterns, prompt, feature, state: 'queued', createdAt: new Date().toISOString() };
}

export function assertTransition(from, to) {
  const allowed = SESSION_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw new Error(`illegal session transition: ${from} → ${to}`);
  return to;
}
