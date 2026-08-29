// Self-check: maps a tiny synthetic fixture and asserts the graph engine actually produced and
// persisted something. Run with: node packages/map/src/demo.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@secforge/store';
import { readGraph } from '../../store/src/graph.js';
import { mapProject, featureGraph } from './index.js';

function writeFixture(root) {
  fs.mkdirSync(path.join(root, 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services'), { recursive: true });
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });

  fs.writeFileSync(path.join(root, 'routes', 'users.js'), [
    "import express from 'express';",
    'const router = express.Router();',
    "router.get('/users', (req, res) => {});",
    "router.post('/users', (req, res) => {});",
    'export default router;',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'services', 'userService.js'), [
    'class UserService {',
    '  findAll() {}',
    '}',
    'export default UserService;',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(root, 'jobs', 'emailWorker.js'), [
    'class EmailWorker {',
    '  run() {}',
    '}',
    "const UserModel = mongoose.model('User', schema);",
    'export default EmailWorker;',
    '',
  ].join('\n'));
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'secforge-map-demo-'));
  const sourceRoot = path.join(tmpRoot, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  writeFixture(sourceRoot);

  const store = new Store(path.join(tmpRoot, 'data'));
  const project = await store.openProject({ sourceRoot, name: 'demo' });

  const phases = [];
  const result = await mapProject({
    sourceRoot,
    store,
    projectId: project.id,
    onProgress: (p) => phases.push(p.phase),
  });

  assert.equal(result.status, 'MAPPED');
  assert.ok(result.features.length >= 3, `expected >=3 features, got ${result.features.length}`);
  assert.ok(result.nodeCount > 0, 'expected nodes');
  assert.ok(result.edgeCount > 0, 'expected edges');
  assert.ok(['snapshot', 'inventory', 'features', 'persist'].every((p) => phases.includes(p)));

  const persisted = await readGraph(store, project.id, result.snapshotId);
  assert.equal(persisted.nodes.length, result.nodeCount);
  assert.equal(persisted.edges.length, result.edgeCount);

  const endpointFeature = result.features.find((f) => f.counts.endpoints > 0);
  assert.ok(endpointFeature, 'expected a feature with an endpoint');
  const fg = await featureGraph(store, project.id, endpointFeature.id);
  assert.ok(fg.nodes.length > 0, 'expected featureGraph to return nodes');
  assert.ok(fg.nodes.some((n) => n.id === endpointFeature.id), 'expected feature node itself in its neighbourhood');

  console.log('OK');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
