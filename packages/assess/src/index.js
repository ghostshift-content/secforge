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
import { analyze, validateCandidate } from './rules.js';
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

function findingOf(candidate, n, engineUsed) {
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
    engine: engineUsed,
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
const LLM_FAMILIES = new Set(['ACX', 'QIX', 'SX']); // access-control / injection / SSRF only
const FAMILY_CWE = Object.fromEntries(FAMILIES.map((f) => [f.prefix, f.cwe[0]]));
const LLM_CAP = 10;
const LLM_TIMEOUT_MS = Number(process.env.SECFORGE_LLM_TIMEOUT_MS) || 20000; // slower local models need room
const LLM_MANY_FEATURES = 8; // above this, one ask() over a compact summary instead of per-feature

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

function summarizeFeatures(graph) {
  const idx = indexGraph(graph);
  const routeIndex = new Map(); // route -> {featureId, endpointId}
  const summaries = [];
  for (const feature of graph.nodes.filter((n) => n.type === 'FEATURE')) {
    const eps = endpointsOfFeature(idx, feature.id);
    if (!eps.length) continue;
    for (const ep of eps) {
      if (ep.data?.route) routeIndex.set(ep.data.route, { featureId: feature.id, endpointId: ep.id });
    }
    summaries.push({ name: feature.name, endpoints: eps.map((e) => `${e.data?.method || '?'} ${e.data?.route || e.name}`) });
  }
  return { summaries, routeIndex };
}

function buildPrompt(summaries) {
  const lines = summaries.map((f) => `- ${f.name}: ${f.endpoints.join(', ') || '(no mapped endpoints)'}`).join('\n');
  return [
    'You are a security reviewer. For the HTTP endpoints below, list LIKELY access-control (IDOR/',
    'broken authorization), injection (SQL/command), or SSRF issues. Prefer one line per issue as:',
    'FAMILY|title|METHOD|ROUTE|severity',
    'where FAMILY is ACX (access control), QIX (injection), or SX (SSRF); severity is low/medium/high/critical;',
    'and ROUTE is copied EXACTLY from the list below. Example:',
    'ACX|order readable by any authenticated user|GET|/orders/:id|high',
    'If you prefer prose, still name the exact route and the issue type clearly.',
    '',
    'Endpoints by feature:',
    lines,
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

// Parse model output into grounded candidates. Strict `FAMILY|title|METHOD|ROUTE|severity` lines
// first; otherwise a lenient pass that only accepts a line naming a KNOWN route (from the graph)
// plus a recognisable vuln keyword — so the model contributes without a rigid format and cannot
// invent routes that don't exist.
function parseLlmCandidates(text, routeIndex) {
  if (!text || typeof text !== 'string') return [];
  const knownRoutes = [...routeIndex.keys()];
  const push = (out, family, title, method, route, sev) => {
    const mapped = routeIndex.get(route) || {};
    out.push({
      family, cwe: FAMILY_CWE[family], title: (title || `${family} issue`).slice(0, 140),
      featureId: mapped.featureId || null, endpointId: mapped.endpointId || null,
      method: ((method || mapped.method || '') + '').toUpperCase() || null, route,
      severity: SEVERITIES.includes(sev) ? sev : 'medium',
      evidence: { file: null, line: null }, rule: 'llm',
    });
  };
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length >= 4 && LLM_FAMILIES.has(parts[0])) {
      push(out, parts[0], parts[1], parts[2], parts[3], parts[4]);
      continue;
    }
    // lenient, grounded: a known route mentioned in the line + a vuln keyword
    const route = knownRoutes.find((r) => r && line.includes(r));
    if (!route) continue;
    const family = familyFromText(line);
    if (!family) continue;
    push(out, family, line, null, route, severityFromText(line));
  }
  return out;
}

// Run the bounded LLM-assist HUNT step. Never throws; returns [] on any adapter trouble.
async function llmAssist(graph, engine, existingCandidates) {
  if (!engine || engine === 'rules') return [];

  let adapter;
  try { adapter = getAdapter(engine); } catch { return []; }

  let available = false;
  try { available = await withTimeout(adapter.available(), LLM_TIMEOUT_MS); } catch { available = false; }
  if (!available) return [];

  const { summaries, routeIndex } = summarizeFeatures(graph);
  if (!summaries.length) return [];

  const seen = new Set(existingCandidates.map(dedupeKey));
  const extra = [];
  const absorb = (text) => {
    for (const c of parseLlmCandidates(text, routeIndex)) {
      const key = dedupeKey(c);
      if (seen.has(key) || extra.length >= LLM_CAP) continue;
      seen.add(key);
      extra.push(c);
    }
  };

  try {
    const batches = summaries.length > LLM_MANY_FEATURES ? [summaries] : summaries.map((s) => [s]);
    for (const batch of batches) {
      if (extra.length >= LLM_CAP) break;
      const text = await withTimeout(adapter.ask(buildPrompt(batch)), LLM_TIMEOUT_MS);
      absorb(text);
    }
  } catch {
    // fall through — return whatever was gathered before the failure
  }
  return extra;
}

// REPORT stage: persist each surviving candidate as a finding, plus its graph shadow
// (VULN_CANDIDATE + FINDING nodes, VIOLATES/MAPS_TO_CWE/CANDIDATE_IN/PROMOTED_TO edges).
async function report(store, projectId, candidates, graph, engineUsed) {
  const findings = [];
  const seenNodes = new Set(graph.nodes.map((n) => n.id));
  const newNodes = [];
  const newEdges = [];
  const addNode = (node) => { if (!seenNodes.has(node.id)) { seenNodes.add(node.id); newNodes.push(node); } };

  let n = 0;
  for (const candidate of candidates) {
    n += 1;
    const finding = findingOf(candidate, n, engineUsed);
    await store.writeFinding(projectId, finding);
    findings.push(finding);

    const patternId = `pattern:${candidate.family.toLowerCase()}`;
    const cweId = ID.cwe(candidate.cwe);
    addNode({ id: candidate.id, type: 'VULN_CANDIDATE', name: candidate.title,
      data: { family: candidate.family, cwe: candidate.cwe, severity: candidate.severity, rule: candidate.rule },
      claims: [candidate.evidence] });
    addNode({ id: finding.id, type: 'FINDING', name: candidate.title,
      data: { family: candidate.family, cwe: candidate.cwe, severity: candidate.severity },
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
 * @returns {Promise<{jobs:number, candidates:Array, findings:Array, coverage:object|null, engineUsed:string}>}
 */
export async function runAssessment({ store, projectId, scope = {}, engine = 'rules', onEvent } = {}) {
  const jobs = planJobs(scope);
  onEvent?.({ stage: 'framer', status: 'done', jobs: jobs.length });

  const graph = (store && projectId) ? await readGraph(store, projectId) : { nodes: [], edges: [] };
  for (const job of jobs) onEvent?.({ stage: 'hunter', job: job.id, feature: job.feature, engine });

  const candidates = analyze(graph, { scope, patterns: scope.patterns });
  const llmExtra = await llmAssist(graph, engine, candidates).catch(() => []);
  let n = candidates.length;
  const allCandidates = candidates.concat(
    llmExtra.map((c) => ({ ...c, id: ID.candidate(++n) })),
  );

  onEvent?.({ stage: 'triager', kept: allCandidates.length });
  const triaged = allCandidates.map((c) => ({ ...c, triaged: true }));

  onEvent?.({ stage: 'validator', queued: triaged.length });
  const validated = triaged
    .filter((c) => validateCandidate(c, graph))
    .map((c) => ({ ...c, verified: true }));

  let findings = [];
  let coverage = null;
  if (store && projectId) {
    findings = await report(store, projectId, validated, graph, engine);
    coverage = await computeCoverage(store, projectId);
  }
  onEvent?.({ stage: 'reporter', promoted: findings.length });

  return { jobs: jobs.length, candidates: validated, findings, coverage, engineUsed: engine };
}

export { analyze, validateCandidate, computeCoverage, ID };
