// @secforge/map — SecForge's mapping engine. Snapshots the source tree, extracts a deterministic,
// multi-language inventory (@secforge/inventories), clusters + graphs it (@secforge/recon), and —
// only when a connected LLM engine is requested — enriches the graph with an evidence-validated
// AI ontology (actors/roles/permissions, refined feature purpose). Rules-only mapping always
// produces FEATURE nodes; the AI layer only ever enriches, never gates feature existence
// (mapper-design.md §CRITICAL rule 2). Zero external deps — @secforge/recon/adapters are our own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID } from '@secforge/schemas';
// Relative import: packages/store's package.json "exports" only opens its root ("."), so a bare
// '@secforge/store/graph' specifier is blocked by Node's package encapsulation. A direct relative
// path reaches the file without needing to touch store's package.json.
import { writeNodes, writeEdges, writeReconciliation, neighbourhood } from '../../store/src/graph.js';
import { profileRepo, extractInventories, inventoryMeta } from '@secforge/inventories';
import { deterministicSemanticPlan } from '@secforge/recon';
// Same reach-past-exports convention as the @secforge/store import above — inventoryRows isn't
// re-exported from recon/src/index.js and recon source is out of scope for this change (Phase C).
import { inventoryRows } from '../../recon/src/semantic-planner.js';
import { synthesizeRailsRoutes } from './rails-routes.js';
import { freezeForward, persistOntologyPlan, checkIncrementalEligibility, persistFeatureRowCount, remapGraph } from './incremental.js';
import { renderPhase1Maps } from './phase1-maps.js';
import { writeRagIndex } from '@secforge/retrieval';
import { scanFile, buildFileAuth, legacyInventoryDetail } from './legacy-identity.js';

const fsp = fs.promises;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'vendor', 'build', 'coverage', '.next', 'out']);
const MAX_BYTES = 1_000_000; // ponytail: flat cap, not a size histogram — raise if real repos need it
// Bounds so mapping a huge (or root) tree can't hang the single-threaded server. P0-1.
const MAX_FILES = 25_000;
const MAX_DEPTH = 24;
const MAX_TOTAL_BYTES = 500_000_000; // 500MB read budget across the whole manifest

// ---------- SNAPSHOT ----------
// Async (fs.promises) so each await yields the event loop — a big tree slows mapping but never
// blocks health/other routes. Bounded by MAX_FILES and MAX_DEPTH so it can't run away.
async function walk(dir, base, out, depth = 0) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) await walk(full, base, out, depth + 1); continue; }
    out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Reads each file's full buffer once (to hash it) AND freezes that SAME buffer to
