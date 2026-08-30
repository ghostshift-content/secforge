import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '@secforge/store';
import { writeNodes, writeEdges, readGraph, neighbourhood, writeReconciliation, readReconciliation, reconciliationCounts } from '../src/graph.js';

let tmpRoot;
let store;

tmpRoot = path.join(os.tmpdir(), 'sf-graph-test-' + crypto.randomBytes(4).toString('hex'));
store = new Store(tmpRoot);

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Each test gets its own source dir -> its own projectId -> its own index.sqlite, so tests never
// share cached DatabaseSync state.
async function freshProject(name) {
  const sourceRoot = path.join(tmpRoot, name);
  await fs.mkdir(sourceRoot, { recursive: true });
  return store.openProject({ sourceRoot, name });
}

const n = (id, extra = {}) => ({ id, type: 'FILE', name: id, data: {}, claims: [], ...extra });
const e = (id, src, dst, extra = {}) => ({ id, type: 'CONTAINS', src, dst, ...extra });

describe('graph: round-trip', () => {
  test('nodes + edges round-trip exactly, edges with no data key stay bare', async () => {
    const { id: pid } = await freshProject('rt');
    const sid = 'snap-1';
    const nodes = [n('a'), n('b')];
    const edges = [e('e1', 'a', 'b')];
    await writeNodes(store, pid, nodes, { snapshotId: sid });
    await writeEdges(store, pid, edges, { snapshotId: sid });

    const graph = await readGraph(store, pid, sid);
    assert.deepEqual(graph.nodes, nodes);
    assert.deepEqual(graph.edges, [{ id: 'e1', type: 'CONTAINS', src: 'a', dst: 'b' }]);
    assert.equal('data' in graph.edges[0], false);
  });
});

describe('graph: idempotent re-write', () => {
  test('writing the same snapshot twice does not duplicate rows', async () => {
    const { id: pid } = await freshProject('idem');
    const sid = 'snap-1';
    const nodes = [n('a'), n('b')];
    await writeNodes(store, pid, nodes, { snapshotId: sid });
    await writeNodes(store, pid, nodes, { snapshotId: sid });

    const graph = await readGraph(store, pid, sid);
    assert.equal(graph.nodes.length, 2);
    assert.deepEqual(graph.nodes, nodes);
  });
});

describe('graph: replace shrinks the set', () => {
  test('write 5 nodes then write 3 -> readGraph returns exactly 3', async () => {
    const { id: pid } = await freshProject('shrink');
    const sid = 'snap-1';
    const five = ['a', 'b', 'c', 'd', 'f'].map((x) => n(x));
    await writeNodes(store, pid, five, { snapshotId: sid });
    assert.equal((await readGraph(store, pid, sid)).nodes.length, 5);

    const three = ['a', 'b', 'c'].map((x) => n(x));
    await writeNodes(store, pid, three, { snapshotId: sid });
    const graph = await readGraph(store, pid, sid);
    assert.equal(graph.nodes.length, 3);
    assert.deepEqual(graph.nodes.map((x) => x.id).sort(), ['a', 'b', 'c']);
  });
});

describe('graph: current-snapshot fallback', () => {
  test('writeNodes/readGraph without snapshotId use whatever was last set current', async () => {
    const { id: pid } = await freshProject('current');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a')], { snapshotId: sid });
    // no snapshotId given -> resolves to current (sid), and stays there
    await writeNodes(store, pid, [n('a'), n('b')]);
    const graph = await readGraph(store, pid);
    assert.deepEqual(graph.nodes.map((x) => x.id).sort(), ['a', 'b']);
  });
});

describe('graph: no-snapshot error parity', () => {
  test('readGraph / writeNodes throw the same message when no current and no snapshotId', async () => {
    const { id: pid } = await freshProject('nosnap');
    await assert.rejects(
      readGraph(store, pid),
      /no snapshotId given and no current snapshot recorded/,
    );
    await assert.rejects(
      writeNodes(store, pid, [n('a')]),
      /no snapshotId given and no current snapshot recorded/,
    );
  });
});

