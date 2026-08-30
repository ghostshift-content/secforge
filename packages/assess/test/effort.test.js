// docs/PHASE4-ENV-PROVIDER-DESIGN.md §2 — effort threads into the run's findings for
// reproducibility, and is INERT (asserted, not just stated) for the deterministic rules engine;
// its one real effect on this engine's own code is llmAssist()'s candidate cap.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { register } from '@secforge/adapters';
import { runAssessment } from '@secforge/assess';

const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route }, claims: [{ file: 'a.js', line: 2 }] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

describe('effort: recorded on every finding, defaults to medium', () => {
  let tmpRoot, store, pid;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-effort-record-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    pid = (await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'EFFREC' })).id;
    await writeNodes(store, pid, [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id')], { snapshotId: 'snap' });
    await writeEdges(store, pid, [edge('EXPOSES', 'f:orders', 'ep')], { snapshotId: 'snap' });
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('no effort passed → finding.engine.effort === "medium" (default)', async () => {
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].engine.effort, 'medium');
  });

  test('effort:"max" passed → finding.engine.effort === "max"', async () => {
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules', effort: 'max' });
    assert.equal(result.findings[0].engine.effort, 'max');
  });
});

describe('effort is inert for the deterministic rules engine (asserted, not just stated)', () => {
  let tmpRoot, store, pid;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-effort-inert-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    pid = (await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'EFFINERT' })).id;
    await writeNodes(store, pid, [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id')], { snapshotId: 'snap' });
    await writeEdges(store, pid, [edge('EXPOSES', 'f:orders', 'ep')], { snapshotId: 'snap' });
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  // Strip the fields that vary run-to-run for reasons OTHER than effort (the recorded effort
  // field itself, and the wall-clock createdAt timestamp) before comparing — everything the
  // deterministic rules engine actually derives must be byte-identical regardless of effort.
  function withoutEffort(findings) {
    return findings.map((f) => {
      const { engine, createdAt, ...rest } = f;
      const { effort, ...engineRest } = engine;
      return { ...rest, engine: engineRest };
    });
  }

  test('rules-engine findings are byte-identical for effort "low" vs "max", apart from the recorded effort field', async () => {
    const low = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules', effort: 'low' });
    await store.clearFindings(pid);
    const max = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules', effort: 'max' });
    assert.equal(low.findings.length, max.findings.length);
    assert.deepEqual(withoutEffort(low.findings), withoutEffort(max.findings));
    assert.equal(low.findings[0].engine.effort, 'low');
    assert.equal(max.findings[0].engine.effort, 'max');
  });
});

describe('llmAssist(): effort scales the LLM-assist candidate cap (the second real effort effect)', () => {
  let tmpRoot, store;
  const N = 8; // > EFFORT_CAP.low(5), <= EFFORT_CAP.max(20)

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-effort-cap-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  async function makeManyUnauthProject(tag) {
    const sourceRoot = path.join(tmpRoot, tag);
    await fs.mkdir(sourceRoot, { recursive: true });
    const project = await store.openProject({ sourceRoot, name: tag });
    const nodes = [], edges = [];
    for (let i = 0; i < N; i++) {
      nodes.push(feature(`f:${i}`, `feature${i}`), endpoint(`ep:${i}`, 'GET', `/thing${i}/:id`));
      edges.push(edge('EXPOSES', `f:${i}`, `ep:${i}`));
    }
    await writeNodes(store, project.id, nodes, { snapshotId: 'snap' });
    await writeEdges(store, project.id, edges, { snapshotId: 'snap' });
    return project.id;
  }

  // Every /thingN/:id is genuinely unauthenticated, so the deterministic engine independently
  // corroborates EVERY nominated route via reproveLlmCandidate() — nothing is dropped for being
  // wrong, so the promoted count directly reflects llmAssist()'s cap, not the reprove gate.
  // Phase B grounding gate: each line's trailing |file:line must be a REAL citation from the
  // feature being asked — the shared endpoint() fixture (above) claims {file:'a.js', line:2} for
  // every feature, so 'a.js:2' grounds every line regardless of which feature's bundle produced it.
  function nominateAll() {
    const lines = [];
    for (let i = 0; i < N; i++) lines.push(`ACX|unauth thing${i}|GET|/thing${i}/:id|high|a.js:2`);
    return lines.join('\n');
  }

  test('effort "low" (cap 5) promotes at most 5 of the 8 nominated candidates', async () => {
    const pid = await makeManyUnauthProject('cap-low');
    register({ id: 'fake-cap-low', available: async () => true, ask: async () => nominateAll() });
    // scope:{patterns:['REX']} keeps the deterministic HUNT step from proposing these ACX
    // candidates itself, so llmAssist's own extras (and only them) are what gets counted here —
    // reproveLlmCandidate() still re-runs the FULL rule set fresh to corroborate each one.
    const result = await runAssessment({ store, projectId: pid, scope: { patterns: ['REX'] }, engine: 'fake-cap-low', effort: 'low' });
    assert.equal(result.findings.length, 5);
  });

  test('effort "max" (cap 20) promotes all 8 nominated candidates — nothing truncated', async () => {
    const pid = await makeManyUnauthProject('cap-max');
    register({ id: 'fake-cap-max', available: async () => true, ask: async () => nominateAll() });
    const result = await runAssessment({ store, projectId: pid, scope: { patterns: ['REX'] }, engine: 'fake-cap-max', effort: 'max' });
    assert.equal(result.findings.length, 8);
  });
});
