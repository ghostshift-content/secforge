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

  test('returns status MAPPED with features for a real source directory', async () => {
    const src = path.join(tmpRoot, 'proj');
    await fs.mkdir(path.join(src, 'api'), { recursive: true });
    await fs.writeFile(path.join(src, 'api', 'orders.js'),
      "router.get('/orders/:id', (req, res) => res.json({}));\n");

    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    assert.equal(result.status, 'MAPPED');
    assert.ok(result.nodeCount > 0);
    assert.ok(result.edgeCount > 0);
    assert.equal(result.features.some((f) => f.name === 'api'), true);
    assert.ok(result.coverage.technical > 0);

    const graph = await readGraph(store, pid);
    const ep = graph.nodes.find((n) => n.type === 'ENDPOINT');
    assert.ok(ep, 'an ENDPOINT node was persisted');
    assert.equal(ep.data.method, 'GET');
    assert.equal(ep.data.route, '/orders/:id');
  });
});
