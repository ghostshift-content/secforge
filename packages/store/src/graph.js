// @secforge/store/graph — SQLite-backed knowledge-graph persistence for the map engine.
// One index.sqlite per project (<projectDir>/index.sqlite, node:sqlite / DatabaseSync). Nodes and
// edges are keyed by snapshot_id; meta.current_snapshot_id replaces the old graph/current.json
// pointer. Public API (writeNodes/writeEdges/readGraph/neighbourhood) is frozen byte-for-byte —
// see docs/SQLITE-GRAPH-DESIGN.md.
import { DatabaseSync } from 'node:sqlite';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_TYPES, EDGE_TYPES, RECONCILIATION_STATUS, ID } from '@secforge/schemas';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  snapshot_id TEXT NOT NULL,
  id          TEXT NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  claims      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS edges (
  snapshot_id TEXT NOT NULL,
  id          TEXT NOT NULL,
  type        TEXT NOT NULL,
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_nodes_snapshot_type ON nodes (snapshot_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_snapshot_src   ON edges (snapshot_id, src);
CREATE INDEX IF NOT EXISTS idx_edges_snapshot_dst   ON edges (snapshot_id, dst);
CREATE TABLE IF NOT EXISTS reconciliation (
  snapshot_id TEXT NOT NULL,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  file        TEXT,
  line        INTEGER,
  entry       TEXT,
  status      TEXT NOT NULL,
  feature_id  TEXT,
  PRIMARY KEY (snapshot_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_recon_snapshot_status ON reconciliation (snapshot_id, status);
`;

// One DatabaseSync per project, cached by absolute file path (keyed by path, not by Store
// instance, so two Store objects pointed at the same root share the same live connection).
const dbCache = new Map();
// Per-db-file "have we checked for a legacy JSONL import yet" flag — checked once per process
// lifetime per file, not on every call (design §4/§5).
const importChecked = new Set();

function dbFile(store, projectId) { return path.join(store.projectDir(projectId), 'index.sqlite'); }

function openDb(file) {
  let db = dbCache.get(file);
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  dbCache.set(file, db);
  return db;
}

async function ensureDb(store, projectId) {
  const file = dbFile(store, projectId);
  const db = openDb(file);
  if (!importChecked.has(file)) {
    const hasRows = db.prepare('SELECT 1 FROM nodes LIMIT 1').get();
    if (!hasRows) await importLegacyJsonlIfPresent(store, projectId, db);
    // Only mark "checked" once the import above actually succeeded (or there was nothing to
    // import) — if it throws, this flag is never set, so the next call retries the import
    // cleanly instead of being permanently stuck on a partial/failed one.
    importChecked.add(file);
  }
  return db;
}

// Close and forget a project's cached DatabaseSync handle, if one exists. Store.deleteProject
// MUST call this before fs.rm'ing the project directory — projectId is a deterministic hash of
// sourceRoot, so re-opening the same source path later reuses this cache key; an unclosed handle
// would keep writing into the deleted-but-still-open (unlinked) inode and silently lose data on
// the next process restart.
export function closeDb(store, projectId) {
  const file = dbFile(store, projectId);
  const db = dbCache.get(file);
  if (db) {
    db.close();
    dbCache.delete(file);
  }
  importChecked.delete(file);
}

function assertType(list, value, label) {
  if (!list.includes(value)) throw new Error(`graph: unknown ${label} type "${value}"`);
}

function setCurrent(db, snapshotId) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('current_snapshot_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(snapshotId);
}

function getCurrent(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'current_snapshot_id'").get();
  return row ? row.value : null;
}

function resolveSnapshotId(db, projectId, snapshotId) {
  const sid = snapshotId || getCurrent(db);
  if (!sid) throw new Error(`graph: no snapshotId given and no current snapshot recorded for project ${projectId}`);
  return sid;
}

// DELETE-then-INSERT, no transaction of its own — a full replace of the row set for `sid`, not a
// per-row upsert, required so assess/report()'s "existing ∪ new, write the whole set back"
// pattern actually shrinks/replaces rather than only ever growing. Callers wrap this in their own
// BEGIN/COMMIT (writeRows for a single public write, or one big transaction around several calls
// for the legacy import, so a multi-snapshot import is all-or-nothing).
// Dedupe by id (row[0], since cols[0] is always 'id'), last-wins, BEFORE the bulk INSERT. The
// old JSONL writer silently tolerated a caller passing duplicate ids in one write (e.g.
// assess/report()'s "existing ∪ new" re-adding the same deterministic FINDING/VULN_CANDIDATE
// nodes+edges on every scan); the UNIQUE(snapshot_id, id) PK here does not, so without this a
// second scan on the same project 500s. This restores JSONL-equivalent tolerance for every
// caller, in one place, without touching the full-replace-per-snapshot semantics.
function dedupeById(rows) {
  const byId = new Map();
  for (const row of rows) byId.set(row[0], row);
  return [...byId.values()];
}

function insertRows(db, table, cols, sid, rows) {
  db.prepare(`DELETE FROM ${table} WHERE snapshot_id = ?`).run(sid);
  const placeholders = cols.map(() => '?').join(',');
  const ins = db.prepare(`INSERT INTO ${table} (snapshot_id, ${cols.join(',')}) VALUES (?, ${placeholders})`);
  for (const row of dedupeById(rows)) ins.run(sid, ...row);
}

// One transaction around a single insertRows call, plus the current-snapshot meta update when
// `setCurrentId` is given (mirrors the old code's setCurrentSnapshotId side effect).
function writeRows(db, table, cols, sid, rows, setCurrentId) {
  db.exec('BEGIN');
  try {
    insertRows(db, table, cols, sid, rows);
    if (setCurrentId) setCurrent(db, setCurrentId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const nodeCols = ['id', 'type', 'name', 'data', 'claims'];
const nodeRows = (nodes) => nodes.map((n) => [n.id, n.type, n.name, JSON.stringify(n.data ?? {}), JSON.stringify(n.claims ?? [])]);
const edgeCols = ['id', 'type', 'src', 'dst', 'data'];
const edgeRows = (edges) => edges.map((e) => [e.id, e.type, e.src, e.dst, JSON.stringify(e.data ?? {})]);

function insertNodes(db, sid, nodes, setCurrentId) {
  writeRows(db, 'nodes', nodeCols, sid, nodeRows(nodes), setCurrentId);
}

function insertEdges(db, sid, edges, setCurrentId) {
  writeRows(db, 'edges', edgeCols, sid, edgeRows(edges), setCurrentId);
}

function mapNodeRow(r) {
  return { id: r.id, type: r.type, name: r.name, data: JSON.parse(r.data), claims: JSON.parse(r.claims) };
}

// `data` is attached only when non-empty — today's edges are {id,type,src,dst} with no `data`
// key unless one was actually set, and round-trip must stay exact.
function mapEdgeRow(r) {
  const e = { id: r.id, type: r.type, src: r.src, dst: r.dst };
  const d = JSON.parse(r.data);
  if (Object.keys(d).length) e.data = d;
  return e;
}

export async function writeNodes(store, projectId, nodes, { snapshotId } = {}) {
  for (const n of nodes) assertType(NODE_TYPES, n.type, 'node');
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  insertNodes(db, sid, nodes, snapshotId || null);
  if (snapshotId) await writeCurrentPointerFile(store, projectId, snapshotId);
}

export async function writeEdges(store, projectId, edges, { snapshotId } = {}) {
  for (const e of edges) assertType(EDGE_TYPES, e.type, 'edge');
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  insertEdges(db, sid, edges, snapshotId || null);
  if (snapshotId) await writeCurrentPointerFile(store, projectId, snapshotId);
}

// packages/assess/src/decorate.js (loadManifest) reads graph/current.json directly, bypassing
// this module's API — a real, unmodifiable consumer of the old pointer file, not just the JSONL
// node/edge data the design retired. meta.current_snapshot_id is graph.js's own source of truth;
// this file is a cheap mirror kept in sync only for that outside reader, same write-tmp-then-
// rename shape as the pointer file this replaces.
async function writeCurrentPointerFile(store, projectId, snapshotId) {
  const file = path.join(store.projectDir(projectId), 'graph', 'current.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ snapshotId }));
  await fsp.rename(tmp, file);
}

export async function readGraph(store, projectId, snapshotId) {
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  const nodes = db.prepare('SELECT id, type, name, data, claims FROM nodes WHERE snapshot_id = ?').all(sid).map(mapNodeRow);
  const edges = db.prepare('SELECT id, type, src, dst, data FROM edges WHERE snapshot_id = ?').all(sid).map(mapEdgeRow);
  return { nodes, edges };
}

// 1-hop neighbourhood: the node itself plus every node/edge directly touching it. Two indexed
// queries (src/dst, then a keyed IN lookup) instead of loading the whole graph into JS.
export async function neighbourhood(store, projectId, nodeId, snapshotId) {
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  const touching = db
    .prepare('SELECT id, type, src, dst, data FROM edges WHERE snapshot_id = ? AND (src = ? OR dst = ?)')
    .all(sid, nodeId, nodeId)
    .map(mapEdgeRow);
  const ids = [...new Set([nodeId, ...touching.flatMap((e) => [e.src, e.dst])])];
  const placeholders = ids.map(() => '?').join(',');
  const nodes = db
    .prepare(`SELECT id, type, name, data, claims FROM nodes WHERE snapshot_id = ? AND id IN (${placeholders})`)
    .all(sid, ...ids)
    .map(mapNodeRow);
  return { nodes, edges: touching };
}

// ---- reconciliation coverage ledger (Phase A §2) -------------------------------------------
// Fourth, parallel table + its own three functions — writeNodes/writeEdges/readGraph/
// neighbourhood above are untouched. Same DELETE-then-INSERT full-replace-per-snapshot,
// dedupe-by-id-last-wins pattern as insertNodes/insertEdges.
const reconCols = ['id', 'kind', 'file', 'line', 'entry', 'status', 'feature_id'];
const reconRows = (rows) => rows.map((r) => [
  ID.scoped('recon', r.file, r.line, r.kind, r.entry), r.kind, r.file ?? null, r.line ?? null,
  r.entry ?? null, r.status, r.feature_id ?? null,
]);

export async function writeReconciliation(store, projectId, rows, { snapshotId } = {}) {
  for (const r of rows) if (!RECONCILIATION_STATUS.includes(r.status)) throw new Error(`reconciliation: unknown status "${r.status}"`);
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  writeRows(db, 'reconciliation', reconCols, sid, reconRows(rows));
}

export async function readReconciliation(store, projectId, snapshotId) {
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  return db.prepare('SELECT id, kind, file, line, entry, status, feature_id FROM reconciliation WHERE snapshot_id = ?').all(sid);
}

export async function reconciliationCounts(store, projectId, snapshotId) {
  const db = await ensureDb(store, projectId);
  const sid = resolveSnapshotId(db, projectId, snapshotId);
  return Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) n FROM reconciliation WHERE snapshot_id = ? GROUP BY status').all(sid)
      .map((r) => [r.status, r.n]),
  );
}

// ---- legacy JSONL import (one-time, lazy) --------------------------------------------------
// Pre-migration projects have snapshots/<sid>/graph/{nodes,edges}.jsonl on disk plus an optional
// graph/current.json pointer. Imported once into SQLite on first touch; the .jsonl files are left
// on disk untouched (harmless, ignored from then on).
async function readLegacyJsonl(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

async function importLegacyJsonlIfPresent(store, projectId, db) {
  const projectDir = store.projectDir(projectId);
  let entries;
  try { entries = await fsp.readdir(path.join(projectDir, 'snapshots'), { withFileTypes: true }); }
  catch { return; } // no snapshots dir at all — brand-new project, nothing to import

  // Read + validate every legacy snapshot BEFORE writing anything, so a malformed one (e.g. a
  // retired node type tripping assertType) throws before any row is committed.
  const sids = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const perSnapshot = [];
  for (const sid of sids) {
    const dir = path.join(projectDir, 'snapshots', sid, 'graph');
    const nodes = await readLegacyJsonl(path.join(dir, 'nodes.jsonl'));
    const edges = await readLegacyJsonl(path.join(dir, 'edges.jsonl'));
    if (!nodes.length && !edges.length) continue;
    for (const n of nodes) assertType(NODE_TYPES, n.type, 'node');
    for (const e of edges) assertType(EDGE_TYPES, e.type, 'edge');
    perSnapshot.push({ sid, nodes, edges });
  }
  if (!perSnapshot.length) return;

  let current = null;
  try {
    const pointer = JSON.parse(await fsp.readFile(path.join(projectDir, 'graph', 'current.json'), 'utf8'));
    current = pointer?.snapshotId || null;
  } catch { /* no pointer file — leave current unset, matches old behaviour of no current.json */ }

  // ALL-OR-NOTHING: every legacy snapshot in one transaction. A partial import (some snapshots
  // committed, then a later one throws) would leave importChecked/hasRows both looking "already
  // imported" forever, silently stranding the rest — one transaction means a failure here leaves
  // the DB exactly as empty as before, so the caller's thrown error triggers a clean retry later.
  db.exec('BEGIN');
  try {
    for (const { sid, nodes, edges } of perSnapshot) {
      insertRows(db, 'nodes', nodeCols, sid, nodeRows(nodes));
      insertRows(db, 'edges', edgeCols, sid, edgeRows(edges));
    }
    if (current) setCurrent(db, current);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
