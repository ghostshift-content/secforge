// @secforge/assess/coverage — the feature x family coverage matrix, persisted to
// <projectDir>/assess/coverage.json.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FAMILIES } from '@secforge/patterns';
import { readGraph } from '@secforge/store';
import { STATE_CHANGING_METHODS, indexGraph, endpointsOfFeature, dataStoresOfFeature } from './graph-utils.js';

// Families this v1 engine actually has rules for (see rules.js). Everything else reads 'na' —
// honest about what was assessed rather than pretending full 24-family coverage.
const APPLICABLE_FAMILIES = new Set(['ACX', 'REX', 'SDX']);

function hasSurfaceFor(family, endpoints, dataStores) {
  if (family === 'ACX') return endpoints.length > 0;
  if (family === 'REX') return endpoints.some((e) => STATE_CHANGING_METHODS.has((e.data?.method || '').toUpperCase()));
  if (family === 'SDX') return endpoints.length > 0 && dataStores.length > 0;
  return false;
}

function cellVerdict(family, featureId, findings, hasSurface) {
  if (findings.some((f) => f.feature === featureId && f.family === family)) return 'vuln';
  if (!APPLICABLE_FAMILIES.has(family)) return 'na';
  return hasSurface ? 'pass' : 'open';
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
 * @returns {Promise<{percent:number, features:Array, families:string[], matrix:Array, byCwe:Array}>}
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
      verdict: cellVerdict(family, feature.id, findings, hasSurfaceFor(family, endpoints, dataStores)),
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
  };
  await persist(store, projectId, result);
  return result;
}