describe('graph: validation runs before any delete', () => {
  test('a bad type throws and leaves existing rows untouched', async () => {
    const { id: pid } = await freshProject('badtype');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a'), n('b')], { snapshotId: sid });

    await assert.rejects(
      writeNodes(store, pid, [n('c'), { id: 'bad', type: 'NOT_A_TYPE', name: 'bad', data: {}, claims: [] }], { snapshotId: sid }),
      /unknown node type/,
    );

    const graph = await readGraph(store, pid, sid);
    assert.deepEqual(graph.nodes.map((x) => x.id).sort(), ['a', 'b']);
  });

  test('same for edges', async () => {
    const { id: pid } = await freshProject('badtype-edge');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a'), n('b')], { snapshotId: sid });
    await writeEdges(store, pid, [e('e1', 'a', 'b')], { snapshotId: sid });

    await assert.rejects(
      writeEdges(store, pid, [{ id: 'e2', type: 'NOT_A_TYPE', src: 'a', dst: 'b' }], { snapshotId: sid }),
      /unknown edge type/,
    );

    const graph = await readGraph(store, pid, sid);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].id, 'e1');
  });
});

// Regression: assess/report() re-adds the same deterministic FINDING/VULN_CANDIDATE nodes+edges
// on every scan (same ids, since candidate/finding numbering restarts each run) — the OLD JSONL
// writer tolerated a caller passing duplicate ids in one write; the SQLite UNIQUE(snapshot_id,id)
// PK does not, so a bulk INSERT containing two rows with the same id must not throw. Without the
// dedupe-by-id fix in insertRows, this test throws "UNIQUE constraint failed: edges.snapshot_id,
// edges.id" (and the equivalent for nodes).
describe('graph: duplicate ids within ONE write are tolerated (last-wins), matching the old JSONL writer', () => {
  test('writeNodes with two rows of the SAME id → no throw; readGraph returns ONE (the last)', async () => {
    const { id: pid } = await freshProject('dup-nodes');
    const sid = 'snap-1';
    await assert.doesNotReject(
      writeNodes(store, pid, [n('a', { name: 'first' }), n('b'), n('a', { name: 'second' })], { snapshotId: sid }),
    );
    const graph = await readGraph(store, pid, sid);
    assert.deepEqual(graph.nodes.map((x) => x.id).sort(), ['a', 'b']);
    assert.equal(graph.nodes.find((x) => x.id === 'a').name, 'second', 'last row for a duplicate id wins');
  });

  test('writeEdges with two rows of the SAME id → no throw; readGraph returns ONE (the last)', async () => {
    const { id: pid } = await freshProject('dup-edges');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a'), n('b'), n('c')], { snapshotId: sid });
    await assert.doesNotReject(
      writeEdges(store, pid, [e('e1', 'a', 'b'), e('e1', 'a', 'c')], { snapshotId: sid }),
    );
    const graph = await readGraph(store, pid, sid);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].dst, 'c', 'last row for a duplicate id wins');
  });
});

describe('graph: multi-snapshot isolation', () => {
  test('two snapshots keep separate rows; current tracks whichever was written last explicitly', async () => {
    const { id: pid } = await freshProject('multi');
    await writeNodes(store, pid, [n('a')], { snapshotId: 'A' });
    await writeNodes(store, pid, [n('x'), n('y')], { snapshotId: 'B' });

    const gA = await readGraph(store, pid, 'A');
    const gB = await readGraph(store, pid, 'B');
    assert.deepEqual(gA.nodes.map((x) => x.id), ['a']);
    assert.deepEqual(gB.nodes.map((x) => x.id).sort(), ['x', 'y']);

    const current = await readGraph(store, pid); // no snapshotId -> current -> B
    assert.deepEqual(current.nodes.map((x) => x.id).sort(), ['x', 'y']);
  });
});