// tmpDir/source/<rel> — zero extra reads, no TOCTOU window between "hash" and "freeze"
// (Phase A §1). Replaces the old buildManifest, which only hashed.
//
// `forward` ({priorManifestMap, priorSourceDir}, Phase C incremental path): a file whose sha256
// matches the PRIOR snapshot's is hardlink/copy-forwarded instead of rewritten — same bytes,
// cheaper write; the byte read (needed to hash it anyway) is unchanged.
async function buildManifestAndFreeze(sourceRoot, tmpDir, forward = null) {
  const srcOut = path.join(tmpDir, 'source');
  await fsp.mkdir(srcOut, { recursive: true }); // zero-file repos still produce an (empty) source/
  const manifest = [];
  let total = 0;
  const rels = (await walk(sourceRoot, sourceRoot, [])).sort();
  const truncatedFiles = rels.length >= MAX_FILES;
  for (const rel of rels) {
    if (total >= MAX_TOTAL_BYTES) break;
    const abs = path.join(sourceRoot, rel);
    let stat;
    try { stat = await fsp.stat(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    let buf;
    try { buf = await fsp.readFile(abs); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binary heuristic: NUL byte in the head
    total += stat.size;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    manifest.push({ path: rel, bytes: stat.size, sha256 });
    if (forward && forward.priorManifestMap.get(rel) === sha256) {
      freezeForward(forward.priorSourceDir, srcOut, rel); // unchanged since the prior snapshot
    } else {
      const dest = path.join(srcOut, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf); // freeze exactly what we hashed
    }
  }
  return { manifest, truncated: truncatedFiles || total >= MAX_TOTAL_BYTES };
}

// The PROJECT node's display name — project.json's name (the source dir's basename), never the opaque id.
function projectName(store, projectId) {
  try { return JSON.parse(fs.readFileSync(path.join(store.projectDir(projectId), 'project.json'), 'utf8')).name || projectId; } catch { return projectId; }
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
  // Same content → same snapshotId → this rewrite happens BEFORE remapGraph() reads the "prior"
  // snapshot.json (which is this very file). Keep the fields a later phase added (feature_row_count,
  // Phase C guard #2) so an unchanged-tree re-map stays eligible for incremental reuse.
  let prior = {}; try { prior = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch { /* first time */ }
  const keep = prior && prior.content_hash === snapshotId && prior.feature_row_count != null ? { feature_row_count: prior.feature_row_count } : {};
  fs.writeFileSync(snapFile + '.tmp', JSON.stringify({ content_hash: snapshotId, file_count: manifest.length, bytes, source_frozen: true, ...keep }, null, 2));
  fs.renameSync(snapFile + '.tmp', snapFile);
}


// Legacy line-regex identity/surface extraction lives in ./legacy-identity.js (same behaviour, split for size).

// New-surface rows (@secforge/inventories' 11 kinds, docs mapper-design.md §3) → {kind, detail}
// for one inventory.jsonl line. Additive: ENDPOINT/DATA_STORE are reused kinds; ROUTE/GRAPHQL/
// MODEL/TOKEN/INTEGRATION/PROCESS/AUTH_CHECK are new. Never touches the legacy ROLE/ACTOR/etc
// vocabulary above — identity stays exclusively legacyInventoryDetail's + the AI ontology's job.
function newSurfaceDetail(kind, row) {
  switch (kind) {
    case 'routes_endpoints': case 'rest_api': {
      const resolved = row.method && (row.route || row.path);
      return resolved
        ? { kind: 'ENDPOINT', detail: { method: row.method, route: row.route || row.path, interface_kind: kind === 'rest_api' ? 'rest' : 'web' } }
        : { kind: 'ROUTE', detail: { path: row.entry || row.path || null } };
    }
    case 'graphql':
      return (row.operation_type && row.field_name)
        ? { kind: 'ENDPOINT', detail: { operation_type: row.operation_type, field_name: row.field_name, interface_kind: 'graphql' } }
        : { kind: 'GRAPHQL', detail: { entry: row.entry || null } };
    case 'workers_jobs': return { kind: 'JOB', detail: { name: row.entry || null } };
    case 'services_finders_policies':
      if (row.detail === 'model') return { kind: 'MODEL', detail: { name: row.entry || null } };
      if (row.detail === 'policy') return { kind: 'AUTH_CHECK', detail: { kind: 'policy' } };
      return { kind: 'SERVICE', detail: { name: row.entry || null, kind: row.detail || 'service' } };
    case 'response_shaping': return { kind: 'SERVICE', detail: { name: row.entry || null, kind: 'serializer' } };
    case 'downloads_uploads_exports': case 'search_aggregation':
      return { kind: 'SERVICE', detail: { name: row.entry || null, kind: 'service' } };
    case 'tokens_actors':
      return row.detail === 'token'
        ? { kind: 'TOKEN', detail: { name: row.entry || null } }
        : { kind: 'AUTH_CHECK', detail: { kind: row.detail === 'permission' ? 'ability' : 'before_action' } };
    case 'processes_ipc': return { kind: 'PROCESS', detail: { name: row.entry || null } };
    case 'datastores_integrations':
      return row.detail === 'datastore' ? { kind: 'DATA_STORE', detail: { name: row.entry || null } } : { kind: 'INTEGRATION', detail: { name: row.entry || null } };
    default: return null;
  }
}
const NEW_SURFACE_KEYS = ['routes_endpoints', 'rest_api', 'graphql', 'workers_jobs', 'services_finders_policies',
  'response_shaping', 'downloads_uploads_exports', 'search_aggregation', 'tokens_actors', 'processes_ipc', 'datastores_integrations'];

// snapshots/<snapshotId>/inventory.jsonl — legacy identity rows (unchanged shape) + the new
// multi-language surface rows, additive. Same tmp+rename idiom as persistSnapshot()'s manifest write.
function persistInventory(store, projectId, snapshotId, legacyRows, inventories) {
  const dir = path.join(store.projectDir(projectId), 'snapshots', snapshotId);
  fs.mkdirSync(dir, { recursive: true });
  const fileAuth = buildFileAuth(legacyRows);
  const lines = legacyRows.map((row) => JSON.stringify({ kind: row.kind, file: row.file, line: row.line, detail: legacyInventoryDetail(row, fileAuth) }));
  for (const key of NEW_SURFACE_KEYS) for (const row of inventories[key] || []) {
    const mapped = newSurfaceDetail(key, row);
    if (mapped) lines.push(JSON.stringify({ kind: mapped.kind, file: row.file, line: row.line, detail: mapped.detail }));
  }
  const invFile = path.join(dir, 'inventory.jsonl');
  fs.writeFileSync(invFile + '.tmp', lines.join('\n') + (lines.length ? '\n' : ''));
  fs.renameSync(invFile + '.tmp', invFile);
}

// ---------- GraphQL schema-first → resolver correlation ----------
const JS_TS_RE = /\.(?:js|jsx|ts|tsx)$/i;
// A resolver-body ownership comparison ("context.user.X === / !== something", either order) — a
// real, common GraphQL resolver-guard shape that @secforge/inventories' keyword-based AUTH_DEF
// extraction doesn't recognize (it looks for named auth calls, not inline field comparisons).
const OWNERSHIP_CHECK_RE = /\bcontext\.user\.\w+\s*[!=]==?|[!=]==?\s*context\.user\.\w+/;

function braceSpan(lines, start) {
  let depth = (lines[start].match(/\{/g) || []).length - (lines[start].match(/\}/g) || []).length;
  if (depth <= 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth <= 0) return { startLine: start + 1, endLine: i + 1 };
  }
  return null;
}

// Bridge a schema-first GraphQL field (extracted from an SDL file with no code, no body span) to
// its resolver implementation, so §7 body-scoped auth attribution can see the resolver's own logic
// instead of the schema file it was extracted from. Two deterministic hops: the field's map entry
// ("expense: resolveExpenseQuery") -> the referenced identifier -> that identifier's definition
// site. Best-effort, never throws; an unresolved field is left exactly as extracted (schema-file
// claim, no body — the honest-negative fallback stays intact).
function correlateGraphqlResolvers(inventories, manifest, sourceRoot) {
  const codeFiles = manifest.filter((m) => JS_TS_RE.test(m.path));
  const textCache = new Map();
  const readText = (rel) => {
    if (textCache.has(rel)) return textCache.get(rel);
    let text = ''; try { text = fs.readFileSync(path.join(sourceRoot, rel), 'utf8'); } catch { /* unreadable */ }
    textCache.set(rel, text);
    return text;
  };
  for (const row of inventories.graphql || []) {
    if (row.detail !== 'graphql-sdl-field' || row.body || !row.field_name) continue;
    let identifier = null;
    for (const f of codeFiles) {
      const m = readText(f.path).match(new RegExp(`\\b${row.field_name}\\s*:\\s*(\\w+)\\s*,`));
      if (m) { identifier = m[1]; break; }
    }
    if (!identifier) continue;
    for (const f of codeFiles) {
      const lines = readText(f.path).split(/\r?\n/);
      const defRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${identifier}\\s*\\(|^(?:export\\s+)?const\\s+${identifier}\\s*=`);
      const idx = lines.findIndex((l) => defRe.test(l.trim()));
      if (idx === -1) continue;
      row.file = f.path; row.line = idx + 1;
      const span = braceSpan(lines, idx);
      if (span) {
        row.body = span;
        const bodyLines = lines.slice(span.startLine, span.endLine - 1);
        const hitIdx = bodyLines.findIndex((l) => OWNERSHIP_CHECK_RE.test(l));
        if (hitIdx !== -1) inventories.tokens_actors.push({ file: f.path, line: span.startLine + 1 + hitIdx, entry: 'context ownership check', detail: 'permission' });
      }
      break;
    }
  }
}

// Bridge the legacy regex table's ENDPOINT/SERVICE/JOB/DATA_STORE hits forward as additive rows on
// the new 11-key inventory — a safety net so the new multi-language pipeline is never LESS
// recall-complete than the deterministic engine already was (e.g. a generic `mongoose.model(...)`/
// `sequelize.define(...)` call, or any endpoint call the legacy regex table recognizes that
// @secforge/inventories' plugins/universal fallback do not). Skips an exact file:line:entry
// duplicate so a row already found by the new pipeline is never counted twice.
function bridgeLegacySurfaces(inventories, legacyRows) {
  const sigSet = (arr) => new Set(arr.map((r) => `${r.file}:${r.line}:${r.entry}`));
  const routeSigs = sigSet(inventories.routes_endpoints);
  const svcSigs = sigSet(inventories.services_finders_policies);
  const jobSigs = sigSet(inventories.workers_jobs);
  const addIfNew = (list, sigs, row) => { const sig = `${row.file}:${row.line}:${row.entry}`; if (!sigs.has(sig)) { sigs.add(sig); list.push(row); } };
  for (const row of legacyRows) {
    if (row.kind === 'ENDPOINT') {
      addIfNew(inventories.routes_endpoints, routeSigs, { file: row.file, line: row.line, entry: `${row.method} '${row.route}'`, method: row.method, route: row.route, detail: 'legacy-route' });
    } else if (row.kind === 'SERVICE') {
      addIfNew(inventories.services_finders_policies, svcSigs, { file: row.file, line: row.line, entry: row.name, detail: 'service' });
    } else if (row.kind === 'JOB') {
      addIfNew(inventories.workers_jobs, jobSigs, { file: row.file, line: row.line, entry: row.name, detail: 'worker' });
    } else if (row.kind === 'DATA_STORE') {
      addIfNew(inventories.services_finders_policies, svcSigs, { file: row.file, line: row.line, entry: row.name, detail: 'model' });
    }
  }
}

/**
 * Map a project into the knowledge graph: snapshot the source tree, extract a deterministic
 * multi-language inventory, cluster it into features, optionally enrich with an evidence-validated
 * AI ontology, and persist the resulting graph.
 *
 * `incremental` ('auto' | true | false): 'auto' (default) and `true` attempt Phase C's diff-remap
 * whenever a prior snapshot exists and every eligibility guard passes — re-mapping only the
 * features a code change touched and reusing prior AI work + frozen source for the rest, else
 * degrading transparently to a full map. `false` always takes today's full-map path, verbatim.
 * `onClusters` (optional): `async (clusters, {engine,model,effort}) => clusters`, run right after
 * clustering, before AI-semantic/buildGraph, so an orchestrator can consolidate them (must return
 * the same shape). Omitted, behavior is unchanged.
 * @returns {Promise<{status:string, snapshotId:string, features:Array, coverage:object, nodeCount:number, edgeCount:number, incremental:boolean, remappedFeatures:string[], reusedFeatures:string[], changedFiles:string[]}>}
 */
export async function mapProject({ sourceRoot, store, projectId, onProgress, onClusters, engine = 'rules', model = null, effort, incremental = 'auto' } = {}) {
  if (!sourceRoot || !store || !projectId) throw new Error('mapProject requires sourceRoot, store, projectId');
  // Refuse to "map" a path that isn't a real directory — otherwise walk() swallows the readdir
  // error and returns status:MAPPED with 0 nodes, and the UI fabricates a graph for a repo that
  // is not on disk (S1-6).
  const resolvedRoot = path.resolve(sourceRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    return { status: 'ERROR', error: 'refusing to map a filesystem root', sourceRoot, features: [], coverage: { technical: 0, semantic: 0 }, nodeCount: 0, edgeCount: 0 };
  }
  let _st; try { _st = fs.statSync(sourceRoot); } catch { _st = null; }
  if (!_st || !_st.isDirectory()) {
    return { status: 'ERROR', error: 'source path does not exist or is not a directory', sourceRoot, features: [], coverage: { technical: 0, semantic: 0 }, nodeCount: 0, edgeCount: 0 };
  }

  // Phase C guards #1/#3/#4, decided before the freeze-forward optimization below; guard #2
  // (clustering threshold) is checked in remapGraph() once the inventory row count is known.
  const eligibility = await checkIncrementalEligibility(store, projectId, incremental);
  const attemptIncremental = eligibility.attempt;
  let remapReason = eligibility.reason;

  onProgress?.({ phase: 'snapshot', pct: 0 });
  // Build-then-rename (mirrors codengram's ingestion/index.js:139-142): snapshotId is only known
  // AFTER the walk (it's a hash of the manifest), so we can't write straight into
  // snapshots/<snapshotId>/ — build into a private tmp dir under snapshots/ first.
  const tmpDir = path.join(store.projectDir(projectId), 'snapshots', `.building-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const forward = attemptIncremental ? { priorManifestMap: eligibility.priorManifestMap, priorSourceDir: eligibility.priorSourceDir } : null;
  const { manifest, truncated } = await buildManifestAndFreeze(sourceRoot, tmpDir, forward);
  // O-2: never report a successful map of a tree we read nothing from. An empty manifest is only
  // honest for a genuinely empty directory; if the root has entries we couldn't read (permissions)
  // or nothing we could inventory, that is an ERROR — not "MAPPED · 0 findings" reading as clean.
  if (manifest.length === 0) {
    let entries; try { entries = await fsp.readdir(sourceRoot); } catch { entries = null; }
    const err = entries === null ? 'source directory is not readable (permission denied)'
      : entries.length > 0 ? 'read 0 files from a non-empty directory — check read permissions or that it contains supported source files' : null;
    if (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true }); // orphaned empty tmp dir, never left behind
      return { status: 'ERROR', error: err, sourceRoot, features: [], coverage: { technical: 0, semantic: 0 }, nodeCount: 0, edgeCount: 0 };
    }
  }
  const snapshotId = hashManifest(manifest);
  const snapshotDir = path.join(store.projectDir(projectId), 'snapshots', snapshotId);
  if (fs.existsSync(path.join(snapshotDir, 'source'))) {
    // Content-addressed dedup: identical source already frozen under this snapshotId — one-line
    // version of codengram's existing.source_frozen dedup (ingestion/index.js:156). ponytail: this
    // directory-exists check is the whole optimization; no need for a snapshot.json pre-read too.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    fs.renameSync(tmpDir, snapshotDir); // atomic — the directory appears fully-formed
  }
  persistSnapshot(store, projectId, snapshotId, manifest);
  onProgress?.({ phase: 'snapshot', pct: 25 });

  onProgress?.({ phase: 'inventory', pct: 30 });
  const profileFiles = manifest.map((m) => ({ path: m.path, bytes: m.bytes, ext: path.extname(m.path).toLowerCase() }));
  const profile = profileRepo(sourceRoot, { files: profileFiles });
  const inventories = extractInventories({ sourceRoot, profile });
  // Rails `resources :x` synthesis (config/routes.rb has no method+path of its own) + bridging a
  // schema-first GraphQL field to its resolver's actual file/body — both additive, merged BEFORE
  // clustering so the rule engine can score them like any other resolved endpoint.
  inventories.routes_endpoints.push(...synthesizeRailsRoutes({ manifest, sourceRoot, inventories }));
  correlateGraphqlResolvers(inventories, manifest, sourceRoot);

  const legacyRows = [];
  for (const m of manifest) legacyRows.push(...await scanFile(sourceRoot, m.path));
  bridgeLegacySurfaces(inventories, legacyRows);
  persistInventory(store, projectId, snapshotId, legacyRows, inventories);
  onProgress?.({ phase: 'inventory', pct: 50 });

  onProgress?.({ phase: 'features', pct: 55 });
  const rawClusters = deterministicSemanticPlan(inventories);

  // Phase D seam: orchestrator hook to consolidate clusters before AI-semantic/buildGraph see them.
  onProgress?.({ phase: 'consolidate', pct: 60 });
  const clusters = onClusters ? await onClusters(rawClusters, { engine, model, effort }) : rawClusters;

  // remapGraph() (incremental.js) owns the rest of Phase C: guard #2, incremental AI-plan reuse
  // vs a full fresh derivation, the one buildGraph() call, and the lossless self-check + fallback.
  onProgress?.({ phase: 'semantic', pct: 65 });
  const featureRowCount = inventoryRows(inventories).length;
  // The Lead and the evidence validator both work on the FROZEN copy (snapshots/<sid>/source), so a
  // citation is proven against exactly the bytes the Lead read — never the live, possibly-moved-on tree.
  const frozenDir = path.join(snapshotDir, 'source');
  const readSnapshotFile = (rel) => {
    try { return fs.readFileSync(path.join(frozenDir, rel), 'utf8'); } catch { /* not frozen (file skipped by caps) */ }
    try { return fs.readFileSync(path.join(sourceRoot, rel), 'utf8'); } catch { return ''; }
  };
  const leadCtx = {
    cwd: frozenDir, profile, inventories, checkpointDir: path.join(snapshotDir, 'lead'),
    onEvent: (e) => onProgress?.({ phase: 'semantic', pct: 65, lead: e }),
  };
  const { graph, ontology, incrementalUsed, remapReason: finalRemapReason, reusedFeatureIds, llmCalled, ontologyReusedCount, diff, lead } =
    await remapGraph({
      store, projectId, snapshotId, manifest, eligibility, featureRowCount, clusters, inventories, legacyRows,
      project: { id: projectId, name: projectName(store, projectId) }, engine, model, effort, readSnapshotFile, ctx: leadCtx,
    });
  remapReason = finalRemapReason;

  onProgress?.({ phase: 'persist', pct: 90 });
  persistFeatureRowCount(store, projectId, snapshotId, featureRowCount);
  if (ontology) persistOntologyPlan(store, projectId, snapshotId, ontology);
  // Lead provenance travels with the snapshot: written when a Lead ran this time; when a prior
  // ontology was REUSED (incremental / rules-only reopen) the stored record is surfaced as `reused`.
  let leadOut = lead || null;
  const leadFile = path.join(snapshotDir, 'lead.json');
  if (lead) { try { fs.writeFileSync(leadFile, JSON.stringify({ ...lead, at: new Date().toISOString() }, null, 2)); } catch { /* best effort */ } }
  else if (ontology) { try { leadOut = { ...JSON.parse(fs.readFileSync(leadFile, 'utf8')), reused: true }; } catch { /* no stored provenance */ } }
  await writeNodes(store, projectId, graph.nodes, { snapshotId });
  await writeEdges(store, projectId, graph.edges, { snapshotId });
  await writeReconciliation(store, projectId, graph.reconciliation, { snapshotId });
  // The portable phase1-maps bundle — a pure projection of the graph just persisted (features/,
  // roles/, ledgers/, consolidated/, graph/). Best-effort: a render failure never fails the map.
  let maps = null;
  try {
    const r = renderPhase1Maps({
      graph, reconciliation: graph.reconciliation, inventories, features: graph.features,
      project: { id: projectId, name: projectName(store, projectId), sourceRoot }, snapshotId, coverage: graph.coverage,
      provenance: { engine, model, llmCalled, aiSemantic: !!ontology, leadSessionId: leadOut?.sessionId || null, leadTurns: leadOut?.turns ?? null, accepted: leadOut?.accepted || null, rejected: leadOut?.rejected ?? null, leadReused: !!leadOut?.reused },
      outDir: snapshotDir,
    });
    maps = { root: r.root, files: r.files.length };
  } catch (err) { maps = { root: null, files: 0, error: String(err?.message || err) }; }
  // The snapshot's small retrieval store (`rag/`): one chunk per feature / entry point / role /
  // permission with file:line pointers, so a later "test X" (Assess prompt, GET /locate, or an agent
  // grepping the folder) knows where to look. Pure projection of the graph above; best-effort.
  let rag = null;
  try { rag = writeRagIndex(snapshotDir, graph, { snapshotId }); } catch (err) { rag = { root: null, files: 0, chunks: 0, error: String(err?.message || err) }; }
  await store.appendEvent(projectId, { type: 'map.completed', features: graph.features.length, maps: maps.files, rag: rag.chunks });
  onProgress?.({ phase: 'persist', pct: 100 });

  const meta = inventoryMeta(inventories);
  const technical = meta.source_code_files ? Math.round((meta.represented_source_files / meta.source_code_files) * 100) / 100 : 0;
  // coverage.semantic mirrors mapper-design.md §4: real only once an AI ontology was actually
  // accepted; rules-only (or every AI entity rejected by evidence-validator) stays honestly 0 —
  // that in no way implies zero FEATURE nodes (see buildGraph's own fail-closed comment above).
  const semantic = ontology ? graph.coverage.semantic_coverage / 100 : 0;

  // Every reported FEATURE id that isn't reused — dirty or brand new — computed post-hoc from the
  // actual graph, not trusted from the plan (buildGraph is the source of truth for this run's ids).
  const remappedFeatures = [...new Set(
    graph.reconciliation.filter((r) => r.status === 'MAPPED_TO_FEATURE' && r.feature_id && !reusedFeatureIds.includes(r.feature_id)).map((r) => r.feature_id),
  )];

  return {
    status: 'MAPPED',
    snapshotId,
    features: graph.features,
    truncated, // true if the tree hit MAX_FILES / byte budget and was only partially mapped
    coverage: { technical, semantic },
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    engineUsed: engine,
    aiSemantic: !!ontology,
    // Phase C — additive incremental-remap report; `remapReason` explains a false `incremental`
    // (first map, an ineligible guard, or a self-check mismatch).
    incremental: incrementalUsed,
    remapReason,
    remappedFeatures,
    reusedFeatures: incrementalUsed ? reusedFeatureIds : [],
    changedFiles: diff ? diff.changed : [],
    addedFiles: diff ? diff.added : [],
    deletedFiles: diff ? diff.deleted : [],
    llmCalled,
    ontologyReusedCount,
    lead: leadOut, // agentic Lead provenance (engine/model/turns/sessionId/accepted/rejected; reused:true when a stored ontology was kept), null when one-shot or rules-only
    maps, // { root, files } of the phase1-maps bundle written for this snapshot (files:0 + error when the render failed)
    rag, // { root, files, chunks } of the snapshot's retrieval store (chunks:0 + error when the write failed)
  };
}

export async function featureGraph(store, projectId, featureId) {
  return neighbourhood(store, projectId, featureId);
}

export { renderPhase1Maps, renderFeatureDoc } from './phase1-maps.js';
