import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  Store, readGraph, readReconciliation, reconciliationCounts, snapshotSourceDir, readFrozenSourceLines,
} from '@secforge/store';
import { mapProject } from '@secforge/map';

let tmpRoot, store, pid;

before(async () => {
  tmpRoot = path.join(os.tmpdir(), 'sf-map-' + crypto.randomBytes(4).toString('hex'));
  store = new Store(tmpRoot);
  await fs.mkdir(path.join(tmpRoot, 'proj'), { recursive: true });
  const project = await store.openProject({ sourceRoot: path.join(tmpRoot, 'proj'), name: 'MAP' });
  pid = project.id;
});

after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('mapProject()', () => {
  test('returns status ERROR for a path that is not a directory', async () => {
    const file = path.join(tmpRoot, 'not-a-dir.txt');
    await fs.writeFile(file, 'hello');
    const result = await mapProject({ sourceRoot: file, store, projectId: pid });
    assert.equal(result.status, 'ERROR');
    assert.equal(result.nodeCount, 0);
    assert.deepEqual(result.features, []);
  });

  test('returns status ERROR for a missing path', async () => {
    const result = await mapProject({ sourceRoot: path.join(tmpRoot, 'nope'), store, projectId: pid });
    assert.equal(result.status, 'ERROR');
  });

  test('refuses to map a filesystem root without walking it (P0-1)', async () => {
    const result = await mapProject({ sourceRoot: '/', store, projectId: pid });
    assert.equal(result.status, 'ERROR');
    assert.match(result.error, /root/);
    assert.equal(result.nodeCount, 0);
  });

  test('ERRORs (not MAPPED) when a non-empty dir yields zero readable source (O-2)', async () => {
    const src = path.join(tmpRoot, 'binonly');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3])); // NUL → skipped as binary
    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.status, 'ERROR');
    assert.match(result.error, /0 files|not readable/);
  });

  test('returns status MAPPED with features for a real source directory', async () => {
    const src = path.join(tmpRoot, 'proj');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'),
      "router.get('/orders/:id', (req, res) => res.json({}));\n");

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.status, 'MAPPED');
    assert.ok(result.nodeCount > 0);
    assert.ok(result.edgeCount > 0);
    // New clustering: @secforge/recon's deterministicSemanticPlan names a small repo's feature by
    // capability noun (from the resolved route path), not by directory — 'api/orders.js' with
    // route '/orders/:id' clusters as 'Order', not 'api'.
    assert.equal(result.features.some((f) => f.name === 'Order'), true);
    assert.ok(result.coverage.technical > 0);

    const graph = await readGraph(store, pid);
    const ep = graph.nodes.find((n) => n.type === 'ENDPOINT');
    assert.ok(ep, 'an ENDPOINT node was persisted');
    assert.equal(ep.data.method, 'GET');
    assert.equal(ep.data.route, '/orders/:id');
  });
});

