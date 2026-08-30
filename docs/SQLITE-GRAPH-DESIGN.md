# SQLite knowledge graph — design (packages/store/src/graph.js replacement)

Status: design only, no code. Target: swap the JSONL graph backend for `index.sqlite` via
`node:sqlite`, with the **public API frozen byte-for-byte** so `packages/map` and
`packages/assess` need zero changes. Grounded in the current code (`graph.js`, `store/index.js`,
`schemas/index.js`), not the idealized `publications/<pub-id>/` layout in SECFORGE-PLAN §4 — that
layout isn't implemented; today a project has `snapshots/<sid>/graph/{nodes,edges}.jsonl` plus a
project-level `graph/current.json` pointer, and this design keeps that shape, just backed by SQL.

## 0. Frozen contract (what must not change)

```js
writeNodes(store, projectId, nodes, { snapshotId } = {})   // -> Promise<void>
writeEdges(store, projectId, edges, { snapshotId } = {})   // -> Promise<void>
readGraph(store, projectId, snapshotId)                    // -> Promise<{ nodes, edges }>
neighbourhood(store, projectId, nodeId, snapshotId)         // -> Promise<{ nodes, edges }>
```

Two call shapes exist in real callers today and both must keep working:

- `map/src/index.js`: `writeNodes(store, projectId, nodes, { snapshotId })` /
  `writeEdges(store, projectId, edges, { snapshotId })` — **full replacement** of a fresh
  snapshot's node/edge set, and it also **sets current** (`setCurrentSnapshotId`) as a side
  effect of passing `snapshotId`.
- `assess/src/index.js` `report()`: `writeNodes(store, projectId, [...graph.nodes, ...newNodes])`
  / `writeEdges(store, projectId, [...graph.edges, ...newEdges])` — **no `snapshotId`**, so it
  resolves the *current* snapshot and replaces its node/edge set with `existing ∪ new` (the
  caller already merged, since JSONL `writeJsonl` overwrites the whole file with whatever rows
  it's given — it is not an append). **This "full replace of the set for that snapshot" semantic
  is the one non-obvious contract the SQL layer must preserve exactly** — see §3.

`neighbourhood` is 1-hop: the node itself, every node touching it via an edge, and those edges.

## 1. Schema

One `index.sqlite` file, four tables. `projectId` is *not* a column — the DB itself lives inside
that project's directory, so every row it holds already belongs to one project; the schema only
needs to key nodes/edges by `snapshotId`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
); -- holds ('current_snapshot_id', <sid>) — replaces graph/current.json

