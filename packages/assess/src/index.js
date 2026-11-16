// @secforge/assess — the assessment engine. FRAME -> HUNT (analyze) -> TRIAGE -> VALIDATE ->
// REPORT over a project's graph, tracking coverage as a feature x family matrix. Deterministic
// rules are the always-reliable base and run unconditionally; an optional LLM-assist HUNT step
// (gated on `engine`) can add extra candidates on top, but a missing/broken/unavailable adapter
// must never stop a scan from completing with deterministic findings.

import { ID } from '@secforge/schemas';
import { readGraph, writeNodes, writeEdges } from '@secforge/store';
import { jobEnvelope } from '@secforge/schemas';
import { getAdapter } from '@secforge/adapters';
import { FAMILIES } from '@secforge/patterns';
import { buildFeedForward, locate } from '@secforge/retrieval';
import { analyze, validateCandidate, reproveLlmCandidate, inScope } from './rules.js';
import { decorateFinding, buildSnippet, loadManifest, readSourceRoot, readCurrentSnapshotId } from './decorate.js';
import { citationIndex, citationFromLine } from './grounding.js';
import { computeCoverage } from './coverage.js';
import { indexGraph, endpointsOfFeature } from './graph-utils.js';

// Build the fan-out jobs for a run scope (from the run screen). Job count/shape only —
// analyze() itself runs once over the whole graph; jobs exist for UI progress reporting.
export function planJobs(scope = {}) {
  const features = scope.mode === 'all' ? ['<all>'] : (scope.features || [scope.feature]).filter(Boolean);
  const patterns = scope.method === 'prompt' ? ['<prompt>'] : (scope.patterns || []);
  const jobs = [];
  let n = 0;
  for (const feature of features.length ? features : ['<all>']) {
    for (const pattern of (patterns.length ? patterns : ['<applicable>'])) {
      jobs.push(jobEnvelope({ id: `j${++n}`, role: 'hunter', scope: scope.mode, method: scope.method, feature, patterns: [pattern], prompt: scope.prompt }));
    }
  }
  return jobs;
}

function slugFor(candidate) { return `${candidate.family}-${candidate.title}`; }

function findingOf(candidate, n, engineUsed, modelUsed = null, effort = 'medium') {
  return {
    id: ID.finding(n, slugFor(candidate)),
    family: candidate.family,
    cwe: candidate.cwe,
    title: candidate.title,
    severity: candidate.severity,
    feature: candidate.featureId,
    endpoint: candidate.endpointId,
    method: candidate.method,
    route: candidate.route,
    evidence: candidate.evidence,
    rule: candidate.rule,
    engine: { provider: engineUsed, model: modelUsed || null, effort }, // AI-4 + PHASE4 §2.2: same shape as the session record
    verified_by: candidate.llmNominated ? 'llm-nominated+rule-confirmed' : 'rule', // additive, auditability only

    lifecycle: 'terminal',
    outcome: 'vulnerable',
    verification: 'verified',
    assessment_mode: 'static_confirmed',
    createdAt: new Date().toISOString(),
  };
}