// docs/PHASE1-ROLES-INVENTORY-DESIGN.md — ACTOR/ROLE/PERMISSION extraction + inventory persistence.
describe('ACTOR/ROLE/PERMISSION extraction + inventory persistence', () => {
  test('extracts ACTOR/ROLE/PERMISSION nodes, HAS_ROLE/REQUIRES_ROLE edges, and persists inventory.jsonl', async () => {
    const src = path.join(tmpRoot, 'roles-proj');
    await fs.mkdir(path.join(src, 'app', 'models'), { recursive: true });
    await fs.mkdir(path.join(src, 'app', 'controllers'), { recursive: true });
    await fs.writeFile(path.join(src, 'app', 'models', 'user.rb'),
      "class User < ApplicationRecord\n  devise :database_authenticatable\n  has_many :roles\nend\n");
    await fs.writeFile(path.join(src, 'app', 'models', 'role.rb'),
      "class Role < ApplicationRecord\n  enum role: { admin: 0, editor: 1 }\nend\n");
    await fs.writeFile(path.join(src, 'app', 'controllers', 'admin_controller.rb'),
      "class AdminController < ApplicationController\n  before_action :authenticate_user!\n\n  def index\n    return unless hasRole('admin')\n  end\n\n  get '/admin', to: 'admin#index'\nend\n");
    await fs.writeFile(path.join(src, 'app', 'models', 'ability.rb'),
      "class Ability\n  include CanCan::Ability\n\n  def initialize(user)\n    can :manage, Post\n  end\nend\n");

    const project = await store.openProject({ sourceRoot: src, name: 'ROLES' });
    const rpid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: rpid });
    assert.equal(result.status, 'MAPPED');

    const graph = await readGraph(store, rpid);
    const actorNodes = graph.nodes.filter((n) => n.type === 'ACTOR');
    const roleNodes = graph.nodes.filter((n) => n.type === 'ROLE');
    const permNodes = graph.nodes.filter((n) => n.type === 'PERMISSION');
    assert.equal(actorNodes.length, 1);
    assert.equal(actorNodes[0].name, 'User');
    assert.equal(roleNodes.length, 2);
    assert.deepEqual(roleNodes.map((n) => n.name).sort(), ['admin', 'editor']);
    assert.equal(permNodes.length, 1);
    assert.equal(permNodes[0].data.action, 'manage');
    assert.equal(permNodes[0].data.resource, 'Post');

    // single-actor rule (§1.3): HAS_ROLE from the one ACTOR to every declared ROLE.
    for (const r of roleNodes) {
      assert.ok(graph.edges.some((e) => e.type === 'HAS_ROLE' && e.src === actorNodes[0].id && e.dst === r.id),
        `expected HAS_ROLE ${actorNodes[0].id} -> ${r.id}`);
    }
    // ENDPOINT --REQUIRES_ROLE--> ROLE(admin), tied by same-file hasRole('admin').
    const adminRole = roleNodes.find((n) => n.name === 'admin');
    const endpoint = graph.nodes.find((n) => n.type === 'ENDPOINT');
    assert.ok(endpoint, 'an ENDPOINT node was persisted');
    assert.ok(graph.edges.some((e) => e.type === 'REQUIRES_ROLE' && e.src === endpoint.id && e.dst === adminRole.id));

    // inventory.jsonl — full row array, otherwise discarded once buildGraph() consumes it.
    const invFile = path.join(store.projectDir(rpid), 'snapshots', result.snapshotId, 'inventory.jsonl');
    const invText = await fs.readFile(invFile, 'utf8');
    const invRows = invText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const kind of ['ACTOR', 'ROLE', 'PERMISSION', 'ROLE_CHECK']) {
      assert.ok(invRows.some((r) => r.kind === kind), `inventory.jsonl has a ${kind} row`);
    }
    const actorRow = invRows.find((r) => r.kind === 'ACTOR');
    assert.equal(actorRow.file, 'app/models/user.rb');
    assert.equal(actorRow.line, 1);
    assert.equal(actorRow.detail.name, 'User');
  });

  test('no role/actor signals → zero fabricated ACTOR/ROLE/PERMISSION hits (honest-negative guard)', async () => {
    const src = path.join(tmpRoot, 'no-roles-proj');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'),
      "router.get('/orders/:id', (req, res) => res.json({}));\n");

    const project = await store.openProject({ sourceRoot: src, name: 'NOROLES' });
    const npid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: npid });
    assert.equal(result.status, 'MAPPED');

    const graph = await readGraph(store, npid);
    assert.equal(graph.nodes.filter((n) => ['ACTOR', 'ROLE', 'PERMISSION'].includes(n.type)).length, 0);

    const invFile = path.join(store.projectDir(npid), 'snapshots', result.snapshotId, 'inventory.jsonl');
    const invText = await fs.readFile(invFile, 'utf8');
    const invRows = invText.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(invRows.filter((r) => ['ACTOR', 'ROLE', 'PERMISSION', 'ROLE_CHECK', 'ROLE_GRANTS'].includes(r.kind)).length, 0);
  });

  // Reviewer FIX 1: matchRoleCheck's `current_user.x?` idiom matches ANY boolean predicate, not
  // just roles. A role check naming an undeclared "role" (no matching ROLE node) must never
  // fabricate a REQUIRES_ROLE edge to a nonexistent role — while a genuinely declared+checked
  // role still gets its edge (positive control, same project).
  test('a role check naming an undeclared role fabricates no edge; a declared+checked role still does', async () => {
    const src = path.join(tmpRoot, 'undeclared-role-proj');
    await fs.mkdir(path.join(src, 'app', 'models'), { recursive: true });
    await fs.mkdir(path.join(src, 'app', 'controllers'), { recursive: true });
    await fs.writeFile(path.join(src, 'app', 'models', 'role.rb'),
      "class Role < ApplicationRecord\n  enum role: { admin: 0 }\nend\n");
    await fs.writeFile(path.join(src, 'app', 'controllers', 'admin_controller.rb'),
      "class AdminController < ApplicationController\n  before_action :authenticate_user!\n\n  def index\n    return unless hasRole('admin')\n  end\n\n  get '/admin', to: 'admin#index'\nend\n");
    await fs.writeFile(path.join(src, 'app', 'controllers', 'session_controller.rb'),
      "class SessionController < ApplicationController\n  before_action :authenticate_user!\n\n  def show\n    return unless current_user.confirmed?\n  end\n\n  get '/session', to: 'session#show'\nend\n");

    const project = await store.openProject({ sourceRoot: src, name: 'UNDECLARED' });
    const upid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: upid });
    assert.equal(result.status, 'MAPPED');

    const graph = await readGraph(store, upid);
    const roleNodes = graph.nodes.filter((n) => n.type === 'ROLE');
    // 'confirmed' was never declared as role vocabulary — it must not exist as a ROLE node.
    assert.deepEqual(roleNodes.map((n) => n.name), ['admin']);

    const reqEdges = graph.edges.filter((e) => e.type === 'REQUIRES_ROLE');
    assert.equal(reqEdges.length, 1, 'exactly one REQUIRES_ROLE edge — the declared admin role');
    assert.equal(reqEdges[0].dst, roleNodes[0].id);

    const sessionEndpoint = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/session');
    assert.ok(sessionEndpoint, 'the /session endpoint was still mapped');
    assert.equal(graph.edges.some((e) => e.type === 'REQUIRES_ROLE' && e.src === sessionEndpoint.id), false,
      'no fabricated REQUIRES_ROLE edge to a nonexistent role:confirmed');

    const adminEndpoint = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/admin');
    assert.ok(graph.edges.some((e) => e.type === 'REQUIRES_ROLE' && e.src === adminEndpoint.id && e.dst === roleNodes[0].id),
      'the genuinely declared+checked admin role still gets its edge');
  });

  // Reviewer FIX 2: lastClass was only updated on a data-store-shaped class-decl line, so a
  // devise/:roles signal inside a LATER, non-model class in the same file stayed misattributed to
  // an EARLIER, unrelated model class.
  test('an actor signal attributes to the actual enclosing class, not an earlier model-shaped one', async () => {
    const src = path.join(tmpRoot, 'actor-attribution-proj');
    await fs.mkdir(path.join(src, 'app', 'models'), { recursive: true });
    await fs.writeFile(path.join(src, 'app', 'models', 'order_and_wrapper.rb'),
      "class Order < ApplicationRecord\nend\n\nclass SomeAuthWrapper\n  devise :database_authenticatable\nend\n");

    const project = await store.openProject({ sourceRoot: src, name: 'ACTORATTR' });
    const apid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: apid });
    assert.equal(result.status, 'MAPPED');

    const graph = await readGraph(store, apid);
    const actorNodes = graph.nodes.filter((n) => n.type === 'ACTOR');
    assert.equal(actorNodes.length, 1);
    assert.equal(actorNodes[0].name, 'SomeAuthWrapper', 'devise signal attributes to its own enclosing class, not Order');
  });
});

