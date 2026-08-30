import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, readGraph } from '@secforge/store';
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