// ---- optional LLM-assist HUNT step (gated on `engine`) ------------------------------------
// Deterministic rules.js is the always-on source of truth; this only ever ADDS candidates on
// top of it, and any adapter failure degrades silently to "no extra candidates".
// Only families with a real deterministic rule can ever be promoted (reproveLlmCandidate() drops
// anything else) — QIX/SX have no rule (no dataflow tracing in this mapper, see design doc §0/§5),
// so inviting the model to guess at them and inflating buildGroundedPrompt with instructions the
// pipeline can never use would be dishonest. Grows only when a real corroborating rule lands.
export const LLM_FAMILIES = new Set(['ACX']);
const FAMILY_CWE = Object.fromEntries(FAMILIES.map((f) => [f.prefix, f.cwe[0]]));
// PHASE4 §2.2: effort also bounds how many extra LLM-nominated candidates the assist step may
// surface — the second real, honest effect (alongside the adapters' token-budget scaling).
const LLM_CAPS = { low: 5, medium: 10, high: 15, max: 20 };
function llmCap(effort) { return LLM_CAPS[effort] || LLM_CAPS.medium; }
const LLM_TIMEOUT_MS = Number(process.env.SECFORGE_LLM_TIMEOUT_MS) || 180000; // real CLI models (codex exec) need minutes, not seconds
// Effort's THIRD honest, documented effect (alongside the adapters' token-budget scaling and
// LLM_CAPS above): how much fed-forward context (§1 of the Phase B design) goes into each
// per-feature ask(). No tokenizer in this zero-dep codebase — bounded by count/char caps instead.
const CONTEXT_CAPS = {
  low: { maxCitations: 8, maxEndpoints: 10 },
  medium: { maxCitations: 16, maxEndpoints: 20 },
  high: { maxCitations: 24, maxEndpoints: 30 },
  max: { maxCitations: 40, maxEndpoints: 50 }, // 40 == retrieveFeatureContext's own default ceiling
};
// Run-wide bound: at most this many FEATURE nodes get an LLM call per scan. Features beyond the
// cap get zero LLM-assist this run — they still get full deterministic coverage (analyze() runs
// over the whole graph regardless of engine). Never silently eaten: the count surfaces as
// result.featuresSkipped.
const MAX_LLM_FEATURES_PER_RUN = 8;

// Belt-and-suspenders timeout: the adapter enforces its own, but a scan must never hang on it.
// Resolves to null (not a rejection) on error/timeout so callers can treat it as "no answer".
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } },
    );
  });
}

// route -> {featureId, endpointId} across the WHOLE graph (unscoped by design — the scope
// narrowing that matters happens earlier, at which features llmAssist even calls buildFeedForward
// for; this table only resolves a route string a surviving candidate already named).
function buildRouteIndex(graph) {
  const idx = indexGraph(graph);
  const routeIndex = new Map();
  for (const feature of graph.nodes.filter((n) => n.type === 'FEATURE')) {
    for (const ep of endpointsOfFeature(idx, feature.id)) {
      if (ep.data?.route) routeIndex.set(ep.data.route, { featureId: feature.id, endpointId: ep.id, method: ep.data?.method });
    }
  }
  return routeIndex;
}

// Per-feature grounded prompt (Phase B design §1.2): the retrieval package's GROUNDING_PREAMBLE
// verbatim, then the feature's own endpoints/data-stores/roles/depth facts, then its cited source
// excerpts, ending in the strict output format the gate (grounding.js) requires a trailing
// file:line on. Bounded by `caps` (CONTEXT_CAPS) — count/char caps, no tokenizer.
function fmtEndpoint(ep) {
  return `- ${ep.method || '?'} ${ep.route || ep.name}  [authn=${!!ep.authn} authz=${!!ep.authz}]`;
}
function fmtCitation(c) {
  const excerpt = (c.excerpt || '').slice(0, 500);
  return `- ${c.file}:${c.line}\n${excerpt}`;
}
// `focus` = the tester's own ask plus what the rag store located for THIS feature — the model is
// told where the map says X lives, but the grounding/citation rules below are unchanged.
function fmtFocus(focus, featureId) {
  if (!focus?.prompt) return [];
  const mine = (focus.located?.endpoints || []).filter((e) => e.feature === featureId).slice(0, 10);
  return [
    `Focus (what the tester asked to test): ${focus.prompt}`,
    ...(mine.length ? ['Where the map says it lives in this feature:', ...mine.map((e) => `- ${e.title}  [${e.files.join(', ')}]`)] : []),
    '',
  ];
}
function buildGroundedPrompt(bundle, caps, focus = null) {
  const endpoints = bundle.endpoints || [];
  const shown = endpoints.slice(0, caps.maxEndpoints);
  const moreEndpoints = endpoints.length - shown.length;
  const citations = bundle.citations || [];

  return [
    bundle.preamble,
    '',
    `Feature: ${bundle.feature?.name || bundle.feature?.id} (${bundle.feature?.id})`,
    '',
    ...fmtFocus(focus, bundle.feature?.id),
    'Endpoints:',
    ...shown.map(fmtEndpoint),
    ...(moreEndpoints > 0 ? [`  ...and ${moreEndpoints} more endpoint(s) not shown`] : []),
    '',
    `Data stores: ${(bundle.dataStores || []).map((d) => d.name).join(', ') || '(none)'}`,
    `Roles: ${(bundle.roles || []).map((r) => r.name).join(', ') || '(none)'}`,
    `Depth: reaches ${bundle.depth?.memberCount ?? 0} node(s) across ${bundle.depth?.filesTouched ?? 0} file(s)`,
    '',
    'Cited source — use ONLY these when naming a location:',
    ...citations.map(fmtCitation),
    '',
    'List LIKELY access-control (IDOR/broken authorization) issues for THIS feature only.',
    'One line per issue:',
    'FAMILY|title|METHOD|ROUTE|severity|file:line',
    'FAMILY is ACX; ROUTE copied EXACTLY from Endpoints; file:line copied EXACTLY',
    'from Cited source above. If you cannot point to one of the citations above for an issue,',
    'do not report it — never invent or estimate a file or line number.',
  ].join('\n');
}

