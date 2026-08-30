// @secforge/schemas — the one canonical contract: graph vocabulary, envelopes, ids, states.
// Prompts/plugins/agents may NOT invent types outside these frozen sets.

// Knowledge-graph node types. Codengram's recon vocabulary + SecForge's security layer.
export const NODE_TYPES = Object.freeze([
  // structure
  'PROJECT', 'SNAPSHOT', 'DOMAIN', 'FILE', 'SYMBOL', 'FEATURE', 'ROUTE', 'ENDPOINT',
  'GRAPHQL_OPERATION', 'JOB', 'SERVICE', 'MODEL', 'DATA_STORE', 'INTEGRATION', 'PROCESS',
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

// Reconciliation coverage ledger (Phase A §2): did every mapper inventory row land somewhere
// traceable — a feature, shared infra, or an honest gap. Distinct from assess/coverage.js's
// feature×vuln-family assessment matrix.
export const RECONCILIATION_STATUS = Object.freeze([
  'MAPPED_TO_FEATURE',       // row produced a node reachable from exactly one FEATURE
  'SHARED_INFRASTRUCTURE',   // row produced a node under buildInfra() (PROJECT-level PROCESS/DATA_STORE/INTEGRATION), or project-wide identity vocabulary
  'UNCLEAR_COVERAGE_GAP',    // row was extracted but didn't resolve to a FEATURE-reachable or infra node
  'UNRECONCILED',            // placeholder only — must never survive a completed mapProject run
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
// djb2-ish 6-char hash for collision-resistant row-derived ids (mapper port). slug() alone truncates at length and
// silently collides on large monorepos with long common path prefixes; scoped() appends a hash of the full key.
const _hash6 = (s) => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36).padStart(6, '0').slice(0, 6); };
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
  // Row-derived id: readable prefix + slug + a hash of the full logical key (traversal-safe, collision-resistant).
  scoped: (prefix, ...parts) => { const raw = parts.map(String).join(''); return `${slug(prefix) || 'x'}:${slug(raw).slice(0, 58) || 'item'}-${_hash6(raw)}`; },
});

// ── Evidence grounding (mapper AI-semantic layer). Pure, deterministic, no interaction with the ID builders. ──
// Which repo sources may ESTABLISH an identity (role/permission/feature) vs merely corroborate. A role seen only in
// a test/fixture/doc/asset is never established from it — production or config source is required.
export const EVIDENCE_SOURCE_KINDS = Object.freeze(['production', 'test', 'fixture', 'doc', 'asset', 'translation', 'generated', 'config']);
export const IDENTITY_ESTABLISHING_KINDS = Object.freeze(['production', 'config']);
export const IDENTITY_EXCLUDED_KINDS = Object.freeze(['test', 'fixture', 'doc', 'asset', 'translation', 'generated']);
// Classify a repo-relative path into an evidence-source kind (gates identity discovery). Pure + deterministic.
export function evidenceSourceKind(path) {
  const p = String(path || '').toLowerCase();
  if (/(?:^|\/)(?:spec|specs|test|tests|__tests__|__mocks__|e2e|cypress|qa|features\/step_definitions)(?:\/|$)|[._-](?:spec|test)\.[a-z0-9]+$|_test\.[a-z0-9]+$/.test(p)) return 'test';
  if (/(?:^|\/)(?:fixtures?|factories|seeds?|testdata|mock_data|__fixtures__)(?:\/|$)/.test(p)) return 'fixture';
  if (/(?:^|\/)(?:docs?|documentation|examples?)(?:\/|$)|\.(?:md|mdx|rst|adoc|txt)$/.test(p)) return 'doc';
  if (/(?:^|\/)(?:locales?|i18n|translations?|lang)(?:\/|$)|\.(?:po|pot|mo|arb)$/.test(p)) return 'translation';
  if (/(?:^|\/)(?:assets?|static|public|images?|fonts?|vendor|node_modules|dist|build)(?:\/|$)|\.(?:png|jpe?g|gif|svg|css|scss|ico|woff2?)$/.test(p)) return 'asset';
  if (/(?:\.generated\.|_pb\.|\.pb\.|\.g\.dart$|\.freezed\.|autogenerated|\bgenerated\b)/.test(p)) return 'generated';
  if (/(?:^|\/)config(?:\/|$)|\.(?:ya?ml|toml|ini|env|properties)$/.test(p)) return 'config';
  return 'production';
}
export const canEstablishIdentity = (path) => IDENTITY_ESTABLISHING_KINDS.includes(evidenceSourceKind(path));
// #7 canonical relative path: forward slashes, no leading `/`, no `..` segment (rejects `../../etc/passwd`).
export function safeRelPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!s || s.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`unsafe/invalid path: ${p}`);
  return s;
}
// One grounded evidence item: an existing file, an optional positive line, an optional symbol. The validator later
// proves the file:line/symbol actually exist in the frozen snapshot.
export function isValidEvidence(e) {
  if (!(e && typeof e === 'object')) return false;
  if (typeof e.file !== 'string' || !e.file) return false;
  if (e.line != null && !(Number.isInteger(e.line) && e.line > 0)) return false;
  if (e.symbol != null && typeof e.symbol !== 'string') return false;
  return true;
}

// A job envelope dispatched to a fan-out agent; a result envelope comes back.
export function jobEnvelope({ id, role, scope, method, patterns = [], prompt = null, feature = null }) {
  return { id, role, scope, method, patterns, prompt, feature, state: 'queued', createdAt: new Date().toISOString() };
}

export function assertTransition(from, to) {
  const allowed = SESSION_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) throw new Error(`illegal session transition: ${from} → ${to}`);
  return to;
}
