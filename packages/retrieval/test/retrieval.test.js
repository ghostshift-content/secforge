import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges, readGraph } from '@secforge/store';
import { mapProject } from '@secforge/map';
import { getContextBundle, retrieveFeatureContext, search, answer, GROUNDING_PREAMBLE, buildFeedForward } from '../src/index.js';

let tmpRoot, store;

before(async () => { tmpRoot = path.join(os.tmpdir(), 'sf-retrieval-' + crypto.randomBytes(4).toString('hex')); store = new Store(tmpRoot); });
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

async function freshProject(name) {
  const sourceRoot = path.join(tmpRoot, name);
  await fs.mkdir(sourceRoot, { recursive: true });
  return store.openProject({ sourceRoot, name });
}

// ---- hand-built small graph (getContextBundle hit/miss, search scoring) --------------------
describe('getContextBundle', () => {
  let pid;
  const sid = 'snap-1';

  before(async () => {
    ({ id: pid } = await freshProject('bundle-proj'));
    await writeNodes(store, pid, [
      { id: 'feature:payment', type: 'FEATURE', name: 'Payment', data: { domain: 'core' }, claims: [{ file: 'src/payment.js', line: 1, method: 'grep', confidence: 'medium' }] },
      { id: 'file:src/payment.js', type: 'FILE', name: 'payment.js', data: {}, claims: [] },
    ], { snapshotId: sid });
    await writeEdges(store, pid, [{ id: 'e1', type: 'CONTAINS', src: 'feature:payment', dst: 'file:src/payment.js' }], { snapshotId: sid });
  });

  test('hit: returns node, neighbours, facts, citations', async () => {
    const bundle = await getContextBundle(store, pid, 'feature:payment', { snapshotId: sid });
    assert.equal(bundle.ok, true);
    assert.equal(bundle.node.id, 'feature:payment');
    assert.equal(bundle.neighbours.length, 1);
    assert.equal(bundle.neighbours[0].id, 'file:src/payment.js');
    assert.deepEqual(bundle.facts, ['Payment --CONTAINS--> payment.js']);
    // no frozen source dir exists for this hand-built snapshot — an honest null, never a guess
    assert.equal(bundle.citations.length, 1);
    assert.equal(bundle.citations[0].excerpt, null);
  });

  test('miss: unknown node id → coverage gap, never a throw or a guess', async () => {
    const bundle = await getContextBundle(store, pid, 'nonexistent:id', { snapshotId: sid });
    assert.deepEqual(bundle, { ok: false, reason: 'coverage gap: node not found', nodeId: 'nonexistent:id' });
  });
});

describe('search', () => {
  let pid;
  const sid = 'snap-1';

  before(async () => {
    ({ id: pid } = await freshProject('search-proj'));
    await writeNodes(store, pid, [
      { id: 'feature:payment', type: 'FEATURE', name: 'Payment', data: {}, claims: [{ file: 'src/payment.js', line: 1 }] },
      { id: 'file:src/payment.js', type: 'FILE', name: 'payment.js', data: {}, claims: [{ file: 'src/payment.js', line: 1 }] },
    ], { snapshotId: sid });
    await writeEdges(store, pid, [], { snapshotId: sid });
  });

  test('type-weighted scoring: FEATURE outranks FILE for the same matching term', async () => {
    const hits = await search(store, pid, 'payment', { snapshotId: sid });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].type, 'FEATURE');
    assert.equal(hits[1].type, 'FILE');
    assert.ok(hits[0].score > hits[1].score);
  });

  test('no match → empty array, never throws', async () => {
    assert.deepEqual(await search(store, pid, 'zzqvt kwyjibo florbnaxious', { snapshotId: sid }), []);
  });
});

