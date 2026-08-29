// @secforge/store/graph — lightweight JSONL graph persistence for the map engine.
// Nodes/edges live per-snapshot under <projectDir>/snapshots/<snapshotId>/graph/{nodes,edges}.jsonl.
// A small "current" pointer (<projectDir>/graph/current.json) lets readers omit snapshotId once a
// map run has written one — same atomic write-tmp-then-rename pattern as index.js.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NODE_TYPES, EDGE_TYPES } from '@secforge/schemas';

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file); // atomic
}

async function readJsonl(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

const graphDir = (store, projectId, snapshotId) => path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'graph');
const pointerFile = (store, projectId) => path.join(store.projectDir(projectId), 'graph', 'current.json');

async function currentSnapshotId(store, projectId) {
  try { return (JSON.parse(await fs.readFile(pointerFile(store, projectId), 'utf8'))).snapshotId; }
  catch { return null; }
}

async function setCurrentSnapshotId(store, projectId, snapshotId) {
  const file = pointerFile(store, projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ snapshotId }));
  await fs.rename(tmp, file);
}

async function resolveSnapshotId(store, projectId, snapshotId) {
  const sid = snapshotId || await currentSnapshotId(store, projectId);
  if (!sid) throw new Error(`graph: no snapshotId given and no current snapshot recorded for project ${projectId}`);
  return sid;
}

function assertType(list, value, label) {
  if (!list.includes(value)) throw new Error(`graph: unknown ${label} type "${value}"`);
}

export async function writeNodes(store, projectId, nodes, { snapshotId } = {}) {
  for (const n of nodes) assertType(NODE_TYPES, n.type, 'node');
  const sid = snapshotId || await resolveSnapshotId(store, projectId);
  if (snapshotId) await setCurrentSnapshotId(store, projectId, snapshotId);
  await writeJsonl(path.join(graphDir(store, projectId, sid), 'nodes.jsonl'), nodes);
}

export async function writeEdges(store, projectId, edges, { snapshotId } = {}) {
  for (const e of edges) assertType(EDGE_TYPES, e.type, 'edge');
  const sid = snapshotId || await resolveSnapshotId(store, projectId);
  if (snapshotId) await setCurrentSnapshotId(store, projectId, snapshotId);
  await writeJsonl(path.join(graphDir(store, projectId, sid), 'edges.jsonl'), edges);
}

export async function readGraph(store, projectId, snapshotId) {
  const sid = await resolveSnapshotId(store, projectId, snapshotId);
  const dir = graphDir(store, projectId, sid);
  const [nodes, edges] = await Promise.all([
    readJsonl(path.join(dir, 'nodes.jsonl')),
    readJsonl(path.join(dir, 'edges.jsonl')),
  ]);
  return { nodes, edges };
}

// 1-hop neighbourhood: the node itself plus every node/edge directly touching it.
export async function neighbourhood(store, projectId, nodeId, snapshotId) {
  const { nodes, edges } = await readGraph(store, projectId, snapshotId);
  const touching = edges.filter((e) => e.src === nodeId || e.dst === nodeId);
  const ids = new Set([nodeId, ...touching.flatMap((e) => [e.src, e.dst])]);
  return { nodes: nodes.filter((n) => ids.has(n.id)), edges: touching };
}
