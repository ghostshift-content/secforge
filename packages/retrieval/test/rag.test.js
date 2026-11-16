import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { buildChunks, writeRagIndex, locate, rankChunks, tokenize } from '../src/index.js';

let tmpRoot, store, pid;
const sid = 'snap-rag';

// Two features with the shapes the map engine emits (purpose text, routes with handler file:line,
// a bare Rails ROUTE sharing an ENDPOINT's handler, auth/role edges, a permission, a job).
const N = (id, type, name, data = {}, claims = []) => ({ id, type, name, data, claims });
const E = (type, src, dst) => ({ id: `e:${src}:${type}:${dst}`, type, src, dst });
const nodes = [
  N('feature:expenses', 'FEATURE', 'Expense submission & receipts', { purpose: 'Members submit expenses and download receipt files.' }),
  N('feature:teams', 'FEATURE', 'Team invitations', { purpose: 'Managers invite members to a team.' }),
  N('endpoint:GET:/expenses/:id/receipt', 'ENDPOINT', 'GET /expenses/:id/receipt', { method: 'GET', route: '/expenses/:id/receipt', file: 'app/controllers/expenses_controller.rb', line: 40, interface_kind: 'web' }, [{ file: 'app/controllers/expenses_controller.rb', line: 40 }]),
  N('route:expenses-receipt', 'ROUTE', 'action download_receipt', { file: 'app/controllers/expenses_controller.rb', line: 40, path: 'action download_receipt' }, [{ file: 'app/controllers/expenses_controller.rb', line: 40 }]),
  N('endpoint:POST:/teams/:id/invites', 'ENDPOINT', 'POST /teams/:id/invites', { method: 'POST', route: '/teams/:id/invites', file: 'app/controllers/invites_controller.rb', line: 12, interface_kind: 'rest' }, [{ file: 'app/controllers/invites_controller.rb', line: 12 }]),
  N('authcheck:login', 'AUTH_CHECK', 'authenticate_user!', { file: 'app/controllers/application_controller.rb', line: 3 }, [{ file: 'app/controllers/application_controller.rb', line: 3 }]),
  N('authcheck:invite-policy', 'AUTH_CHECK', 'InvitePolicy#create?', { file: 'app/policies/invite_policy.rb', line: 5 }, [{ file: 'app/policies/invite_policy.rb', line: 5 }]),
  N('role:manager', 'ROLE', 'Manager', { description: 'Approves expenses and manages team membership.' }),
  N('permission:invite-create', 'PERMISSION', 'invite:create', { description: 'Invite a member; requires manager.', resource: 'Invite', operation: 'create' }),
  N('job:receipt-scan', 'JOB', 'ReceiptScanJob', { file: 'app/jobs/receipt_scan_job.rb', line: 1 }, [{ file: 'app/jobs/receipt_scan_job.rb', line: 1 }]),
];
const edges = [
  E('EXPOSES', 'feature:expenses', 'endpoint:GET:/expenses/:id/receipt'),
  E('EXPOSES', 'feature:expenses', 'route:expenses-receipt'),
  E('HANDLED_BY', 'feature:expenses', 'job:receipt-scan'),
  E('EXPOSES', 'feature:teams', 'endpoint:POST:/teams/:id/invites'),
  E('AUTHENTICATED_BY', 'endpoint:GET:/expenses/:id/receipt', 'authcheck:login'),
  E('AUTHENTICATED_BY', 'endpoint:POST:/teams/:id/invites', 'authcheck:login'),
  E('AUTHORIZED_BY', 'endpoint:POST:/teams/:id/invites', 'authcheck:invite-policy'),
  E('REQUIRES_ROLE', 'endpoint:POST:/teams/:id/invites', 'role:manager'),
  E('AUTHORIZED_BY', 'feature:teams', 'permission:invite-create'),
  E('REQUIRES_ROLE', 'permission:invite-create', 'role:manager'),
];