// ---- regression: retrieveFeatureContext must not leak a sibling feature's endpoints ----------
// Two features sharing one SERVICE node (a blind multi-hop BFS from either feature would reach
// the OTHER feature's endpoint through that shared node) — each dossier must list only its OWN.
describe('retrieveFeatureContext — feature scoping (two features sharing a node)', () => {
  let pid;
  const sid = 'snap-1';

  before(async () => {
    ({ id: pid } = await freshProject('shared-node-proj'));
    await writeNodes(store, pid, [
      { id: 'feature:core', type: 'FEATURE', name: 'Core', data: {}, claims: [] },
      { id: 'feature:billing', type: 'FEATURE', name: 'Billing', data: {}, claims: [] },
      { id: 'endpoint:GET:/core', type: 'ENDPOINT', name: 'GET /core', data: { method: 'GET', route: '/core' }, claims: [] },
      { id: 'endpoint:GET:/billing', type: 'ENDPOINT', name: 'GET /billing', data: { method: 'GET', route: '/billing' }, claims: [] },
      { id: 'service:shared', type: 'SERVICE', name: 'SharedService', data: {}, claims: [] },
    ], { snapshotId: sid });
    await writeEdges(store, pid, [
      { id: 'e1', type: 'EXPOSES', src: 'feature:core', dst: 'endpoint:GET:/core' },
      { id: 'e2', type: 'EXPOSES', src: 'feature:billing', dst: 'endpoint:GET:/billing' },
      { id: 'e3', type: 'USES_SERVICE', src: 'feature:core', dst: 'service:shared' },
      { id: 'e4', type: 'USES_SERVICE', src: 'feature:billing', dst: 'service:shared' },
    ], { snapshotId: sid });
  });

  test('each feature dossier lists only its own endpoints, never the sibling reached via the shared service', async () => {
    const core = await retrieveFeatureContext(store, pid, 'feature:core', { snapshotId: sid });
    const billing = await retrieveFeatureContext(store, pid, 'feature:billing', { snapshotId: sid });

    assert.deepEqual(core.endpoints.map((e) => e.route), ['/core']);
    assert.deepEqual(billing.endpoints.map((e) => e.route), ['/billing']);
    assert.equal(core.services.length, 1);
    assert.equal(core.services[0].id, 'service:shared');
    assert.equal(billing.services.length, 1);
    assert.equal(billing.services[0].id, 'service:shared');
  });
});