function dedupeKey(c) { return `${c.family}::${c.route}`; }

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function familyFromText(s) {
  const t = s.toLowerCase();
  if (/ssrf|server-side request/.test(t)) return 'SX';
  if (/sql|nosql|command inj|\binjection\b/.test(t)) return 'QIX';
  if (/idor|access control|authoriz|ownership|broken object|bola|privilege escal/.test(t)) return 'ACX';
  return null;
}
function severityFromText(s) {
  const t = s.toLowerCase();
  return /\bcritical\b/.test(t) ? 'critical' : /\bhigh\b/.test(t) ? 'high' : /\blow\b/.test(t) ? 'low' : 'medium';
}

// Parse model output into grounded candidates. Strict `FAMILY|title|METHOD|ROUTE|severity|file:line`
// lines first; otherwise a lenient pass that only accepts a line naming a KNOWN route (from the
// graph) plus a recognisable vuln keyword — so the model contributes without a rigid format and
// cannot invent routes that don't exist. Either way, a shape match is not enough to survive: the
// grounding gate (citationFromLine, over THIS feature's own fed-forward citationIdx) must also find
// a real file:line, or the candidate is dropped here — before TRIAGE, before reproveLlmCandidate.
function parseLlmCandidates(text, routeIndex, citationIdx) {
  if (!text || typeof text !== 'string') return { candidates: [], citationDropped: 0 };
  const knownRoutes = [...routeIndex.keys()];
  const out = [];
  let citationDropped = 0;
  const push = (family, title, method, route, sev, citation) => {
    const mapped = routeIndex.get(route) || {};
    out.push({
      family, cwe: FAMILY_CWE[family], title: (title || `${family} issue`).slice(0, 140),
      featureId: mapped.featureId || null, endpointId: mapped.endpointId || null,
      method: ((method || mapped.method || '') + '').toUpperCase() || null, route,
      severity: SEVERITIES.includes(sev) ? sev : 'medium',
      evidence: { file: citation.file, line: citation.line }, citation, rule: 'llm',
    });
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    let family, title, method, route, sev;
    if (parts.length >= 4 && LLM_FAMILIES.has(parts[0])) {
      [family, title, method, route, sev] = parts;
    } else {
      // lenient, grounded: a known route mentioned in the line + a vuln keyword
      const foundRoute = knownRoutes.find((r) => r && line.includes(r));
      const foundFamily = foundRoute ? familyFromText(line) : null;
      if (!foundRoute || !foundFamily) continue;
      family = foundFamily; title = line; method = null; route = foundRoute; sev = severityFromText(line);
    }
    const citation = citationFromLine(line, citationIdx);
    if (!citation) { citationDropped++; continue; } // recognisable candidate, no grounded citation → dropped
    push(family, title, method, route, sev, citation);
  }
  return { candidates: out, citationDropped };
}

