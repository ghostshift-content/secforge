// @secforge/assess/coverage — the feature x family coverage matrix, persisted to
// <projectDir>/assess/coverage.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FAMILIES, cweCatalog } from '@secforge/patterns';
import { readGraph } from '@secforge/store';
import { STATE_CHANGING_METHODS, indexGraph, endpointsOfFeature, dataStoresOfFeature } from './graph-utils.js';
import { RULE_CWE } from './rules.js';

// Families this v1 engine actually has rules for (see rules.js). Everything else reads 'na' —
// honest about what was assessed rather than pretending full 24-family coverage.
const APPLICABLE_FAMILIES = new Set(['ACX', 'REX', 'SDX', 'RIX', 'CRX']);

function hasSurfaceFor(family, endpoints, dataStores, feature) {
  if (family === 'ACX') return endpoints.length > 0;
  if (family === 'REX') return endpoints.some((e) => STATE_CHANGING_METHODS.has((e.data?.method || '').toUpperCase()));
  if (family === 'SDX') return endpoints.length > 0 && dataStores.length > 0;
  if (family === 'RIX') return endpoints.length > 0;
  // CRX is a whole-codebase code-pattern family with no endpoint/datastore-shaped surface — any
  // feature with any mapped code counts, since a weak-crypto call could appear anywhere in it.
  if (family === 'CRX') return (feature?.data?.row_count || 0) > 0;
  return false;
}

function cellVerdict(family, featureId, findings, hasSurface) {
  if (findings.some((f) => f.feature === featureId && f.family === family)) return 'vuln';
  if (!APPLICABLE_FAMILIES.has(family)) return 'na';
  return hasSurface ? 'pass' : 'open';
}

// Per-CWE checklist over the FULL canonical catalog (cweCatalog()) — a bijection, every CWE in
// the catalog gets exactly one verdict, nothing silently skipped. Keyed off RULE_CWE (which CWEs
// SecForge actually has a DETECTOR for), never off FAMILIES.<prefix>.cwe (which lists CWEs a
// family is conceptually about, whether or not a rule implements one) — rolling this off FAMILIES
// would overclaim, e.g. ACX lists 4 CWEs but only 2 have detectors.
// 'assessed' = a deterministic rule exists for this exact CWE and ran; verdict is 'vulnerable'
//   (>=1 finding carries this cwe) or 'clean' (ran, nothing found).
// 'open'     = a rule exists for this CWE but its family never had ANY surface anywhere in the
//   project (every feature's cell for that family is 'open').
// 'na'       = no automated detector implements this CWE at all — reason always given.
function cweChecklist(matrix, findings) {
  return cweCatalog().map(({ id, name }) => {
    const rule = Object.keys(RULE_CWE).find((r) => RULE_CWE[r] === id);
    if (!rule) return { cwe: id, name, status: 'na', reason: 'no automated detector implements this CWE yet' };
    const family = rule.split('-')[0]; // every RULE_CWE key is "<FAMILY>-<slug>"
    const cells = matrix.flatMap((row) => row.cells.filter((c) => c.family === family));
    const vulnCount = findings.filter((f) => f.cwe === id).length;
    if (vulnCount > 0) return { cwe: id, name, status: 'assessed', verdict: 'vulnerable', count: vulnCount };
    if (cells.some((c) => c.verdict === 'pass')) return { cwe: id, name, status: 'assessed', verdict: 'clean' };
    return { cwe: id, name, status: 'open' };
  });
}

function groupByCwe(findings) {
  const byId = new Map();
  for (const f of findings) {
    if (!byId.has(f.cwe)) byId.set(f.cwe, { cwe: f.cwe, count: 0, findings: [] });
    const row = byId.get(f.cwe);
    row.count++;
    row.findings.push(f.id);
  }
  return [...byId.values()];
}

async function persist(store, projectId, result) {
  const file = path.join(store.projectDir(projectId), 'assess', 'coverage.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(result, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Build and persist the feature x family coverage matrix for a project.
 * @returns {Promise<{percent:number, features:Array, families:string[], matrix:Array, byCwe:Array, cweChecklist:Array}>}
 */
export async function computeCoverage(store, projectId) {
  const graph = await readGraph(store, projectId);
  const idx = indexGraph(graph);
  const findings = await store.listFindings(projectId);
  const features = graph.nodes.filter((n) => n.type === 'FEATURE');
  const families = FAMILIES.map((f) => f.prefix);

  const matrix = features.map((feature) => {
    const endpoints = endpointsOfFeature(idx, feature.id);
    const dataStores = dataStoresOfFeature(idx, feature.id);
    const cells = families.map((family) => ({
      family,
      verdict: cellVerdict(family, feature.id, findings, hasSurfaceFor(family, endpoints, dataStores, feature)),
    }));
    return { feature: feature.id, name: feature.name, cells };
  });

  const total = matrix.length * families.length;
  const decided = matrix.reduce((s, row) => s + row.cells.filter((c) => c.verdict !== 'open').length, 0);
  const percent = total ? Math.round((decided / total) * 100) : 0;

  const result = {
    percent,
    features: features.map((f) => ({ id: f.id, name: f.name })),
    families,
    matrix,
    byCwe: groupByCwe(findings),
    cweChecklist: cweChecklist(matrix, findings),
  };
  await persist(store, projectId, result);
  return result;
}