CREATE TABLE IF NOT EXISTS nodes (
  snapshot_id TEXT NOT NULL,
  id          TEXT NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',   -- JSON.stringify(node.data)
  claims      TEXT NOT NULL DEFAULT '[]',   -- JSON.stringify(node.claims)
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
```

Notes:

- No separate `claims` table. Today's node shape is `{id, type, name, data, claims:[...]}` where
  `claims` is a small array embedded in the node (from `schemas/index.js` usage in `map`/`assess`
  — every `addNode` call inlines `claims`). Normalizing claims into a child table buys nothing
  (`readGraph` just needs the array back verbatim) and costs a join on every read plus a
  `JSON.stringify`/`parse` symmetry to maintain — one JSON column matches the actual shape.
  Revisit only if something needs to query *inside* claims with SQL (e.g. "all claims with
  confidence=low"); nothing does today.
- `data` and `edges.data`: edges in the real payloads (`map`, `assess`) never actually carry a
  `data` field (`{id, type, src, dst}` only) — the column exists for forward compatibility and
  defaults to `'{}'`, dropped on read if empty (see §3) so round-trip is exact.
- `WITHOUT ROWID` on `(snapshot_id, id)`: ids are already unique per snapshot (deterministic ids
  per `ID` builders in schemas — re-scans are idempotent), so the composite key doubles as
  physical storage order for free range scans by `snapshot_id`.
- No `snapshots` table. The set of known snapshot ids is derivable (`SELECT DISTINCT snapshot_id
  FROM nodes`) and the store's `snapshots/<sid>/` directories are already the source of truth for
  "a snapshot exists" (its `snapshot.json` / `source-manifest.jsonl`). Adding a `snapshots` table
  here would be a second place that can drift from the filesystem — skip it.
- No `PROJECT`/foreign-key constraints between `nodes.snapshot_id` and anything: this DB has one
  project's worth of data by construction (path placement, §2), so there's nothing to constrain
  against.

## 2. DB placement & lifecycle

**One `index.sqlite` per project**, at `store.projectDir(projectId)/index.sqlite` — sibling to
`project.json`, `events.log`, `graph/current.json` (which this replaces). Per-project (not
per-snapshot) because:

- Matches the actual write pattern: `assess/report()` reads the *current* snapshot's graph and
  writes back into it, repeatedly, across a whole assessment run — one connection per project
  avoids reopening a DB file per operation and lets multiple snapshots share one WAL-mode
  connection with no cross-file coordination.
  it directly serves "give me the history of this project's graph" (e.g. diffing two scans) —
  the plan docs describe keeping history per-snapshot inside one store, and the `snapshot_id`
  column is exactly that: cheap, and free with one extra WHERE clause per query.

`meta.current_snapshot_id` replaces `graph/current.json`. Written transactionally in the same
`db.exec('BEGIN')...COMMIT` block as the node/edge replace when `writeNodes`/`writeEdges` is
called *with* a `snapshotId` (mirrors today's `setCurrentSnapshotId` side effect exactly).

**Atomicity / concurrency**: `node:sqlite`'s `DatabaseSync` opened once per `Store` instance (or
lazily per project, cached — see §5), with `PRAGMA journal_mode = WAL`. Every write path
(`writeNodes`, `writeEdges`) wraps its DELETE+INSERT+meta-update in one transaction — WAL gives
crash-safe atomic commits with readers never blocked by a writer, which is the direct SQLite
analogue of the JSONL layer's write-tmp-then-rename. The store already serializes writes to one
project per the "scan = session" model (docs/BACKEND-ARCHITECTURE §2: one locked session per
project, no two scans write the same store concurrently) — SQLite's own file locking is a second,
belt-and-suspenders layer under that, not a replacement for it.

## 3. API → SQL mapping

```js
// writeNodes(store, projectId, nodes, { snapshotId } = {})
const sid = snapshotId || await resolveSnapshotId(store, projectId); // unchanged helper
db.exec('BEGIN');
db.prepare('DELETE FROM nodes WHERE snapshot_id = ?').run(sid);
const ins = db.prepare('INSERT INTO nodes (snapshot_id, id, type, name, data, claims) VALUES (?,?,?,?,?,?)');
for (const n of nodes) {
  assertType(NODE_TYPES, n.type, 'node'); // unchanged validation, same error message/order
  ins.run(sid, n.id, n.type, n.name, JSON.stringify(n.data ?? {}), JSON.stringify(n.claims ?? []));
}
if (snapshotId) db.prepare('INSERT INTO meta (key, value) VALUES (\'current_snapshot_id\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(snapshotId);
db.exec('COMMIT');
```

DELETE-then-INSERT (not per-row upsert) is what makes `writeNodes` a **replace of the whole
node set for that snapshot** — required because `assess/report()` relies on exactly this: it
passes `[...graph.nodes, ...newNodes]` (the full existing set plus its additions) and expects the
result to *be* that full set, not some superset that also keeps whatever the DB already had.
Per-row `INSERT ... ON CONFLICT DO UPDATE` alone would never *remove* a node that a caller's list
dropped (e.g. a rescan producing fewer nodes than before) — DELETE-then-INSERT matches the JSONL
behavior (`fs.writeFile` overwrites the whole file) exactly. `writeEdges` mirrors this on the
`edges` table.

```js
// writeEdges — identical shape, edges table, EDGE_TYPES validation
```

```js
// readGraph(store, projectId, snapshotId)
const sid = await resolveSnapshotId(store, projectId, snapshotId); // unchanged: throws if none
const nodes = db.prepare('SELECT id, type, name, data, claims FROM nodes WHERE snapshot_id = ?').all(sid)
  .map((r) => ({ id: r.id, type: r.type, name: r.name, data: JSON.parse(r.data), claims: JSON.parse(r.claims) }));
const edges = db.prepare('SELECT id, type, src, dst, data FROM edges WHERE snapshot_id = ?').all(sid)
  .map((r) => { const e = { id: r.id, type: r.type, src: r.src, dst: r.dst }; const d = JSON.parse(r.data); if (Object.keys(d).length) e.data = d; return e; });
return { nodes, edges };
```

The `edges` mapper only attaches `data` when non-empty, since today's edges never carry a `data`
key and a test doing `assert.deepEqual(edge, {id,type,src,dst})` must keep passing.

```js
// neighbourhood(store, projectId, nodeId, snapshotId)
const sid = await resolveSnapshotId(store, projectId, snapshotId);
const touching = db.prepare('SELECT id, type, src, dst, data FROM edges WHERE snapshot_id = ? AND (src = ? OR dst = ?)').all(sid, nodeId, nodeId).map(/* same mapper */);
const ids = new Set([nodeId, ...touching.flatMap((e) => [e.src, e.dst])]);
const placeholders = [...ids].map(() => '?').join(',');
const nodes = db.prepare(`SELECT id, type, name, data, claims FROM nodes WHERE snapshot_id = ? AND id IN (${placeholders})`).all(sid, ...ids).map(/* same mapper */);
return { nodes, edges: touching };
```

`neighbourhood` becomes two indexed queries (`idx_edges_snapshot_src`/`_dst`, then a keyed IN
lookup) instead of loading the whole graph into memory and filtering in JS — a real win on large
graphs, with an *identical* return shape. `resolveSnapshotId`/`currentSnapshotId`/
`setCurrentSnapshotId` keep their current signatures but read/write `meta` instead of
`graph/current.json`.

Nothing here forces an API change. The one behavior worth flagging (not a change, a thing to get
right): `assertType` must still run and throw **before** any row is written — i.e. validate the
whole `nodes`/`edges` array up front, then open the transaction, so a bad type in row 50 doesn't
leave the DELETE half-applied. The current JSONL code already validates up front (`for (const n
of nodes) assertType(...)` runs before `writeJsonl`), so this is preserving existing behavior, not
adding new behavior.

## 4. Migration: JSONL is retired, not mirrored

**Recommendation: fully replace JSONL with SQLite for the graph. Do not maintain both as a
dual-write mirror.**

Reasons:
- A dual-write mirror is strictly more code and more failure modes (what happens when one write
  succeeds and the other fails mid-transaction?) for a benefit nobody asked for — nothing reads
  the JSONL files except `graph.js` itself. YAGNI: there's no second consumer of the JSONL format
  to keep alive.
- The store's source-of-truth guarantee lives at the *store* layer (frozen snapshot,
  `events.log`, atomic writes) — the graph is a derived index over the snapshot + assessment
  history, not itself irreplaceable raw evidence. Nothing is lost by re-deriving it: `mapProject`
  already recomputes the graph deterministically from the snapshot on every scan, and
  `assessment` findings/candidates are separately persisted as their own JSON
  (`assess/findings/<id>/finding.json`) and in `events.log` — so even a corrupted `index.sqlite`
  loses nothing that can't be rebuilt by re-running the map (findings themselves survive
  independently in `assess/findings/`).
- One storage format is less to reason about, test, and keep in sync than two.

**Existing projects with only `nodes.jsonl`/`edges.jsonl` on disk (pre-migration data):**
lazy, on-first-read import — no separate migration command/script to maintain or forget to run.

```js
async function ensureDb(store, projectId) {
  const db = openDb(store, projectId); // creates index.sqlite + schema if absent
  const hasRows = db.prepare('SELECT 1 FROM nodes LIMIT 1').get();
  if (!hasRows) {
    // one-time: if legacy snapshots/*/graph/*.jsonl exist on disk, import them all, oldest first,
    // ending on whatever graph/current.json (if present) named as current — then nothing else
    // ever touches JSONL again. No-op (silent) if no legacy files exist — a brand-new project.
    await importLegacyJsonlIfPresent(store, projectId, db);
  }
  return db;
}
```

This is checked once per `Store`-instance-lifetime per project (cache the "already checked" flag
alongside the cached connection, §5) — not on every call — so it costs nothing after the first
touch. `import` reuses the exact `writeNodes`/`writeEdges` SQL path per legacy snapshot dir found,
so it gets the same validation and dedup behavior as a live write, then leaves the old `.jsonl`
files in place untouched (harmless, ignored) rather than deleting user data as a side effect of a
read — a manual `rm` of the old `graph/` and `snapshots/*/graph/` directories is a fine follow-up
cleanup, not this layer's job.

`ponytail`: no `secforge migrate` CLI command, no dry-run flag, no progress reporting for the
import — it's a handful of JSONL files per project, this finishes in milliseconds. Add a real
migration command only if a fleet of large pre-existing stores turns up in practice.

## 5. node:sqlite specifics

- `import { DatabaseSync } from 'node:sqlite'` — **zero npm dependency**, confirmed:
  `node -e "require('node:sqlite')"` succeeds on this repo's Node (v24.18.0) with no
  `--experimental-sqlite` flag and no `package.json` entry needed. `node:sqlite` landed
  experimental (flagged) in Node 22.5, and unflagged in Node 23.4+ — `package.json` here pins
  `"engines": {"node": ">=22"}`; on a Node in the 22.5–22.x range **before** it was unflagged in
  that line, `node:sqlite` needs `--experimental-sqlite`. Worth bumping the documented minimum
  (or noting the flag) — flagged as a risk in §7, not something this design silently papers over.
- API surface used: `new DatabaseSync(path)`, `db.exec(sql)` (schema DDL, `BEGIN`/`COMMIT`),
  `db.prepare(sql)` returning a `StatementSync` with `.run(...params)` and `.all(...params)`.
  No `.get()` needed beyond the one existence check in §4. All synchronous — `node:sqlite` has no
  async mode.
- **Async wrapper, not async engine**: `writeNodes`/`writeEdges`/`readGraph`/`neighbourhood` stay
  `async function`s with the *same signatures* — the function bodies just do synchronous
  `DatabaseSync` calls instead of `await fs.readFile`/`writeFile`. Callers already `await` them
  (`map/src/index.js`, `assess/src/index.js`) and get a resolved Promise either way — nothing
  observes the difference between "was actually async" and "sync work wrapped in an async
  function". No `worker_threads` offload: these are small graphs (thousands of rows, not
  millions) and SQLite operations here are sub-millisecond to low-millisecond — not worth the
  complexity of a thread hop. Revisit only if profiling on a real large repo shows the main
  thread blocking long enough to matter (§7).
- One `DatabaseSync` handle per project, opened lazily and cached on the `Store` instance (a
  `Map<projectId, DatabaseSync>`) so repeated calls in one process (e.g. `assess`'s `report()`
  calling `writeNodes` then `writeEdges` then the next candidate's `writeFinding`) reuse the same
  connection rather than reopening the file each call. No explicit `close()` path needed today —
  same lifetime as the process, matching how `Store` itself has no `close()`.

## 6. Test plan (add to `packages/store/test/store.test.js`, or a new `graph.test.js` alongside it)

All against a fresh `tmpRoot`/`Store`, mirroring the existing `store.test.js` pattern
(`os.tmpdir()` + `crypto.randomBytes` unique dir, cleaned up in `after`).

1. **Round-trip, nodes**: `writeNodes(store, pid, [n1, n2], {snapshotId})` then
   `readGraph(store, pid, snapshotId)` returns `{nodes:[n1,n2], edges:[]}` — deep-equal, key order
   irrelevant.
2. **Round-trip, edges**: same for edges; confirm an edge with no `data` field comes back as
   exactly `{id,type,src,dst}` (no stray `data: {}`).
3. **Idempotent re-write**: `writeNodes` twice with the *same* `snapshotId` and *same* node list →
   `readGraph` still returns exactly that list (no duplicates) — proves DELETE-then-INSERT, not
   append.
4. **Replace-shrinks-set**: `writeNodes(store, pid, [n1, n2], {snapshotId})` then
   `writeNodes(store, pid, [n1], {snapshotId})` (no `n2`) → `readGraph` returns only `[n1]` — the
   `assess/report()`-style "full replace" contract.
5. **`writeNodes` without `snapshotId` uses current**: write with `{snapshotId}` once (sets
   current), then `writeNodes(store, pid, moreNodes)` (no `snapshotId`) → lands in that same
   snapshot; `readGraph(store, pid)` (no snapshotId arg) sees it.
6. **No current, no snapshotId → throws**: a fresh project with no prior write calling
   `readGraph(store, pid)` or `writeNodes(store, pid, [...])` throws the same
   `"no snapshotId given and no current snapshot recorded"` message as today.
7. **Unknown type rejected before write**: `writeNodes` with one bad `type` throws
   `assertType`'s message and leaves the snapshot's existing rows untouched (write the good rows
   first in a setup step, then assert the failed call didn't clear them — catches a DELETE that
   ran before validation).
8. **Multiple snapshots coexist**: write snapshot A, write snapshot B (different `snapshotId`s,
   no overlap) → `readGraph(..., 'A')` and `readGraph(..., 'B')` each see only their own rows;
   `meta.current_snapshot_id` reflects whichever was written last with an explicit `snapshotId`.
9. **`neighbourhood`**: build a small star graph (one hub node, 3 edges to 3 leaves, plus an
   unrelated node/edge pair) → `neighbourhood(store, pid, hubId)` returns exactly the hub + 3
   leaves + 3 edges, none of the unrelated pair. Also test a leaf as the query node (returns hub +
   that one leaf + one edge) and a nonexistent node id — verified against the current JSONL
   implementation directly (`node -e` against today's `graph.js`): a nonexistent id with no
   touching edges returns `{nodes: [], edges: []}` (not `{nodes:[{id:'does-not-exist',...}]}` —
   `nodeId` is only in the `ids` set to *filter by*, and filtering `nodes` for a row that was
   never written yields nothing). The SQL version must match this exactly.
10. **Legacy JSONL import**: hand-write `snapshots/<sid>/graph/{nodes,edges}.jsonl` +
    `graph/current.json` directly (bypassing the new API, simulating a pre-migration project on
    disk), then call `readGraph(store, pid)` for the first time → returns the imported data, and
    `index.sqlite` now exists with those rows (call `readGraph` again to confirm it now reads via
    a fresh `Store` instance / cold cache, not just an in-memory shortcut from the import step).
11. **map/assess integration (regression, not new)**: the existing `packages/map/test/map.test.js`
    and `packages/assess/test/assess.test.js` must pass unmodified — they exercise `writeNodes`/
    `writeEdges`/`readGraph` through the real `mapProject`/`runAssessment`/`computeCoverage` flows
    and are the actual contract check that map/assess "don't change".

## 7. Risks / edge cases

- **Node version floor**: `node:sqlite` needs `--experimental-sqlite` on Node 22.5–22.x before
  the flag was dropped (Node 23.4+ ships it unflagged); confirm/bump the effective minimum Node
  version this repo supports, or document the flag, so CI and users on an early Node 22.x don't
  hit a runtime `ERR_UNKNOWN_BUILTIN_MODULE`-style failure. Not a design change, an ops/docs note.
- **Concurrent writers**: WAL mode allows concurrent readers with one writer; SQLite's own file
  lock will make a second concurrent writer to the *same* `index.sqlite` block/retry rather than
  corrupt data, but the store's actual safety net is the existing one-session-per-project lock
  (docs/BACKEND-ARCHITECTURE §2) — SQLite locking is redundant-but-harmless under that, not the
  primary mechanism. If that session lock is ever bypassed, a long `DatabaseSync` transaction
  (open connection, `BEGIN`, do work, `COMMIT`) blocks a second writer's `db.exec('BEGIN')` for
  the transaction's duration — acceptable given transactions here are single write-then-return
  operations, not long-held.
- **Large graphs**: `readGraph` still loads a whole snapshot's nodes+edges into memory (matches
  today's JSONL behavior — no change in ceiling, just a faster path to it via indexed queries
  instead of a full `readdir`+`JSON.parse` per line). `neighbourhood` is the one call site that
  actually gets asymptotically better (indexed `WHERE src=? OR dst=?` instead of scanning every
  edge in JS) — worth calling out as the concrete perf win, not just a lateral move.
- **The 69 existing tests must stay green**: none of them import `graph.js` directly except
  through `writeNodes`/`writeEdges`/`readGraph` (§ confirmed above — `map.test.js` and
  `assess.test.js` are the only touch points, `store.test.js` itself doesn't exercise the graph
  module today). The coder's job is additive (new `graph.js` internals + new graph-specific tests
  from §6) plus verifying `npm test` at the root stays at "69 pass" or grows, never shrinks or
  flips red.
- **`index.sqlite` file left behind by `deleteProject`**: `Store.deleteProject` already does
  `fs.rm(dir, {recursive:true, force:true})` on the whole project directory — `index.sqlite`
  (plus its `-wal`/`-shm` sidecar files under WAL mode) lives inside that directory, so deletion
  is already correct with zero code change. The only new requirement: if a `DatabaseSync` handle
  for that project is cached (§5), close it *before* `deleteProject` removes the file out from
  under an open handle — a small addition to `deleteProject`, not to `graph.js`, and worth a
  one-line note for whoever implements it (open handles cache lives in `store/src/index.js`,
  `deleteProject` is also there).