before(async () => {
  tmpRoot = path.join(os.tmpdir(), 'sf-rag-' + crypto.randomBytes(4).toString('hex'));
  store = new Store(tmpRoot);
  const sourceRoot = path.join(tmpRoot, 'src'); await fs.mkdir(sourceRoot, { recursive: true });
  ({ id: pid } = await store.openProject({ sourceRoot, name: 'rag-proj' }));
  await writeNodes(store, pid, nodes, { snapshotId: sid });
  await writeEdges(store, pid, edges, { snapshotId: sid });
});
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('tokenize / stem', () => {
  test('asking words drop out; inflections meet in the middle', () => {
    assert.deepEqual(tokenize('test the receipt downloads'), ['receipt', 'download']);
    assert.equal(tokenize('approving')[0], tokenize('approval')[0]);
    assert.equal(tokenize('expenses')[0], tokenize('expense')[0]);
    assert.equal(tokenize('downloadReceipt').join(' '), 'download receipt');
  });
});

describe('buildChunks', () => {
  const chunks = buildChunks({ nodes, edges });
  test('one chunk per feature/entry/job/role/permission/auth; the duplicate ROUTE folds into its ENDPOINT', () => {
    const kinds = chunks.reduce((m, c) => ((m[c.kind] = (m[c.kind] || 0) + 1), m), {});
    assert.deepEqual(kinds, { feature: 2, endpoint: 2, job: 1, auth: 2, role: 1, permission: 1 });
    assert.ok(!chunks.some((c) => c.node === 'route:expenses-receipt'));
  });
  test('an endpoint chunk carries where-to-look pointers, its feature and its access facts', () => {
    const c = chunks.find((c) => c.node === 'endpoint:POST:/teams/:id/invites');
    assert.equal(c.feature, 'feature:teams');
    assert.equal(c.title, 'POST /teams/:id/invites');
    assert.deepEqual(c.where.files, ['app/controllers/invites_controller.rb:12', 'app/controllers/application_controller.rb:3', 'app/policies/invite_policy.rb:5']);
    assert.deepEqual(c.meta, { method: 'POST', route: '/teams/:id/invites', interface: 'rest', authn: true, authz: true, roles: ['Manager'], guards: ['authenticate_user!', 'InvitePolicy#create?'] });
  });
  test('an unguarded endpoint is findable by the words a tester uses for the gap', () => {
    const { hits } = rankChunks(chunks, 'no authorization check');
    assert.equal(hits[0].node, 'endpoint:GET:/expenses/:id/receipt');
  });
});

describe('locate', () => {
  test('falls back to the graph when no rag/ store was written, then reads the written store', async () => {
    const fromGraph = await locate(store, pid, 'download a receipt', { snapshotId: sid });
    assert.equal(fromGraph.source, 'graph');
    assert.equal(fromGraph.ok, true);
    assert.equal(fromGraph.features[0].id, 'feature:expenses');
    assert.equal(fromGraph.endpoints[0].id, 'endpoint:GET:/expenses/:id/receipt');
    assert.ok(fromGraph.files.some((f) => f.file === 'app/controllers/expenses_controller.rb:40'));

    const snapshotDir = path.join(store.projectDir(pid), 'snapshots', sid);
    const w = writeRagIndex(snapshotDir, { nodes, edges }, { snapshotId: sid });
    assert.equal(w.chunks, 9);
    assert.ok(fsSync.existsSync(path.join(snapshotDir, 'rag', 'chunks.jsonl')));
    assert.equal(JSON.parse(fsSync.readFileSync(path.join(snapshotDir, 'rag', 'index.json'), 'utf8')).chunks, 9);

    const fromRag = await locate(store, pid, 'invite a team member', { snapshotId: sid });
    assert.equal(fromRag.source, 'rag');
    assert.equal(fromRag.features[0].id, 'feature:teams');
    assert.equal(fromRag.endpoints[0].id, 'endpoint:POST:/teams/:id/invites');
    assert.deepEqual(fromRag.endpoints[0].roles, ['Manager']);
  });
  test('a role or permission word also lands on the right feature', async () => {
    const r = await locate(store, pid, 'what can a manager do', { snapshotId: sid });
    assert.equal(r.ok, true);
    assert.ok(r.features.some((f) => f.id === 'feature:teams'));
  });
  test('nothing matches → coverage gap, never a guess', async () => {
    const r = await locate(store, pid, 'zzqvt kwyjibo', { snapshotId: sid });
    assert.deepEqual([r.ok, r.coverageGap, r.features, r.endpoints], [false, true, [], []]);
  });
});
