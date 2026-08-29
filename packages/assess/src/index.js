// @secforge/assess — the assessment engine. FRAME -> HUNT (analyze) -> TRIAGE -> VALIDATE ->
// REPORT over a project's graph, tracking coverage as a feature x family matrix. Deterministic
// rules only, no LLM: the graph is the only input, Node stdlib the only dependency.

import { ID } from '@secforge/schemas';
import { readGraph, writeNodes, writeEdges } from '@secforge/store';
import { jobEnvelope } from '@secforge/schemas';
import { analyze, validateCandidate } from './rules.js';
import { computeCoverage } from './coverage.js';

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

function findingOf(candidate, n) {
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
    lifecycle: 'terminal',
    outcome: 'vulnerable',
    verification: 'verified',
    assessment_mode: 'static_confirmed',
    createdAt: new Date().toISOString(),
  };
}

// REPORT stage: persist each surviving candidate as a finding, plus its graph shadow
// (VULN_CANDIDATE + FINDING nodes, VIOLATES/MAPS_TO_CWE/CANDIDATE_IN/PROMOTED_TO edges).
async function report(store, projectId, candidates, graph) {
  const findings = [];
  const seenNodes = new Set(graph.nodes.map((n) => n.id));
  const newNodes = [];
  const newEdges = [];
  const addNode = (node) => { if (!seenNodes.has(node.id)) { seenNodes.add(node.id); newNodes.push(node); } };

  let n = 0;
  for (const candidate of candidates) {
    n += 1;
    const finding = findingOf(candidate, n);
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
 * @returns {Promise<{jobs:number, candidates:Array, findings:Array, coverage:object|null}>}
 */
export async function runAssessment({ store, projectId, scope = {}, engine, onEvent } = {}) {
  const jobs = planJobs(scope);
  onEvent?.({ stage: 'framer', status: 'done', jobs: jobs.length });

  const graph = (store && projectId) ? await readGraph(store, projectId) : { nodes: [], edges: [] };
  for (const job of jobs) onEvent?.({ stage: 'hunter', job: job.id, feature: job.feature });

  const candidates = analyze(graph, { scope, patterns: scope.patterns });
  onEvent?.({ stage: 'triager', kept: candidates.length });
  const triaged = candidates.map((c) => ({ ...c, triaged: true }));

  onEvent?.({ stage: 'validator', queued: triaged.length });
  const validated = triaged
    .filter((c) => validateCandidate(c, graph))
    .map((c) => ({ ...c, verified: true }));

  let findings = [];
  let coverage = null;
  if (store && projectId) {
    findings = await report(store, projectId, validated, graph);
    coverage = await computeCoverage(store, projectId);
  }
  onEvent?.({ stage: 'reporter', promoted: findings.length });

  return { jobs: jobs.length, candidates: validated, findings, coverage };
}

export { analyze, validateCandidate, computeCoverage, ID };