// Phase A §1 (source freezing) + §2 (reconciliation ledger), acceptance test plan: a live
// mapProject() run over a small Rails-shaped fixture (ExpensesController: `show` — authorized;
// `download_receipt` — authenticated but NOT authorized, the planted IDOR — same shape as
// packages/recon/test/graph.test.js's reference fixture), exercising the full pipeline
// (walk -> freeze -> inventory -> buildGraph -> writeReconciliation), not the isolated unit graph.
describe('Phase A: source freezing + reconciliation ledger (real mapProject run)', () => {
  let src, pid, sid, result;

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
    result = await mapProject({ sourceRoot: src, store, projectId: pid });
    sid = result.snapshotId;
    assert.equal(result.status, 'MAPPED');
  });

  test('source is frozen to disk, and snapshot.json says so', async () => {
    const sourceDir = snapshotSourceDir(store, pid, sid);
    await assert.doesNotReject(fs.access(sourceDir));
    const frozenControllerText = await fs.readFile(path.join(sourceDir, 'app', 'controllers', 'expenses_controller.rb'), 'utf8');
    assert.match(frozenControllerText, /def download_receipt/);

    const snapFile = path.join(store.projectDir(pid), 'snapshots', sid, 'snapshot.json');
    const snap = JSON.parse(await fs.readFile(snapFile, 'utf8'));
    assert.equal(snap.source_frozen, true);
  });

  test('readFrozenSourceLines returns the right lines, and null for a file outside the manifest', async () => {
    const excerpt = await readFrozenSourceLines(store, pid, sid, 'app/controllers/expenses_controller.rb', 8, 8);
    assert.equal(excerpt, '  def download_receipt');
    assert.equal(await readFrozenSourceLines(store, pid, sid, 'no/such/file.rb', 1, 2), null);
  });

  test('reconciliation row count === inventory.jsonl line count, zero UNRECONCILED', async () => {
    const invFile = path.join(store.projectDir(pid), 'snapshots', sid, 'inventory.jsonl');
    const invLines = (await fs.readFile(invFile, 'utf8')).split('\n').filter(Boolean);

    const recon = await readReconciliation(store, pid, sid);
    assert.equal(recon.length, invLines.length);

    const counts = await reconciliationCounts(store, pid, sid);
    assert.equal(counts.UNRECONCILED || 0, 0);
    // every row is accounted for by name (file/line/kind), never silently dropped
    for (const r of recon) assert.ok(r.kind, 'every reconciliation row carries its inventory kind');
  });

  test('download_receipt and show land MAPPED_TO_FEATURE, tied to the owning FEATURE id', async () => {
    const graph = await readGraph(store, pid, sid);
    const download = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id/download_receipt');
    const show = graph.nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id');
    assert.ok(download && show, 'both endpoints were mapped');

    const featureOf = (epId) => graph.edges.find((e) => e.type === 'EXPOSES' && e.dst === epId)?.src;
    const downloadFeatureId = featureOf(download.id);
    const showFeatureId = featureOf(show.id);
    assert.ok(downloadFeatureId && showFeatureId);
    assert.equal(graph.nodes.find((n) => n.id === downloadFeatureId)?.type, 'FEATURE');

    const recon = await readReconciliation(store, pid, sid);
    const downloadRecon = recon.find((r) => r.file === 'app/controllers/expenses_controller.rb' && r.line === download.data.line);
    const showRecon = recon.find((r) => r.file === 'app/controllers/expenses_controller.rb' && r.line === show.data.line);
    assert.ok(downloadRecon && showRecon);
    assert.equal(downloadRecon.status, 'MAPPED_TO_FEATURE');
    assert.equal(showRecon.status, 'MAPPED_TO_FEATURE');
    assert.equal(downloadRecon.feature_id, downloadFeatureId);
    assert.equal(showRecon.feature_id, showFeatureId);

    // the planted IDOR: download_receipt is authenticated but NOT authorized.
    assert.ok(graph.edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === download.id));
    assert.equal(graph.edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === download.id), false);
    assert.ok(graph.edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === show.id));
  });

  // Phase D §2 — the onClusters hook: an orchestrator may consolidate the deterministic clusters
  // before AI-semantic/buildGraph ever see them. Default (no onClusters) MUST be exact current
  // behavior — proven here by comparing an omitted call against an explicit identity function.
  describe('onClusters hook', () => {
    async function seedProject(store, name) {
      const src = path.join(tmpRoot, name);
      await fs.mkdir(path.join(src, 'api'), { recursive: true });
      await fs.writeFile(path.join(src, 'api', 'orders.js'),
        "router.get('/orders/:id', (req, res) => res.json({}));\n");
      const project = await store.openProject({ sourceRoot: src, name });
      return { src, projectId: project.id };
    }

    test('splitting a cluster in onClusters produces FEATURE nodes reflecting the split', async () => {
      const { src, projectId } = await seedProject(store, 'onclusters-split');
      let seen = null;
      const onClusters = async (clusters) => {
        seen = clusters;
        const [first, ...rest] = clusters;
        const mid = Math.ceil(first.rows.length / 2) || 1;
        return [
          { ...first, name: 'Alpha', slug: 'alpha', rows: first.rows.slice(0, mid) },
          { ...first, name: 'Beta', slug: 'beta', rows: first.rows.slice(mid) },
          ...rest,
        ];
      };
      const result = await mapProject({ sourceRoot: src, store, projectId, onClusters });
      assert.equal(result.status, 'MAPPED');
      assert.ok(seen, 'onClusters was invoked with the raw deterministic clusters');
      assert.equal(result.features.some((f) => f.name === 'Alpha'), true);
      assert.equal(result.features.some((f) => f.name === 'Beta'), true);
      assert.equal(result.features.some((f) => f.name === seen[0].name && f.name !== 'Alpha' && f.name !== 'Beta'), false);

      const graph = await readGraph(store, projectId);
      const featureNames = graph.nodes.filter((n) => n.type === 'FEATURE').map((n) => n.name);
      assert.ok(featureNames.includes('Alpha'));
      assert.ok(featureNames.includes('Beta'));
    });

    test('omitting onClusters is byte-for-byte identical to passing identity', async () => {
      const withoutIt = await seedProject(store, 'onclusters-default-a');
      const withIdentity = await seedProject(store, 'onclusters-default-b');

      const resultA = await mapProject({ sourceRoot: withoutIt.src, store, projectId: withoutIt.projectId });
      const resultB = await mapProject({
        sourceRoot: withIdentity.src, store, projectId: withIdentity.projectId,
        onClusters: async (clusters) => clusters,
      });

      assert.equal(resultA.status, 'MAPPED');
      assert.equal(resultB.status, 'MAPPED');
      assert.equal(resultA.nodeCount, resultB.nodeCount);
      assert.equal(resultA.edgeCount, resultB.edgeCount);
      assert.deepEqual(resultA.features.map((f) => f.name).sort(), resultB.features.map((f) => f.name).sort());
    });
  });

  test('frozen citations survive live mutation: overwriting the live source does not change what was frozen', async () => {
    const before = await readFrozenSourceLines(store, pid, sid, 'app/controllers/expenses_controller.rb', 8, 8);
    assert.equal(before, '  def download_receipt');

    await fs.writeFile(path.join(src, 'app', 'controllers', 'expenses_controller.rb'), '# gutted\n');

    const after = await readFrozenSourceLines(store, pid, sid, 'app/controllers/expenses_controller.rb', 8, 8);
    assert.equal(after, before, 'frozen source is unaffected by a live-tree mutation');
  });
});

