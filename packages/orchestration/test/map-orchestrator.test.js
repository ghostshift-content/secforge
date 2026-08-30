import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { SessionManager } from '@secforge/session';
import { register } from '@secforge/adapters';
import { runMapOrchestration, subscribe } from '../src/index.js';

let tmpRoot;

before(async () => { tmpRoot = path.join(os.tmpdir(), 'sf-orch-map-' + crypto.randomBytes(4).toString('hex')); await fs.mkdir(tmpRoot, { recursive: true }); });
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

// A generic-domain, over-40-row cluster — the exact "flat Rails Core lump" shape from the design
// doc: many files, each with a distinct route, all landing in one generic top-level dir so
// deterministicSemanticPlan's fallbackKey groups them under the same noun/domain.
async function lumpedFixture(name, rowCount = 45) {
  const src = path.join(tmpRoot, name, 'src');
  await fs.mkdir(src, { recursive: true });
  for (let i = 0; i < rowCount; i++) {
    await fs.writeFile(path.join(src, `f${i}.js`), `router.get('/items/${i}', (req,res)=>res.json({}));\n`);
  }
  const store = new Store(path.join(tmpRoot, name));
  const project = await store.openProject({ sourceRoot: src, name });
  return { src, store, projectId: project.id };
}

function fakeSplitAdapter(id, splitFn) {
  register({
    id, label: 'fake', provider: 'fake', model: null,
    available: async () => true, listModels: async () => [],
    async ask(prompt) { return splitFn(prompt); },
    async runAgent() { return { ok: true, text: '' }; },
  });
}