// ---- real mapProject fixture (Rails-shaped ExpensesController, same shape as A1's reference --
// fixture: packages/recon/test/graph.test.js:136-167 / packages/map/test/map.test.js) ----------
describe('retrieveFeatureContext / answer — real mapProject fixture', () => {
  let src, pid, sid, expensesFeatureId;

  before(async () => {
    src = path.join(tmpRoot, 'expenses-proj');
    await fs.mkdir(path.join(src, 'app', 'controllers'), { recursive: true });
    await fs.mkdir(path.join(src, 'config'), { recursive: true });
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

    const project = await store.openProject({ sourceRoot: src, name: 'EXPENSES' });
    pid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    sid = result.snapshotId;
    assert.equal(result.status, 'MAPPED');
    expensesFeatureId = (await readGraph(store, pid, sid)).nodes.find((n) => n.type === 'FEATURE' && n.name === 'Expense').id;
  });

  test('[acceptance 1] full cited context: both endpoints, per-endpoint authn/authz, depth block', async () => {
    const ctx = await retrieveFeatureContext(store, pid, expensesFeatureId, { snapshotId: sid });
    assert.equal(ctx.ok, true);

    const show = ctx.endpoints.find((e) => e.route === '/expenses/:id');
    const download = ctx.endpoints.find((e) => e.route === '/expenses/:id/download_receipt');
    assert.ok(show && download);
    assert.equal(show.authz, true);
    assert.equal(download.authn, true);
    assert.equal(download.authz, false);

    const downloadCitation = ctx.citations.find((c) => c.node === download.id);
    assert.ok(downloadCitation, 'download_receipt has a real citation');
    assert.equal(downloadCitation.file, 'app/controllers/expenses_controller.rb');
    assert.ok(downloadCitation.excerpt, 'excerpt is non-null');
    assert.match(downloadCitation.excerpt, /download_receipt/);

    assert.ok(Number.isInteger(ctx.depth.maxChainLength));
    assert.ok(Number.isInteger(ctx.depth.memberCount));
    assert.equal(ctx.depth.endpointCount, ctx.endpoints.length);
    assert.ok(Number.isInteger(ctx.depth.filesTouched));
    assert.equal(typeof ctx.depth.capped, 'boolean');
  });

  test('[acceptance 1b] miss on a missing or wrong-type node → honest coverage gap', async () => {
    const miss = await retrieveFeatureContext(store, pid, 'feature:does-not-exist', { snapshotId: sid });
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /coverage gap/);

    const endpointId = (await readGraph(store, pid, sid)).nodes.find((n) => n.type === 'ENDPOINT').id;
    const wrongType = await retrieveFeatureContext(store, pid, endpointId, { snapshotId: sid });
    assert.equal(wrongType.ok, false, 'an existing but non-FEATURE node id must not be treated as a feature');
  });

  test('[acceptance 3] frozen citations survive live mutation of the source tree', async () => {
    const before1 = await retrieveFeatureContext(store, pid, expensesFeatureId, { snapshotId: sid });
    const download = before1.endpoints.find((e) => e.route === '/expenses/:id/download_receipt');
    const citationBefore = before1.citations.find((c) => c.node === download.id).excerpt;
    assert.match(citationBefore, /download_receipt/);

    await fs.writeFile(path.join(src, 'app', 'controllers', 'expenses_controller.rb'), '# gutted\n');

    const after1 = await retrieveFeatureContext(store, pid, expensesFeatureId, { snapshotId: sid });
    const citationAfter = after1.citations.find((c) => c.node === download.id).excerpt;
    assert.equal(citationAfter, citationBefore, 'excerpt is unchanged by a live-tree mutation — retrieval never reads live source');
  });

  test('[acceptance 4] answer("how does auth work in expenses"): cited facts that are all real graph edges', async () => {
    const graph = await readGraph(store, pid, sid);
    const nodeName = (id) => graph.nodes.find((n) => n.id === id)?.name || id;
    const realFacts = new Set(graph.edges.map((e) => `${nodeName(e.src)} --${e.type}--> ${nodeName(e.dst)}`));

    const res = await answer(store, pid, 'how does auth work in expenses', { snapshotId: sid });
    assert.equal(res.ok, true);
    assert.match(res.text, /AUTHENTICATED_BY|AUTHORIZED_BY/);
    assert.match(res.text, /`[^`]+:\d+`/); // at least one `file:line` citation line
    assert.ok(res.citations.length >= 1);

    const bundle = await getContextBundle(store, pid, res.node, { hops: 1, snapshotId: sid });
    assert.ok(bundle.facts.length > 0);
    for (const fact of bundle.facts) assert.ok(realFacts.has(fact), `fact "${fact}" must correspond to a real graph edge`);
  });

  test('[acceptance 5] answer() on a zero-hit query → coverage gap, no guessed answer', async () => {
    const res = await answer(store, pid, 'does this project involve quantum blockchain zzqvt kwyjibo florbnaxious', { snapshotId: sid });
    assert.deepEqual(res, { ok: false, coverageGap: true, text: res.text, citations: [] });
    assert.equal(res.coverageGap, true);
  });

  test('buildFeedForward wraps retrieveFeatureContext with the grounding preamble + timestamp', async () => {
    const ff = await buildFeedForward(store, pid, expensesFeatureId, { snapshotId: sid });
    assert.equal(ff.preamble, GROUNDING_PREAMBLE);
    assert.ok(ff.generatedAt);
    assert.equal(ff.ok, true);
    assert.ok(ff.endpoints.length >= 2);

    const missFf = await buildFeedForward(store, pid, 'feature:nope', { snapshotId: sid });
    assert.equal(missFf.ok, false);
    assert.match(missFf.reason, /coverage gap/);
  });
});