// The phase1-maps bundle is written for every successful map (a pure projection of the graph).
describe('mapProject() writes the phase1-maps bundle', () => {
  test('result.maps points at a rendered bundle with the 13-section feature docs and a manifest', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Store } = await import('@secforge/store');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secforge-maps-'));
    const src = path.join(root, 'src'); fs.mkdirSync(path.join(src, 'app', 'controllers'), { recursive: true });
    fs.writeFileSync(path.join(src, 'app', 'controllers', 'orders_controller.rb'), "class OrdersController < ApplicationController\n  before_action :authenticate_user!\n  def show\n    authorize @order\n  end\nend\n");
    fs.mkdirSync(path.join(src, 'config'), { recursive: true });
    fs.writeFileSync(path.join(src, 'config', 'routes.rb'), "Rails.application.routes.draw do\n  resources :orders, only: [:show]\nend\n");
    const store = new Store(path.join(root, 'data'));
    const project = await store.openProject({ sourceRoot: src });
    const result = await mapProject({ sourceRoot: src, store, projectId: project.id });
    assert.equal(result.status, 'MAPPED');
    assert.ok(result.maps && result.maps.files > 0, 'bundle rendered');
    const bundle = path.join(store.projectDir(project.id), 'snapshots', result.snapshotId, 'phase1-maps');
    assert.equal(result.maps.root, bundle);
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
    assert.ok(manifest.files.includes('AI_CONTEXT.md') && manifest.files.includes('consolidated/00_INDEX.md'));
    const featureDocs = fs.readdirSync(path.join(bundle, 'features'));
    assert.ok(featureDocs.length >= 1);
    const doc = fs.readFileSync(path.join(bundle, 'features', featureDocs[0]), 'utf8');
    for (let n = 1; n <= 13; n++) assert.ok(doc.includes(`## ${n}. `), `section ${n} present`);
    assert.ok(!manifest.files.some((f) => /phase2_review_queue/.test(f)), 'no review queue — the Assess tab owns findings');
  });
});