describe('runMapOrchestration()', () => {
  test('records phases in order (profiling→…→done) and emits bus events', async () => {
    const src = path.join(tmpRoot, 'order', 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'a.js'), "router.get('/hello', (req,res)=>res.json({}));\n");
    const store = new Store(path.join(tmpRoot, 'order'));
    const project = await store.openProject({ sourceRoot: src, name: 'order' });
    const mgr = new SessionManager(store);
    const { session } = await mgr.open({ sourceRoot: src, name: 'order' });
    await mgr.start(project.id, session.sessionId);

    const seen = [];
    const unsub = subscribe(session.sessionId, (evt) => seen.push(evt.stage));

    const result = await runMapOrchestration({ store, mgr, projectId: project.id, sessionId: session.sessionId, sourceRoot: src, engine: 'rules' });
    unsub();

    assert.equal(result.ok, true);
    assert.equal(seen[0], 'profiling');
    assert.equal(seen.at(-1), 'done');
    // monotonic: every stage the design names appears in its documented relative order.
    const order = ['profiling', 'snapshot', 'inventory', 'consolidate', 'semantic', 'persist', 'done'];
    let idx = -1;
    for (const stage of order) {
      const at = seen.indexOf(stage);
      assert.ok(at > idx, `expected '${stage}' to appear after the previous stage (seen: ${seen.join(',')})`);
      idx = at;
    }

    const final = await mgr.status(project.id, session.sessionId);
    assert.equal(final.phase.stage, 'done');
    assert.equal(final.phase.pct, 100);
    assert.equal(final.phase.result.features, 1);
    assert.equal(final.status, 'running'); // phase tracking never touches session lifecycle
  });

  test('consolidation: a valid adapter partition turns a lumped cluster into named FEATURE nodes', async () => {
    fakeSplitAdapter('fake-map-split', (prompt) => {
      const rows = JSON.parse(prompt.match(/ROWS \(\d+\):\n([\s\S]*)$/)[1]);
      const half = Math.floor(rows.length / 2);
      return JSON.stringify({ subclusters: [
        { name: 'Item Alpha', slug: 'alpha', rows: rows.slice(0, half) },
        { name: 'Item Beta', slug: 'beta', rows: rows.slice(half) },
      ] });
    });
    const { src, store, projectId } = await lumpedFixture('split');
    const mgr = new SessionManager(store);
    const { session } = await mgr.open({ sourceRoot: src, name: 'split' });
    await mgr.start(projectId, session.sessionId);

    const result = await runMapOrchestration({ store, mgr, projectId, sessionId: session.sessionId, sourceRoot: src, engine: 'fake-map-split' });

    assert.equal(result.ok, true);
    const names = result.features.map((f) => f.name).sort();
    assert.deepEqual(names, ['Item Alpha', 'Item Beta']);
    assert.equal(result.consolidated, 1);
    const final = await mgr.status(projectId, session.sessionId);
    assert.equal(final.phase.result.consolidated, 1);
  });

  test('consolidation: a row the adapter claims but that is NOT a member of the cluster is dropped, never fabricated into a feature', async () => {
    fakeSplitAdapter('fake-map-fabricate', (prompt) => {
      const rows = JSON.parse(prompt.match(/ROWS \(\d+\):\n([\s\S]*)$/)[1]);
      return JSON.stringify({ subclusters: [
        { name: 'Real', slug: 'real', rows: [rows[0], { file: 'nope/fabricated.js', line: 999, entry: 'made up' }] },
      ] });
    });
    const { src, store, projectId } = await lumpedFixture('fabricate');
    const mgr = new SessionManager(store);
    const { session } = await mgr.open({ sourceRoot: src, name: 'fabricate' });
    await mgr.start(projectId, session.sessionId);

    const result = await runMapOrchestration({ store, mgr, projectId, sessionId: session.sessionId, sourceRoot: src, engine: 'fake-map-fabricate' });

    assert.equal(result.ok, true);
    const real = result.features.find((f) => f.name === 'Real');
    assert.ok(real, 'the grounded sub-feature was created');
    // Nothing in the persisted graph traces back to the fabricated file — it was dropped, not stored.
    const allClaims = result.features.flatMap((f) => f.claims || []);
    assert.ok(!allClaims.some((c) => c.file === 'nope/fabricated.js'), 'fabricated row never entered the graph');
  });

  test('consolidation: an adapter that throws leaves the original lumped cluster/features unchanged', async () => {
    register({
      id: 'fake-map-throws', label: 'fake', provider: 'fake', model: null,
      available: async () => true, listModels: async () => [],
      async ask() { throw new Error('adapter boom'); },
      async runAgent() { return { ok: false }; },
    });
    const { src, store, projectId } = await lumpedFixture('throws');
    const mgr = new SessionManager(store);
    const { session } = await mgr.open({ sourceRoot: src, name: 'throws' });
    await mgr.start(projectId, session.sessionId);

    const result = await runMapOrchestration({ store, mgr, projectId, sessionId: session.sessionId, sourceRoot: src, engine: 'fake-map-throws' });

    assert.equal(result.ok, true);
    assert.equal(result.features.length, 1); // never split
    assert.equal(result.consolidated, 0);
  });

  test('an unreadable sourceRoot is recorded as a phase error, session stays running (never crashed)', async () => {
    const store = new Store(path.join(tmpRoot, 'bad'));
    await fs.mkdir(path.join(tmpRoot, 'bad', 'proj'), { recursive: true });
    const project = await store.openProject({ sourceRoot: path.join(tmpRoot, 'bad', 'proj'), name: 'bad' });
    const mgr = new SessionManager(store);
    const { session } = await mgr.open({ sourceRoot: path.join(tmpRoot, 'bad', 'proj'), name: 'bad' });
    await mgr.start(project.id, session.sessionId);

    const result = await runMapOrchestration({
      store, mgr, projectId: project.id, sessionId: session.sessionId,
      sourceRoot: path.join(tmpRoot, 'bad', 'does-not-exist'), engine: 'rules',
    });

    assert.equal(result.ok, false);
    assert.ok(result.error);
    const final = await mgr.status(project.id, session.sessionId);
    assert.equal(final.phase.stage, 'error');
    assert.equal(final.status, 'running');
  });
});