// Run the bounded, GROUNDED LLM-assist HUNT step (Phase B §1): iterate in-scope FEATURE nodes
// only, feed each one forward via @secforge/retrieval's buildFeedForward, and gate every returned
// candidate on citing a file:line from THAT feature's own citation pool. Never throws; degrades to
// zero extra candidates (and reports every feature it didn't call) on any adapter trouble.
async function llmAssist(store, projectId, graph, engine, existingCandidates, model, effort = 'medium', scope = {}, snapshotId = null, located = null) {
  const none = { extra: [], featuresSkipped: 0, llmCitationDropped: 0 };
  if (!engine || engine === 'rules' || !store || !projectId) return none;

  let adapter;
  try { adapter = getAdapter(engine); } catch { return none; }

  let available = false;
  try { available = await withTimeout(adapter.available(), LLM_TIMEOUT_MS); } catch { available = false; }
  if (!available) return none;

  const features = graph.nodes.filter((n) => n.type === 'FEATURE' && inScope(n.id, scope));
  if (!features.length) return none;

  const routeIndex = buildRouteIndex(graph);
  const caps = CONTEXT_CAPS[effort] || CONTEXT_CAPS.medium;
  const cap = llmCap(effort);
  const seen = new Set(existingCandidates.map(dedupeKey));
  const extra = [];
  let featuresSkipped = 0;
  let llmCitationDropped = 0;

  const toCall = features.slice(0, MAX_LLM_FEATURES_PER_RUN);
  featuresSkipped += features.length - toCall.length; // beyond the run-wide feature cap

  try {
    for (let i = 0; i < toCall.length; i++) {
      if (extra.length >= cap) { featuresSkipped += toCall.length - i; break; } // candidate cap already full
      const feature = toCall[i];
      const bundle = await buildFeedForward(store, projectId, feature.id, { maxCitations: caps.maxCitations, snapshotId });
      if (!bundle.ok || !bundle.endpoints?.length || !bundle.citations?.length) { featuresSkipped++; continue; } // nothing to ground an answer against
      const citationIdx = citationIndex(bundle);
      const prompt = buildGroundedPrompt(bundle, caps, scope.method === 'prompt' ? { prompt: scope.prompt, located } : null);
      const text = await withTimeout(adapter.ask(prompt, { model, effort }), LLM_TIMEOUT_MS);
      const { candidates, citationDropped } = parseLlmCandidates(text, routeIndex, citationIdx);
      llmCitationDropped += citationDropped;
      for (const c of candidates) {
        const key = dedupeKey(c);
        if (seen.has(key) || extra.length >= cap) continue;
        seen.add(key);
        extra.push(c);
      }
    }
  } catch {
    // fall through — return whatever was gathered before the failure
  }
  return { extra, featuresSkipped, llmCitationDropped };
}