describe('graph: neighbourhood', () => {
  test('hub returns hub + leaves + touching edges only; leaf returns hub + itself; unknown id returns empty', async () => {
    const { id: pid } = await freshProject('neigh');
    const sid = 'snap-1';
    const nodes = [n('hub'), n('leaf1'), n('leaf2'), n('leaf3'), n('other1'), n('other2')];
    const edges = [
      e('e1', 'hub', 'leaf1'),
      e('e2', 'hub', 'leaf2'),
      e('e3', 'hub', 'leaf3'),
      e('e-unrelated', 'other1', 'other2'),
    ];
    await writeNodes(store, pid, nodes, { snapshotId: sid });
    await writeEdges(store, pid, edges, { snapshotId: sid });

    const hubResult = await neighbourhood(store, pid, 'hub');
    assert.deepEqual(hubResult.nodes.map((x) => x.id).sort(), ['hub', 'leaf1', 'leaf2', 'leaf3']);
    assert.deepEqual(hubResult.edges.map((x) => x.id).sort(), ['e1', 'e2', 'e3']);

    const leafResult = await neighbourhood(store, pid, 'leaf1');
    assert.deepEqual(leafResult.nodes.map((x) => x.id).sort(), ['hub', 'leaf1']);
    assert.deepEqual(leafResult.edges.map((x) => x.id), ['e1']);

    const noneResult = await neighbourhood(store, pid, 'does-not-exist');
    assert.deepEqual(noneResult, { nodes: [], edges: [] });
  });
});

describe('graph: legacy JSONL lazy import', () => {
  test('hand-written snapshots/*/graph/*.jsonl + graph/current.json import on first readGraph', async () => {
    const { id: pid } = await freshProject('legacy');
    const projectDir = store.projectDir(pid);
    const sid = 'legacy-snap';
    const graphDir = path.join(projectDir, 'snapshots', sid, 'graph');
    await fs.mkdir(graphDir, { recursive: true });
    const legacyNodes = [n('a'), n('b')];
    const legacyEdges = [e('e1', 'a', 'b')];
    await fs.writeFile(path.join(graphDir, 'nodes.jsonl'), legacyNodes.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await fs.writeFile(path.join(graphDir, 'edges.jsonl'), legacyEdges.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await fs.mkdir(path.join(projectDir, 'graph'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'graph', 'current.json'), JSON.stringify({ snapshotId: sid }));

    const graph = await readGraph(store, pid); // first touch -> triggers lazy import, no snapshotId -> current
    assert.deepEqual(graph.nodes, legacyNodes);
    assert.deepEqual(graph.edges, [{ id: 'e1', type: 'CONTAINS', src: 'a', dst: 'b' }]);

    // Confirm it's actually persisted in index.sqlite on disk, not just an in-memory artifact of
    // the import step: read the file directly with a brand-new, uncached DatabaseSync handle.
    const dbFile = path.join(projectDir, 'index.sqlite');
    await assert.doesNotReject(fs.access(dbFile));
    const rawDb = new DatabaseSync(dbFile);
    const rows = rawDb.prepare('SELECT id FROM nodes WHERE snapshot_id = ? ORDER BY id').all(sid);
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
    rawDb.close();

    // .jsonl files are left on disk, untouched.
    await assert.doesNotReject(fs.access(path.join(graphDir, 'nodes.jsonl')));
  });
});

describe('reconciliation: round-trip, dedupe, unknown-status rejection', () => {
  test('writeReconciliation + readReconciliation round-trips; reconciliationCounts sums by status', async () => {
    const { id: pid } = await freshProject('recon-rt');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('feature:foo')], { snapshotId: sid });
    const rows = [
      { file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'GET /a', status: 'MAPPED_TO_FEATURE', feature_id: 'feature:foo' },
      { file: 'b.rb', line: 2, kind: 'DATA_STORE', entry: 'B', status: 'SHARED_INFRASTRUCTURE', feature_id: null },
      { file: 'c.rb', line: 3, kind: 'AUTHN', entry: null, status: 'UNCLEAR_COVERAGE_GAP', feature_id: null },
    ];
    await writeReconciliation(store, pid, rows, { snapshotId: sid });

    const read = await readReconciliation(store, pid, sid);
    assert.equal(read.length, 3);
    assert.deepEqual(read.map((r) => r.status).sort(), ['MAPPED_TO_FEATURE', 'SHARED_INFRASTRUCTURE', 'UNCLEAR_COVERAGE_GAP']);
    const mapped = read.find((r) => r.status === 'MAPPED_TO_FEATURE');
    assert.equal(mapped.file, 'a.rb');
    assert.equal(mapped.line, 1);
    assert.equal(mapped.feature_id, 'feature:foo');

    const counts = await reconciliationCounts(store, pid, sid);
    assert.deepEqual(counts, { MAPPED_TO_FEATURE: 1, SHARED_INFRASTRUCTURE: 1, UNCLEAR_COVERAGE_GAP: 1 });
  });

  test('rejects an unknown status', async () => {
    const { id: pid } = await freshProject('recon-badstatus');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a')], { snapshotId: sid });
    await assert.rejects(
      writeReconciliation(store, pid, [{ file: 'x.rb', line: 1, kind: 'ENDPOINT', entry: 'x', status: 'NOT_A_STATUS', feature_id: null }], { snapshotId: sid }),
      /unknown status/,
    );
  });

  test('writing the same reconciliation universe twice does not duplicate rows (dedupe by id, last wins)', async () => {
    const { id: pid } = await freshProject('recon-dedupe');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a')], { snapshotId: sid });
    const row = { file: 'a.rb', line: 1, kind: 'ENDPOINT', entry: 'GET /a', status: 'UNCLEAR_COVERAGE_GAP', feature_id: null };
    await writeReconciliation(store, pid, [row, { ...row, status: 'MAPPED_TO_FEATURE', feature_id: 'feature:a' }], { snapshotId: sid });
    const read = await readReconciliation(store, pid, sid);
    assert.equal(read.length, 1, 'same file/line/kind/entry -> same id -> deduped, last wins');
    assert.equal(read[0].status, 'MAPPED_TO_FEATURE');
  });

  test('a full-replace write shrinks the set, same as insertRows for nodes/edges', async () => {
    const { id: pid } = await freshProject('recon-shrink');
    const sid = 'snap-1';
    await writeNodes(store, pid, [n('a')], { snapshotId: sid });
    const three = ['a', 'b', 'c'].map((x) => ({ file: `${x}.rb`, line: 1, kind: 'ENDPOINT', entry: x, status: 'UNCLEAR_COVERAGE_GAP', feature_id: null }));
    await writeReconciliation(store, pid, three, { snapshotId: sid });
    assert.equal((await readReconciliation(store, pid, sid)).length, 3);
    await writeReconciliation(store, pid, [three[0]], { snapshotId: sid });
    assert.equal((await readReconciliation(store, pid, sid)).length, 1);
  });
});

