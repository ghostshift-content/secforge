// @secforge/assess/demo — self-check. `node packages/assess/src/demo.js` exits 0 on success.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { ID } from '@secforge/schemas';
import { analyze, computeCoverage, runAssessment } from './index.js';

// ---- tiny in-memory graph: one feature, one unguarded POST endpoint, one data store ----
const featureId = ID.feature('billing');
const endpointId = ID.endpoint('POST', '/billing/charge');
const dataStoreId = 'datastore:billing/models.js:20';

const nodes = [
  { id: featureId, type: 'FEATURE', name: 'billing', data: { dir: 'billing' },
    claims: [{ file: 'billing/index.js', line: 1 }] },
  { id: endpointId, type: 'ENDPOINT', name: 'POST /billing/charge', data: { method: 'POST', route: '/billing/charge' },
    claims: [{ file: 'billing/routes.js', line: 10 }] },
  { id: dataStoreId, type: 'DATA_STORE', name: 'Charge', data: {},
    claims: [{ file: 'billing/models.js', line: 20 }] },
];
const edges = [
  { id: `edge:${featureId}:EXPOSES:${endpointId}`, type: 'EXPOSES', src: featureId, dst: endpointId },
  { id: `edge:${featureId}:HANDLED_BY:${dataStoreId}`, type: 'HANDLED_BY', src: featureId, dst: dataStoreId },
];

// ---- 1. analyze() is pure: no guard edges anywhere -> all three rules should fire ----
const candidates = analyze({ nodes, edges }, { scope: {} });
assert.ok(candidates.length >= 3, `expected >=3 candidates, got ${candidates.length}`);
const families = new Set(candidates.map((c) => c.family));
assert.ok(families.has('ACX') && families.has('REX') && families.has('SDX'), 'expected ACX+REX+SDX candidates');
for (const c of candidates) {
  assert.ok(c.id && c.evidence?.file && c.rule, 'candidate missing id/evidence/rule');
}

// ---- 2. runAssessment against a real (temp) store persists findings + coverage ----
const dataRoot = mkdtempSync(join(tmpdir(), 'secforge-assess-demo-'));
const store = new Store(dataRoot);
const project = await store.openProject({ sourceRoot: dataRoot, name: 'demo' });

await writeNodes(store, project.id, nodes, { snapshotId: 'snap1' });
await writeEdges(store, project.id, edges, { snapshotId: 'snap1' });

const events = [];
const result = await runAssessment({
  store, projectId: project.id, scope: { mode: 'all' },
  onEvent: (e) => events.push(e.stage),
});

assert.ok(result.findings.length >= 1, 'expected persisted findings');
assert.deepEqual(events, ['framer', 'hunter', 'triager', 'validator', 'reporter']);

const persisted = await store.listFindings(project.id);
assert.ok(persisted.length >= 1, 'expected store.listFindings to return persisted findings');
assert.ok(persisted.every((f) => f.assessment_mode === 'static_confirmed'), 'finding missing assessment_mode');

// ---- 3. computeCoverage sees the finding as a 'vuln' cell ----
const coverage = result.coverage || await computeCoverage(store, project.id);
const vulnCell = coverage.matrix
  .flatMap((row) => row.cells)
  .some((cell) => cell.verdict === 'vuln');
assert.ok(vulnCell, 'expected at least one vuln cell in the coverage matrix');
assert.ok(coverage.percent >= 0 && coverage.percent <= 100);

rmSync(dataRoot, { recursive: true, force: true });
console.log('OK — assess: analyze/runAssessment/computeCoverage all pass');