// REPORT stage: persist each surviving candidate as a finding, plus its graph shadow
// (VULN_CANDIDATE + FINDING nodes, VIOLATES/MAPS_TO_CWE/CANDIDATE_IN/PROMOTED_TO edges).
async function report(store, projectId, candidates, graph, engineUsed, ctx = {}) {
  const findings = [];
  const seenNodes = new Set(graph.nodes.map((n) => n.id));
  const newNodes = [];
  const newEdges = [];
  const addNode = (node) => { if (!seenNodes.has(node.id)) { seenNodes.add(node.id); newNodes.push(node); } };

  let n = 0;
  for (const candidate of candidates) {
    n += 1;
    const base = findingOf(candidate, n, engineUsed, ctx.model, ctx.effort);
    const snippet = buildSnippet(store, projectId, ctx.snapshotId, base.evidence, { sourceRoot: ctx.sourceRoot, manifest: ctx.manifest });
    const finding = decorateFinding(base, { snippet });
    await store.writeFinding(projectId, finding);
    findings.push(finding);

    const patternId = `pattern:${candidate.family.toLowerCase()}`;
    const cweId = ID.cwe(candidate.cwe);
    addNode({ id: candidate.id, type: 'VULN_CANDIDATE', name: candidate.title,
      data: { family: candidate.family, cwe: candidate.cwe, severity: candidate.severity, rule: candidate.rule },
      claims: [candidate.evidence] });
    addNode({ id: finding.id, type: 'FINDING', name: candidate.title,
      data: { family: candidate.family, cwe: candidate.cwe, severity: finding.severity },
      claims: [candidate.evidence] });
    addNode({ id: patternId, type: 'PATTERN', name: candidate.family, data: {}, claims: [] });
    addNode({ id: cweId, type: 'CWE', name: candidate.cwe, data: {}, claims: [] });

    newEdges.push({ id: `edge:${candidate.id}:VIOLATES:${patternId}`, type: 'VIOLATES', src: candidate.id, dst: patternId });
    newEdges.push({ id: `edge:${candidate.id}:MAPS_TO_CWE:${cweId}`, type: 'MAPS_TO_CWE', src: candidate.id, dst: cweId });
    if (candidate.featureId) {
      newEdges.push({ id: `edge:${candidate.id}:CANDIDATE_IN:${candidate.featureId}`, type: 'CANDIDATE_IN', src: candidate.id, dst: candidate.featureId });
    }
    newEdges.push({ id: `edge:${candidate.id}:PROMOTED_TO:${finding.id}`, type: 'PROMOTED_TO', src: candidate.id, dst: finding.id });

    await store.appendEvent(projectId, { type: 'finding.reported', finding: finding.id, family: candidate.family, cwe: candidate.cwe });
  }

  if (newNodes.length) await writeNodes(store, projectId, [...graph.nodes, ...newNodes]);
  if (newEdges.length) await writeEdges(store, projectId, [...graph.edges, ...newEdges]);
  return findings;
}

/**
 * Run an assessment: readGraph -> analyze (HUNT) -> TRIAGE -> VALIDATE -> REPORT.
 * Without store/projectId this degrades to the pure analyze() pass with no persistence
 * (kept for callers that haven't wired a project through yet).
 * The `engine` selects an optional LLM-assist HUNT step layered on top of the deterministic
 * rules (which always run, regardless of engine, and are the source of truth). 'rules' (the
 * default) skips the LLM step entirely; any other engine id is resolved via getAdapter() and
 * used only if available() — an unknown, unavailable, or erroring adapter silently falls back
 * to deterministic-only, it never fails the run.
 * @returns {Promise<{jobs:number, candidates:Array, findings:Array, coverage:object|null, engineUsed:string, featuresSkipped:number, llmCitationDropped:number}>}
 */
// "Test X" → where X lives. Features scoring under this fraction of the best match are left out of
// the narrowed scope (they still appear in result.located for the tester to see).
const LOCATE_FLOOR = 0.35, LOCATE_MAX_FEATURES = 5;

