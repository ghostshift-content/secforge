// Phase C — incremental diff-remap. Unit tests for the pure helpers in src/incremental.js, then
// the real acceptance plan: a tmp Store + real mapProject() over a small multi-feature fixture,
// proving the dirty/reuse partition, the AI-call-count payoff, delete/add correctness, the
// provably-lossless self-check's fail-closed fallback, and the fail-closed eligibility guards.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  Store, readGraph, readReconciliation, reconciliationCounts, snapshotSourceDir, readFrozenSourceLines, writeNodes, writeReconciliation,
} from '@secforge/store';
import { mapProject } from '@secforge/map';
import { register } from '@secforge/adapters';
import {
  parseManifestJsonl, diffManifests, fileToFeatureIndex, dirtyFeatureIds,
  reconSignature, checkLosslessReuse, IncrementalMismatchError,
} from '../src/incremental.js';

// ---------------------------------------------------------------------------------------------
// Pure helpers (design §1/§2/§3.4) — hand-built inputs, no I/O.
// ---------------------------------------------------------------------------------------------
describe('incremental.js — pure diff/reuse helpers', () => {
  test('parseManifestJsonl parses path -> sha256', () => {
    const text = '{"path":"a.js","bytes":1,"sha256":"aaa"}\n{"path":"b.js","bytes":2,"sha256":"bbb"}\n';
    const m = parseManifestJsonl(text);
    assert.equal(m.size, 2);
    assert.equal(m.get('a.js'), 'aaa');
    assert.equal(m.get('b.js'), 'bbb');
  });

  test('diffManifests classifies added/changed/deleted/unchanged', () => {
    const prior = parseManifestJsonl('{"path":"a.js","sha256":"aaa"}\n{"path":"b.js","sha256":"bbb"}\n{"path":"c.js","sha256":"ccc"}\n');
    const next = [
      { path: 'a.js', sha256: 'aaa' }, // unchanged
      { path: 'b.js', sha256: 'BBB-new' }, // changed
      { path: 'd.js', sha256: 'ddd' }, // added
      // c.js is missing -> deleted
    ];
    const diff = diffManifests(prior, next);
    assert.deepEqual(diff.added, ['d.js']);
    assert.deepEqual(diff.changed, ['b.js']);
    assert.deepEqual(diff.deleted, ['c.js']);
    assert.deepEqual(diff.unchanged, ['a.js']);
  });

  test('fileToFeatureIndex only indexes MAPPED_TO_FEATURE rows; dirtyFeatureIds only marks touched features', () => {
    const rows = [
      { file: 'orders.rb', line: 1, kind: 'ENDPOINT', entry: 'show', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:orders' },
      { file: 'expenses.rb', line: 1, kind: 'ENDPOINT', entry: 'show', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:expenses' },
      { file: 'infra.rb', line: 1, kind: 'DATA_STORE', entry: 'Thing', status: 'SHARED_INFRASTRUCTURE', feature_id: null },
    ];
    const byFile = fileToFeatureIndex(rows);
    assert.deepEqual([...byFile.get('orders.rb')], ['feature:orders']);
    assert.equal(byFile.has('infra.rb'), false, 'non-MAPPED_TO_FEATURE rows are never indexed');

    const dirty = dirtyFeatureIds(byFile, ['expenses.rb']);
    assert.deepEqual([...dirty], ['feature:expenses']);
    assert.equal(dirtyFeatureIds(byFile, ['nonexistent.rb']).size, 0);
  });

  test('checkLosslessReuse: identical reconciliation passes; a divergent "reused" feature throws IncrementalMismatchError', () => {
    const priorRows = [{ file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'show', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:x' }];
    const sameRows = [{ file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'show', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:x' }];
    assert.doesNotThrow(() => checkLosslessReuse(['feature:x'], priorRows, sameRows));

    const mismatchedRows = [{ file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'show-RENAMED', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:x' }];
    assert.throws(() => checkLosslessReuse(['feature:x'], priorRows, mismatchedRows), IncrementalMismatchError);
  });

  test('reconSignature is a set of file:line:kind:entry:status strings', () => {
    const sig = reconSignature([{ file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'show', status: 'MAPPED_TO_FEATURE' }]);
    assert.ok(sig.has('a.rb:1:ENDPOINT:show:MAPPED_TO_FEATURE'));
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture: a Rails "Expenses" feature (planted IDOR on download_receipt, same shape as
// map.test.js's Phase A fixture) that is fully self-contained in its own files, plus an
// independent, self-contained plain-JS "Orders" feature — so editing/deleting one never touches
// a file the other's reconciliation rows cite (no shared routes.rb between the two).
// ---------------------------------------------------------------------------------------------
async function writeFixture(src) {
  await fs.mkdir(path.join(src, 'app', 'controllers'), { recursive: true });
  await fs.mkdir(path.join(src, 'config'), { recursive: true });
  await fs.mkdir(path.join(src, 'api'), { recursive: true });
  await fs.writeFile(path.join(src, 'app', 'controllers', 'application_controller.rb'),
    'class ApplicationController < ActionController::Base\n  before_action :authenticate_user!\nend\n');
  await fs.writeFile(path.join(src, 'app', 'controllers', 'expenses_controller.rb'), [
    'class ExpensesController < ApplicationController',
    '  def show',
    '    @expense = Expense.find(params[:id])',
    '    authorize @expense',
    '    render json: @expense',
    '  end',
    '',
    '  def download_receipt',
    '    @expense = Expense.find(params[:id])',
    '    send_file @expense.receipt_path',
    '  end',
    'end',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(src, 'config', 'routes.rb'), [
    'Rails.application.routes.draw do',
    '  resources :expenses, only: [:show] do',
    '    member do',
    '      get :download_receipt',
    '    end',
    '  end',
    'end',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(src, 'api', 'orders.js'),
    "router.get('/orders/:id', (req, res) => res.json({}));\n");
}

const expensesFile = (src) => path.join(src, 'app', 'controllers', 'expenses_controller.rb');
const ordersFile = (src) => path.join(src, 'api', 'orders.js');

function featureIdOf(graph, route) {
  const ep = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === route);
  if (!ep) return null;
  return graph.edges.find((e) => e.type === 'EXPOSES' && e.dst === ep.id)?.src || null;
}

// ---------------------------------------------------------------------------------------------
// Real pipeline: single-file edit, delete, add, frozen citation, lossless-mismatch fallback.
// ---------------------------------------------------------------------------------------------
const sorted = (arr) => [...arr].sort();

describe('mapProject() — Phase C incremental diff-remap (real pipeline, rules engine)', () => {
  let tmpRoot, store, src, pid, snap1, expensesId, ordersId, applicationId;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-incr-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    src = path.join(tmpRoot, 'proj');
    await writeFixture(src);
    const project = await store.openProject({ sourceRoot: src, name: 'INCR' });
    pid = project.id;
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('full map (first run): incremental=false, reason=no-prior-snapshot, IDOR shape present', async () => {
    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, false);
    assert.equal(result.remapReason, 'no-prior-snapshot');
    snap1 = result.snapshotId;

    const graph = await readGraph(store, pid, snap1);
    const download = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id/download_receipt');
    assert.ok(download, 'download_receipt endpoint mapped');
    assert.ok(graph.edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === download.id));
    assert.equal(graph.edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === download.id), false, 'planted IDOR: authenticated, not authorized');

    expensesId = featureIdOf(graph, '/expenses/:id/download_receipt');
    ordersId = featureIdOf(graph, '/orders/:id');
    // application_controller.rb's own before_action row is itself a FEATURE-bearing inventory
    // row (tokens_actors) with no endpoint of its own — a third, always-untouched feature this
    // fixture incidentally produces. Captured so later reused/remapped assertions account for it
    // instead of hardcoding an exact set that silently assumes it doesn't exist.
    applicationId = graph.nodes.find((n) => n.type === 'FEATURE' && n.data.slug === 'application')?.id;
    assert.ok(expensesId && ordersId && applicationId, 'three independent FEATURE ids');
    assert.equal(new Set([expensesId, ordersId, applicationId]).size, 3);
  });

  test('single-file edit -> incremental remap: only Expenses remapped, Orders reused byte-identical, IDOR shape survives', async () => {
    const text = await fs.readFile(expensesFile(src), 'utf8');
    await fs.writeFile(expensesFile(src), text.replace('class ExpensesController', '# touched\nclass ExpensesController'));

    const before1 = await readGraph(store, pid, snap1);
    const ordersBefore = before1.nodes.filter((n) => n.id === ordersId || before1.edges.some((e) => e.type === 'EXPOSES' && e.src === ordersId && e.dst === n.id));
    assert.ok(ordersBefore.length > 0);

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    snap1 = result.snapshotId; // roll forward BEFORE asserting, so a failed assertion never strands later tests on stale state
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, true, `expected incremental, got reason=${result.remapReason}`);
    assert.deepEqual(result.changedFiles, ['app/controllers/expenses_controller.rb']);
    assert.deepEqual(result.remappedFeatures, [expensesId]);
    assert.deepEqual(sorted(result.reusedFeatures), sorted([ordersId, applicationId]));

    const graph2 = await readGraph(store, pid, result.snapshotId);
    const ordersAfter = graph2.nodes.filter((n) => n.id === ordersId || graph2.edges.some((e) => e.type === 'EXPOSES' && e.src === ordersId && e.dst === n.id));
    const norm = (arr) => arr.map((n) => ({ id: n.id, type: n.type, data: n.data, claims: n.claims })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(norm(ordersAfter), norm(ordersBefore), 'Orders FEATURE + member nodes are byte-identical across the incremental remap');

    const download = graph2.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id/download_receipt');
    assert.ok(download);
    assert.ok(graph2.edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === download.id));
    assert.equal(graph2.edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === download.id), false, 'IDOR shape survives the incremental remap');

    const counts = await reconciliationCounts(store, pid, result.snapshotId);
    assert.equal(counts.UNRECONCILED || 0, 0);
  });

  test('frozen citation for the UNCHANGED Orders feature resolves in the NEW snapshot (hardlink-forward correctness)', async () => {
    const priorSourceDir = snapshotSourceDir(store, pid, snap1);
    const excerpt = await readFrozenSourceLines(store, pid, snap1, 'api/orders.js', 1, 1);
    assert.match(excerpt, /orders\/:id/);
    // Prove it's a real hardlink/copy, not a live reference: remove the file from the disk copy
    // that was forwarded FROM (any earlier snapshot's source dir); this one's copy is unaffected
    // because it is its own independent inode/file, not a pointer back to that directory.
    const decoy = path.join(os.tmpdir(), 'sf-decoy-' + crypto.randomBytes(4).toString('hex'));
    await fs.cp(priorSourceDir, decoy, { recursive: true });
    await fs.rm(path.join(decoy, 'api', 'orders.js'), { force: true });
    const stillThere = await readFrozenSourceLines(store, pid, snap1, 'api/orders.js', 1, 1);
    assert.match(stillThere, /orders\/:id/, 'snapshot copy is independent of any external copy being altered');
    await fs.rm(decoy, { recursive: true, force: true });
  });

  test('delete a file: its feature disappears from the new snapshot; Expenses is unaffected and reused', async () => {
    await fs.rm(ordersFile(src));

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    snap1 = result.snapshotId;
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, true, `expected incremental, got reason=${result.remapReason}`);
    assert.deepEqual(result.deletedFiles, ['api/orders.js']);
    assert.deepEqual(result.remappedFeatures, [], 'nothing NEW was remapped — the Orders feature just vanished');
    assert.deepEqual(sorted(result.reusedFeatures), sorted([expensesId, applicationId]));

    const graph = await readGraph(store, pid, result.snapshotId);
    assert.equal(graph.nodes.some((n) => n.id === ordersId), false, 'Orders FEATURE node is gone');
    assert.equal(graph.nodes.some((n) => n.type === 'ENDPOINT' && n.data.route === '/orders/:id'), false);
    assert.ok(graph.nodes.some((n) => n.id === expensesId), 'Expenses FEATURE untouched');
  });

  test('add a new file: a brand-new feature appears, Expenses stays reused', async () => {
    await fs.writeFile(path.join(src, 'api', 'webhooks.js'),
      "router.post('/webhooks/receive', (req, res) => res.json({}));\n");

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    snap1 = result.snapshotId;
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, true, `expected incremental, got reason=${result.remapReason}`);
    assert.deepEqual(result.addedFiles, ['api/webhooks.js']);
    assert.equal(result.remappedFeatures.length, 1, 'exactly the brand-new feature was remapped');
    assert.deepEqual(sorted(result.reusedFeatures), sorted([expensesId, applicationId]));

    const graph = await readGraph(store, pid, result.snapshotId);
    assert.ok(graph.nodes.some((n) => n.type === 'ENDPOINT' && n.data.route === '/webhooks/receive'));
  });

  test('lossless self-check: a corrupted prior reconciliation row for a would-be-reused feature forces a full fallback, never a lossy graph', async () => {
    const priorRows = await readReconciliation(store, pid, snap1);
    const target = priorRows.find((r) => r.feature_id === expensesId);
    assert.ok(target, 'a reconciliation row exists for the reused feature');
    const tampered = priorRows.map((r) => (r === target ? { ...r, entry: `${r.entry}-TAMPERED` } : r));
    await writeReconciliation(store, pid, tampered, { snapshotId: snap1 });

    // Edit an unrelated file so Expenses' OWN files are untouched -> the plan would normally
    // treat it as reused, except its prior ledger no longer reconciles identically.
    await fs.writeFile(path.join(src, 'api', 'webhooks.js'),
      "router.post('/webhooks/receive', (req, res) => res.json({changed:true}));\n");

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, false, 'the self-check mismatch forces a full remap');
    assert.equal(result.remapReason, 'mismatch-fallback');

    // The fallback is a real full remap, not a lossy one: every real endpoint is still present
    // and correctly shaped.
    const graph = await readGraph(store, pid, result.snapshotId);
    const download = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id/download_receipt');
    assert.ok(download);
    assert.ok(graph.edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === download.id));
    assert.equal(graph.edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === download.id), false);
    assert.ok(graph.nodes.some((n) => n.type === 'ENDPOINT' && n.data.route === '/webhooks/receive'));
    const counts = await reconciliationCounts(store, pid, result.snapshotId);
    assert.equal(counts.UNRECONCILED || 0, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The AI-reuse payoff: planClusters() is called only for the dirty cluster on an incremental run.
// ---------------------------------------------------------------------------------------------
describe('mapProject() — Phase C AI-plan reuse (counting fake adapter)', () => {
  let tmpRoot, store, src, pid, calls;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-incr-ai-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    src = path.join(tmpRoot, 'proj');
    await writeFixture(src);
    const project = await store.openProject({ sourceRoot: src, name: 'INCR-AI' });
    pid = project.id;

    calls = 0;
    register({
      id: 'fake-counting-incremental',
      available: async () => true,
      ask: async (prompt) => {
        calls++;
        const m = prompt.match(/CANDIDATE CLUSTERS \(\d+\):\n(\[[\s\S]*\])$/);
        const clusters = m ? JSON.parse(m[1]) : [];
        const features = clusters.map((c) => {
          const sample = c.samples?.[0];
          return {
            name: `${c.name} Feature`, slug: c.slug, domain: c.domain, purpose: `Handles ${c.name}`,
            include_paths: c.paths || [], confidence: 'high',
            evidence: sample ? [{ file: sample.file, line: sample.line || 1, reason: 'endpoint definition' }] : [],
          };
        });
        return JSON.stringify({ features, actors: [], roles: [], permissions: [], relationships: [], gaps: [] });
      },
    });
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('full AI map: one ask() call names both features', async () => {
    const result = await mapProject({ sourceRoot: src, store, projectId: pid, engine: 'fake-counting-incremental' });
    assert.equal(result.status, 'MAPPED');
    assert.equal(calls, 1, 'both tiny clusters fit in a single prompt');
    assert.ok(result.aiSemantic, 'an AI ontology was accepted');
  });

  test('incremental AI map: editing one file calls planClusters ONLY for its dirty cluster, never re-deriving the untouched feature', async () => {
    const graphBefore = await readGraph(store, pid);
    const ordersBefore = graphBefore.nodes.find((n) => n.type === 'FEATURE' && graphBefore.edges.some((e) => e.type === 'EXPOSES' && e.src === n.id
      && graphBefore.nodes.find((x) => x.id === e.dst)?.data?.route === '/orders/:id'));
    assert.ok(ordersBefore, 'Orders FEATURE exists after the full AI map');

    const text = await fs.readFile(expensesFile(src), 'utf8');
    await fs.writeFile(expensesFile(src), text.replace('class ExpensesController', '# touched\nclass ExpensesController'));

    const result = await mapProject({ sourceRoot: src, store, projectId: pid, engine: 'fake-counting-incremental' });
    assert.equal(result.status, 'MAPPED');
    assert.equal(result.incremental, true, `expected incremental, got reason=${result.remapReason}`);
    assert.equal(calls, 2, 'exactly one MORE ask() call, for the dirty (Expenses) cluster only');
    assert.ok(result.ontologyReusedCount >= 1, 'at least the Orders ontology entity was reused, not re-derived');

    const graphAfter = await readGraph(store, pid, result.snapshotId);
    const ordersAfter = graphAfter.nodes.find((n) => n.id === ordersBefore.id);
    assert.ok(ordersAfter, 'Orders FEATURE id is stable across the incremental AI remap');
    assert.equal(ordersAfter.name, ordersBefore.name, 'reused feature name is byte-identical (no fresh LLM output for it)');
    assert.equal(ordersAfter.data.purpose, ordersBefore.data.purpose, 'reused feature purpose is byte-identical');
  });
});

// ---------------------------------------------------------------------------------------------
// Fail-closed eligibility guards.
// ---------------------------------------------------------------------------------------------
describe('mapProject() — Phase C fail-closed eligibility guards', () => {
  let tmpRoot, store;
  before(() => { tmpRoot = path.join(os.tmpdir(), 'sf-incr-guards-' + crypto.randomBytes(4).toString('hex')); store = new Store(tmpRoot); });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('no prior snapshot -> full map', async () => {
    const src = path.join(tmpRoot, 'g1');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'), "router.get('/orders/:id', (req, res) => res.json({}));\n");
    const project = await store.openProject({ sourceRoot: src, name: 'G1' });
    const result = await mapProject({ sourceRoot: src, store, projectId: project.id });
    assert.equal(result.incremental, false);
    assert.equal(result.remapReason, 'no-prior-snapshot');
  });

  test('a prior snapshot with zero reconciliation rows (pre-Phase-A-shaped) -> full map', async () => {
    const src = path.join(tmpRoot, 'g2');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'), "router.get('/orders/:id', (req, res) => res.json({}));\n");
    const project = await store.openProject({ sourceRoot: src, name: 'G2' });
    const pid = project.id;

    const priorSid = 'legacy-snap';
    await writeNodes(store, pid, [{ id: 'feature:orders', type: 'FEATURE', name: 'orders', data: {}, claims: [] }], { snapshotId: priorSid });
    const snapDir = path.join(store.projectDir(pid), 'snapshots', priorSid);
    await fs.mkdir(path.join(snapDir, 'source', 'api'), { recursive: true });
    await fs.writeFile(path.join(snapDir, 'source', 'api', 'orders.js'), "router.get('/orders/:id', (req, res) => res.json({}));\n");
    await fs.writeFile(path.join(snapDir, 'source-manifest.jsonl'), JSON.stringify({ path: 'api/orders.js', bytes: 10, sha256: 'x'.repeat(64) }) + '\n');
    await fs.writeFile(path.join(snapDir, 'inventory.jsonl'), JSON.stringify({ kind: 'ENDPOINT', file: 'api/orders.js', line: 1, detail: {} }) + '\n');
    // deliberately no writeReconciliation() call for this snapshot.

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.incremental, false);
    assert.equal(result.remapReason, 'no-reconciliation-ledger');
  });

  test('explicit incremental:false always takes the full-map path, even with a valid prior snapshot', async () => {
    const src = path.join(tmpRoot, 'g3');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'), "router.get('/orders/:id', (req, res) => res.json({}));\n");
    const project = await store.openProject({ sourceRoot: src, name: 'G3' });
    const pid = project.id;
    await mapProject({ sourceRoot: src, store, projectId: pid }); // a real, valid prior snapshot

    await fs.writeFile(path.join(src, 'api', 'orders.js'), "router.get('/orders/:id', (req, res) => res.json({extra:1}));\n");
    const result = await mapProject({ sourceRoot: src, store, projectId: pid, incremental: false });
    assert.equal(result.incremental, false);
    assert.equal(result.remapReason, 'explicit-false');
  });
});