describe('graph: deleteProject closes the cached DatabaseSync handle', () => {
  test('re-opening the same sourceRoot after deleteProject writes into a real, fresh index.sqlite', async () => {
    const sourceRoot = path.join(tmpRoot, 'del-reopen');
    await fs.mkdir(sourceRoot, { recursive: true });
    const project1 = await store.openProject({ sourceRoot, name: 'del-reopen' });
    const pid = project1.id;
    const sid = 'snap-1';

    await writeNodes(store, pid, [n('a')], { snapshotId: sid });
    assert.deepEqual((await readGraph(store, pid, sid)).nodes.map((x) => x.id), ['a']);

    await store.deleteProject(pid); // must close the cached handle before fs.rm

    // projectId is a deterministic hash of sourceRoot -> re-opening the same path reuses it.
    const project2 = await store.openProject({ sourceRoot, name: 'del-reopen' });
    assert.equal(project2.id, pid);
    await writeNodes(store, pid, [n('z')], { snapshotId: sid });

    const graph = await readGraph(store, pid, sid);
    assert.deepEqual(graph.nodes.map((x) => x.id), ['z']);

    // The regression this guards: if the old handle wasn't closed, openDb's cache hit means
    // a fresh index.sqlite is never actually created on disk after the directory was removed —
    // so assert a real, independently-readable file exists at the (recreated) project path.
    const dbFile = path.join(store.projectDir(pid), 'index.sqlite');
    await assert.doesNotReject(fs.access(dbFile));
    const rawDb = new DatabaseSync(dbFile);
    const rows = rawDb.prepare('SELECT id FROM nodes WHERE snapshot_id = ?').all(sid);
    rawDb.close();
    assert.deepEqual(rows.map((r) => r.id), ['z']);
  });
});