export async function runAssessment({ store, projectId, scope = {}, engine = 'rules', model = null, effort = 'medium', onEvent } = {}) {
  // Pin the WHOLE scan to one snapshot id, resolved once up front, so this run's grounding (§1/§2)
  // and its evidence snippets (§3) are always about the exact same immutable snapshot — even if a
  // mapProject run lands a new snapshot for the same project concurrently.
  let snapshotId = null;
  let graph = { nodes: [], edges: [] };
  if (store && projectId) {
    snapshotId = await readCurrentSnapshotId(store, projectId);
    graph = await readGraph(store, projectId, snapshotId || undefined);
  }

  // A free-text ask ("test receipt download") is resolved through the snapshot's rag/ store so both
  // the rule pass and the LLM pass look only where the map says X lives. An explicit feature/pick
  // scope from the tester always wins over the located one; a coverage gap leaves the scope as-is.
  let located = null;
  if (store && projectId && scope.method === 'prompt' && String(scope.prompt || '').trim()) {
    located = await locate(store, projectId, scope.prompt, { snapshotId: snapshotId || undefined }).catch(() => null);
    if (located?.ok && scope.mode === 'all' && located.features.length) {
      const floor = located.features[0].score * LOCATE_FLOOR;
      scope = { ...scope, mode: 'pick', features: located.features.filter((f) => f.score >= floor).slice(0, LOCATE_MAX_FEATURES).map((f) => f.id), locatedFrom: 'prompt' };
    }
  }
  onEvent?.({ stage: 'locate', located: located ? { features: located.features.length, endpoints: located.endpoints.length, coverageGap: located.coverageGap } : null });

  const jobs = planJobs(scope);
  onEvent?.({ stage: 'framer', status: 'done', jobs: jobs.length });
  for (const job of jobs) onEvent?.({ stage: 'hunter', job: job.id, feature: job.feature, engine });

  const candidates = analyze(graph, { scope, patterns: scope.patterns });
  const { extra: llmExtra, featuresSkipped, llmCitationDropped } = await llmAssist(
    store, projectId, graph, engine, candidates, model, effort, scope, snapshotId, located,
  ).catch(() => ({ extra: [], featuresSkipped: 0, llmCitationDropped: 0 }));
  let n = candidates.length;
  const allCandidates = candidates.concat(
    llmExtra.map((c) => ({ ...c, id: ID.candidate(++n) })),
  ).filter((c) => inScope(c.featureId, scope)); // close the LLM-assist scope leak (deterministic side already applies this in analyze())
  onEvent?.({ stage: 'grounding', llmCitationDropped, featuresSkipped });

  onEvent?.({ stage: 'triager', kept: allCandidates.length });
  const triaged = allCandidates.map((c) => ({ ...c, triaged: true }));

  // VALIDATE: every candidate — deterministic or LLM-nominated — passes an independent
  // deterministic gate before it can be promoted. An LLM candidate is NEVER trusted on its own
  // word: it is only promoted when reproveLlmCandidate() finds the deterministic rule engine
  // independently flags the same endpoint, and if so it is re-attributed to that rule's own
  // cwe/severity/evidence. A family with no deterministic rule (QIX/SX) can never be promoted.
  let llmDropped = 0;
  const validated = [];
  for (const c of triaged) {
    if (c.rule === 'llm') {
      const reproved = reproveLlmCandidate(c, graph);
      if (reproved) validated.push({ ...reproved, verified: true });
      else llmDropped++;
    } else if (validateCandidate(c, graph)) {
      validated.push({ ...c, verified: true });
    }
  }
  onEvent?.({ stage: 'validator', queued: triaged.length, verified: validated.length, llmDropped });

  let findings = [];
  let coverage = null;
  if (store && projectId) {
    const [sourceRoot, manifest] = await Promise.all([readSourceRoot(store, projectId), loadManifest(store, projectId)]);
    findings = await report(store, projectId, validated, graph, engine, { sourceRoot, manifest, model, effort, snapshotId });
    coverage = await computeCoverage(store, projectId);
  }
  onEvent?.({ stage: 'reporter', promoted: findings.length });

  return {
    jobs: jobs.length, candidates: validated, findings, coverage, engineUsed: engine, featuresSkipped, llmCitationDropped,
    // where the "test X" ask was resolved to (null when the run wasn't a prompt); scope is the
    // narrowed scope actually used, so the tester sees exactly which features were assessed.
    located: located ? { ...located, chunks: undefined, scope: { mode: scope.mode, features: scope.features || null } } : null,
  };
}

export { analyze, validateCandidate, reproveLlmCandidate, inScope, computeCoverage, ID };
export { severityFromScore, RULE_CVSS, RULE_CWE } from './rules.js';
export { decorateFinding, buildSnippet, loadManifest, readSourceRoot, readCurrentSnapshotId } from './decorate.js';
export { buildReport, renderMarkdown, reportJson } from './report.js';
export { renderFeatureMap } from './feature-map.js';
export { citationIndex, citationFromLine, makeSnapshotVerifier, frozenVerify } from './grounding.js';
