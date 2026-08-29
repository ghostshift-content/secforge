// @secforge/map — SecForge's mapping engine, v1: deterministic snapshot → inventory → feature graph.
// No LLM, no AST, no external engine — a small language-agnostic regex table over a frozen file
// manifest, producing typed nodes/edges with file:line claims. Entirely our own logic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID } from '@secforge/schemas';
// Relative import: packages/store's package.json "exports" only opens its root ("."), so a bare
// '@secforge/store/graph' specifier is blocked by Node's package encapsulation. A direct relative
// path reaches the file without needing to touch store's package.json.
import { writeNodes, writeEdges, neighbourhood } from '../../store/src/graph.js';

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'vendor', 'build', 'coverage', '.next', 'out']);
const MAX_BYTES = 1_000_000; // ponytail: flat cap, not a size histogram — raise if real repos need it
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- SNAPSHOT ----------
function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(full, base, out); continue; }
    out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function buildManifest(sourceRoot) {
  const manifest = [];
  for (const rel of walk(sourceRoot, sourceRoot, []).sort()) {
    const abs = path.join(sourceRoot, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary heuristic: NUL byte in the head
    manifest.push({ path: rel, bytes: stat.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  }
  return manifest;
}

const hashManifest = (manifest) => crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

function persistSnapshot(store, projectId, snapshotId, manifest) {
  const dir = path.join(store.projectDir(projectId), 'snapshots', snapshotId);
  fs.mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, 'source-manifest.jsonl');
  fs.writeFileSync(manifestFile + '.tmp', manifest.map((m) => JSON.stringify(m)).join('\n') + (manifest.length ? '\n' : ''));
  fs.renameSync(manifestFile + '.tmp', manifestFile);
  const snapFile = path.join(dir, 'snapshot.json');
  const bytes = manifest.reduce((s, m) => s + m.bytes, 0);
  fs.writeFileSync(snapFile + '.tmp', JSON.stringify({ content_hash: snapshotId, file_count: manifest.length, bytes }, null, 2));
  fs.renameSync(snapFile + '.tmp', snapFile);
}

// ---------- INVENTORY (heuristic, file:line cited) ----------
function matchEndpoint(line) {
  let m = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/i.exec(line);
  if (m) return { method: m[1].toUpperCase(), route: m[2] };
  m = /@(?:app|blueprint|bp)\.route\s*\(\s*['"]([^'"]+)['"]/i.exec(line);
  if (m) {
    const methods = /methods\s*=\s*\[([^\]]+)\]/i.exec(line);
    const method = methods?.[1].match(/['"](\w+)['"]/)?.[1] || 'GET';
    return { method: method.toUpperCase(), route: m[1] };
  }
  m = /^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/i.exec(line); // Rails routes.rb
  if (m) return { method: m[1].toUpperCase(), route: m[2] };
  return null;
}
const matchService = (line) => /\bclass\s+([A-Za-z0-9_]*Service)\b/.exec(line)?.[1] || null;
const matchJob = (line) => /\bclass\s+([A-Za-z0-9_]*(?:Job|Worker))\b/.exec(line)?.[1] || null;
const matchDataStore = (line) =>
  /\bclass\s+([A-Za-z0-9_]+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/.exec(line)?.[1] ||
  /\bclass\s+([A-Za-z0-9_]+)\s*\(\s*models\.Model\s*\)/.exec(line)?.[1] ||
  /(?:mongoose\.model|sequelize\.define)\(\s*['"]([A-Za-z0-9_]+)['"]/.exec(line)?.[1] ||
  /\bclass\s+([A-Za-z0-9_]*Model)\b/.exec(line)?.[1] ||
  null;

function scanFile(sourceRoot, rel) {
  let text;
  try { text = fs.readFileSync(path.join(sourceRoot, rel), 'utf8'); } catch { return []; }
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ep = matchEndpoint(line);
    if (ep) { rows.push({ kind: 'ENDPOINT', file: rel, line: i + 1, method: ep.method, route: ep.route }); continue; }
    const svc = matchService(line);
    if (svc) { rows.push({ kind: 'SERVICE', file: rel, line: i + 1, name: svc }); continue; }
    const job = matchJob(line);
    if (job) { rows.push({ kind: 'JOB', file: rel, line: i + 1, name: job }); continue; }
    const ds = matchDataStore(line);
    if (ds) { rows.push({ kind: 'DATA_STORE', file: rel, line: i + 1, name: ds }); continue; }
  }
  return rows;
}

// ---------- FEATURES: cluster inventory rows by their own directory structure ----------
const moduleDirOf = (rel) => { const d = path.dirname(rel); return d === '.' ? 'root' : d; };

function buildGraph(inventory) {
  const nodes = new Map();
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const edges = [];
  const edgeIds = new Set();
  const addEdge = (id, type, src, dst) => { if (!edgeIds.has(id)) { edgeIds.add(id); edges.push({ id, type, src, dst }); } };

  const clusters = new Map();
  for (const row of inventory) {
    const dir = moduleDirOf(row.file);
    if (!clusters.has(dir)) clusters.set(dir, { rows: [], files: new Set() });
    clusters.get(dir).rows.push(row);
    clusters.get(dir).files.add(row.file);
  }

  const features = [];
  for (const [dir, cluster] of [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const featureId = ID.feature(dir);
    const counts = { endpoints: 0, services: 0, jobs: 0, dataStores: 0, files: cluster.files.size };
    addNode({ id: featureId, type: 'FEATURE', name: dir, data: { dir },
      claims: [{ file: cluster.rows[0].file, line: cluster.rows[0].line, method: 'generated', confidence: 'medium' }] });

    for (const file of [...cluster.files].sort()) {
      const fileId = ID.file(file);
      addNode({ id: fileId, type: 'FILE', name: file, data: {}, claims: [{ file, line: 1, method: 'manifest', confidence: 'high' }] });
      addEdge(`edge:${featureId}:CONTAINS:${fileId}`, 'CONTAINS', featureId, fileId);
    }

    for (const row of cluster.rows) {
      const claim = { file: row.file, line: row.line, method: 'grep', confidence: 'medium' };
      if (row.kind === 'ENDPOINT') {
        const id = ID.endpoint(row.method, row.route);
        addNode({ id, type: 'ENDPOINT', name: `${row.method} ${row.route}`, data: { method: row.method, route: row.route }, claims: [claim] });
        addEdge(`edge:${featureId}:EXPOSES:${id}`, 'EXPOSES', featureId, id);
        counts.endpoints++;
      } else if (row.kind === 'SERVICE') {
        const id = `service:${slugify(row.file)}:${row.line}`;
        addNode({ id, type: 'SERVICE', name: row.name, data: {}, claims: [claim] });
        addEdge(`edge:${featureId}:USES_SERVICE:${id}`, 'USES_SERVICE', featureId, id);
        counts.services++;
      } else if (row.kind === 'JOB') {
        const id = `job:${slugify(row.file)}:${row.line}`;
        addNode({ id, type: 'JOB', name: row.name, data: {}, claims: [claim] });
        // ponytail: no dedicated "async work" edge type exists yet — HANDLED_BY stands in for both
        // JOB and DATA_STORE below; split it if the two ever need distinct semantics.
        addEdge(`edge:${featureId}:HANDLED_BY:${id}`, 'HANDLED_BY', featureId, id);
        counts.jobs++;
      } else if (row.kind === 'DATA_STORE') {
        const id = `datastore:${slugify(row.file)}:${row.line}`;
        addNode({ id, type: 'DATA_STORE', name: row.name, data: {}, claims: [claim] });
        addEdge(`edge:${featureId}:HANDLED_BY:${id}`, 'HANDLED_BY', featureId, id);
        counts.dataStores++;
      }
    }
    features.push({ id: featureId, name: dir, slug: slugify(dir), counts });
  }
  return { nodes: [...nodes.values()], edges, features };
}

/**
 * Map a project into the knowledge graph: snapshot the source tree, extract a heuristic
 * inventory, cluster it into features, and persist the resulting graph.
 * @returns {Promise<{status:string, snapshotId:string, features:Array, coverage:object, nodeCount:number, edgeCount:number}>}
 */
export async function mapProject({ sourceRoot, store, projectId, onProgress } = {}) {
  if (!sourceRoot || !store || !projectId) throw new Error('mapProject requires sourceRoot, store, projectId');

  onProgress?.({ phase: 'snapshot', pct: 0 });
  const manifest = buildManifest(sourceRoot);
  const snapshotId = hashManifest(manifest);
  persistSnapshot(store, projectId, snapshotId, manifest);
  onProgress?.({ phase: 'snapshot', pct: 25 });

  onProgress?.({ phase: 'inventory', pct: 25 });
  const inventory = manifest.flatMap((m) => scanFile(sourceRoot, m.path));
  onProgress?.({ phase: 'inventory', pct: 50 });

  onProgress?.({ phase: 'features', pct: 50 });
  const { nodes, edges, features } = buildGraph(inventory);
  onProgress?.({ phase: 'features', pct: 75 });

  onProgress?.({ phase: 'persist', pct: 75 });
  await writeNodes(store, projectId, nodes, { snapshotId });
  await writeEdges(store, projectId, edges, { snapshotId });
  await store.appendEvent(projectId, { type: 'map.completed', features: features.length });
  onProgress?.({ phase: 'persist', pct: 100 });

  const filesWithHits = new Set(inventory.map((r) => r.file)).size;
  const technical = manifest.length ? Math.round((filesWithHits / manifest.length) * 100) / 100 : 0;

  return {
    status: 'MAPPED',
    snapshotId,
    features,
    coverage: { technical, semantic: 0 }, // ponytail: semantic/LLM coverage lands with the AI mapping pass
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export async function featureGraph(store, projectId, featureId) {
  return neighbourhood(store, projectId, featureId);
}
