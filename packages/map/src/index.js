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
import { deterministicSemanticPlan, buildGraph, makeEvidenceVerifier, validateOntology, planClusters } from '@secforge/recon';
import { getAdapter } from '@secforge/adapters';
import { synthesizeRailsRoutes } from './rails-routes.js';

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
async function buildManifestAndFreeze(sourceRoot, tmpDir) {
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
    manifest.push({ path: rel, bytes: stat.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    const dest = path.join(srcOut, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf); // freeze exactly what we hashed
  }
  return { manifest, truncated: truncatedFiles || total >= MAX_TOTAL_BYTES };
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
  fs.writeFileSync(snapFile + '.tmp', JSON.stringify({ content_hash: snapshotId, file_count: manifest.length, bytes, source_frozen: true }, null, 2));
  fs.renameSync(snapFile + '.tmp', snapFile);
}

// Read a file from the frozen snapshot's source tree (never re-derives from anywhere else — the
// manifest already pinned which files/bytes belong to this snapshot). Missing/unreadable → ''.
function readSnapshotFile(sourceRoot, rel) {
  try { return fs.readFileSync(path.join(sourceRoot, rel), 'utf8'); } catch { return ''; }
}

// ---------- LEGACY DETERMINISTIC IDENTITY (unchanged) ----------
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

// Auth guards (heuristic, language-agnostic). AUTHN = "who are you", AUTHZ = "may you".
const AUTHN_RE = /before_action\s+:authenticate|authenticate_user!?|\blogin_required\b|requires?_login|requireAuth|ensureAuthenticated|isAuthenticated|passport\.authenticate|@login_required|@requires_auth|\[Authorize\]|verify(?:_?token|Token)|AuthGuard/i;
const AUTHZ_RE = /\bauthorize!?\b|\bcan\?|\bpolicy\b|\bowns?_|\bowner\b|current_user\.\w+\.(?:find|where)|@PreAuthorize|\bPundit\b|authorize_resource|cancancan/i;

// ---------- ACTOR / ROLE / PERMISSION (docs/PHASE1-ROLES-INVENTORY-DESIGN.md §1) ----------
// ROLE — declared role vocabulary (constants/enums/config arrays). Can yield several names per line.
function matchRoles(line) {
  let m = /\benum\s+role:\s*\{([^}]+)\}/i.exec(line);               // Rails: enum role: { admin: 0, editor: 1 }
  if (m) return [...m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]);
  m = /\benum\s+Role\b[^{]*\{([^}]+)\}/.exec(line);                  // Java/TS: enum Role { ADMIN, EDITOR }
  if (m) return m[1].split(',').map((s) => s.trim().split(/[=\s(]/)[0]).filter(Boolean);
  m = /\bROLE_([A-Z][A-Z0-9_]*)\s*[:=]/.exec(line);                  // ROLE_ADMIN = ...
  if (m) return [m[1]];
  m = /\broles?\s*[:=]\s*\[([^\]]+)\]/i.exec(line);                  // roles: ['admin','editor'] / ROLES = [...]
  if (m) return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  return [];
}

// PERMISSION — ability vocabulary declared at a call site.
function matchPermission(line) {
  let m = /\bcan\s+(:\w+|\[[^\]]+\])\s*,\s*([A-Za-z0-9_:]+)/.exec(line); // CanCanCan: can :read, Project
  if (m) return { action: m[1].replace(/[:\[\]\s]/g, ''), resource: m[2] };
  m = /hasAuthority\(\s*['"]([\w:-]+)['"]\s*\)/i.exec(line);            // Spring: hasAuthority('EDIT_POST')
  if (m) return { action: m[1], resource: null };
  m = /Gate::define\(\s*['"]([\w-]+)['"]/i.exec(line);                  // Laravel: Gate::define('update-post', ...)
  if (m) return { action: m[1], resource: null };
  m = /permission_required\(\s*['"]([\w.]+)['"]/i.exec(line);           // Django: permission_required('app.can_edit')
  if (m) return { action: m[1], resource: null };
  return null;
}

// ROLE_CHECK — an authz decision that NAMES a role (first match wins).
function matchRoleCheck(line) {
  let m = /\b(?:requireRole|hasRole|has_role\?|is_role\?)\s*\(\s*['"]([\w-]+)['"]/i.exec(line);
  if (m) return m[1];
  m = /@Roles\(\s*\{?\s*['"]([\w-]+)['"]/i.exec(line);                  // NestJS/Spring decorator
  if (m) return m[1];
  m = /current_user\.(\w+)\?/.exec(line);                               // Rails idiom: current_user.admin?
  if (m) return m[1];
  m = /\brole\?\(\s*:(\w+)\s*\)/.exec(line);                            // role?(:admin)
  if (m) return m[1];
  return null;
}

// ACTOR — the auth-user model. Curated, honest, conservative: a data-store-shaped class whose
// name is a known actor noun, OR any class carrying a devise call / role association — the
// association line is tracked separately (`assoc`) so buildGraph's multi-actor HAS_ROLE gating
// (§1.3) can tell "this class's role association was literally seen" from "just uses devise".
const ACTOR_NOUN_RE = /^(User|Account|Member|Admin|Customer|Employee|Staff|Actor|Person)$/;
const ACTOR_ROLE_ASSOC_RE = /has_(?:and_belongs_to_)?many\s+:roles\b|belongs_to\s+:role\b|has_one\s+:role\b/;
const ACTOR_SIGNAL_RE = new RegExp(`\\bdevise\\s*:|${ACTOR_ROLE_ASSOC_RE.source}`);

async function scanFile(sourceRoot, rel) {
  let text;
  try { text = await fsp.readFile(path.join(sourceRoot, rel), 'utf8'); } catch { return []; }
  const rows = [];
  const lines = text.split(/\r?\n/);
  let lastClass = null; // {name, line} — nearest preceding class-def line, for ACTOR signal attribution
  const actorRowsByName = new Map(); // one ACTOR row per class name per file; `assoc` can upgrade in place
  const noteActor = (name, line, assocSignal) => {
    let row = actorRowsByName.get(name);
    if (!row) {
      row = { kind: 'ACTOR', file: rel, line, name, assoc: !!assocSignal };
      actorRowsByName.set(name, row);
      rows.push(row);
    } else if (assocSignal) row.assoc = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (AUTHN_RE.test(line)) rows.push({ kind: 'AUTHN', file: rel, line: i + 1 });
    if (AUTHZ_RE.test(line)) rows.push({ kind: 'AUTHZ', file: rel, line: i + 1 });

    for (const name of matchRoles(line)) rows.push({ kind: 'ROLE', file: rel, line: i + 1, name });

    // PERMISSION + ROLE_CHECK are independent; co-occurrence on the SAME line is the only
    // ROLE_GRANTS evidence this engine trusts (§1.4 — no cross-line wiring, by design).
    const permission = matchPermission(line);
    const roleCheck = matchRoleCheck(line);
    if (permission) rows.push({ kind: 'PERMISSION', file: rel, line: i + 1, action: permission.action, resource: permission.resource });
    if (roleCheck) rows.push({ kind: 'ROLE_CHECK', file: rel, line: i + 1, role: roleCheck });
    if (permission && roleCheck) {
      rows.push({ kind: 'ROLE_GRANTS', file: rel, line: i + 1, role: roleCheck, action: permission.action, resource: permission.resource });
    }

    // Track the enclosing class on ANY class-decl line (Ruby `class X` / `class X < Y`, JS
    // `class X extends Y`, Python `class X(Base):`) — not just the data-store-shaped subset
    // matchDataStore recognizes. Otherwise a devise/:roles signal inside a later, non-model class
    // stays attributed to an earlier, unrelated model class (FIX 2 — misattributed actor).
    const classDecl = /\bclass\s+([A-Za-z0-9_]+)/.exec(line);
    if (classDecl) lastClass = { name: classDecl[1], line: i + 1 };

    const ds = matchDataStore(line); // narrower data-store shape — also the ACTOR-noun signal
    if (ds && ACTOR_NOUN_RE.test(ds)) noteActor(ds, i + 1, false);
    if (lastClass && ACTOR_SIGNAL_RE.test(line)) noteActor(lastClass.name, lastClass.line, ACTOR_ROLE_ASSOC_RE.test(line));

    const ep = matchEndpoint(line);
    if (ep) { rows.push({ kind: 'ENDPOINT', file: rel, line: i + 1, method: ep.method, route: ep.route }); continue; }
    const svc = matchService(line);
    if (svc) { rows.push({ kind: 'SERVICE', file: rel, line: i + 1, name: svc }); continue; }
    const job = matchJob(line);
    if (job) { rows.push({ kind: 'JOB', file: rel, line: i + 1, name: job }); continue; }
    if (ds) { rows.push({ kind: 'DATA_STORE', file: rel, line: i + 1, name: ds }); continue; }
  }
  return rows;
}

// Per-file auth signals — an endpoint inherits its file's guards (before_action etc. are file-level).
function buildFileAuth(rows) {
  const fileAuth = new Map();
  for (const row of rows) {
    if (row.kind !== 'AUTHN' && row.kind !== 'AUTHZ') continue;
    const fa = fileAuth.get(row.file) || {};
    if (row.kind === 'AUTHN' && fa.authn == null) fa.authn = row.line;
    if (row.kind === 'AUTHZ' && fa.authz == null) fa.authz = row.line;
    fileAuth.set(row.file, fa);
  }
  return fileAuth;
}

// Per-kind extra fields for one legacy inventory.jsonl row (docs/PHASE1-ROLES-INVENTORY-DESIGN.md §2.2).
function legacyInventoryDetail(row, fileAuth) {
  switch (row.kind) {
    case 'ENDPOINT': return { method: row.method, route: row.route, guarded: fileAuth.has(row.file) };
    case 'SERVICE': case 'JOB': case 'DATA_STORE': case 'ROLE': case 'ACTOR': return { name: row.name };
    case 'PERMISSION': return { action: row.action, resource: row.resource || null };
    case 'ROLE_CHECK': return { role: row.role };
    case 'ROLE_GRANTS': return { role: row.role, action: row.action, resource: row.resource || null };
    default: return {};
  }
}

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
 * @returns {Promise<{status:string, snapshotId:string, features:Array, coverage:object, nodeCount:number, edgeCount:number}>}
 */
export async function mapProject({ sourceRoot, store, projectId, onProgress, engine = 'rules', model = null, effort } = {}) {
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

  onProgress?.({ phase: 'snapshot', pct: 0 });
  // Build-then-rename (mirrors codengram's ingestion/index.js:139-142): snapshotId is only known
  // AFTER the walk (it's a hash of the manifest), so we can't write straight into
  // snapshots/<snapshotId>/ — build into a private tmp dir under snapshots/ first.
  const tmpDir = path.join(store.projectDir(projectId), 'snapshots', `.building-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const { manifest, truncated } = await buildManifestAndFreeze(sourceRoot, tmpDir);
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
  const clusters = deterministicSemanticPlan(inventories);

  let ontology = null;
  if (engine && engine !== 'rules') {
    onProgress?.({ phase: 'semantic', pct: 65 });
    const adapter = getAdapter(engine);
    const raw = await planClusters(clusters, adapter, { model, effort });
    if (raw) {
      const verifier = makeEvidenceVerifier({ readSource: (rel) => readSnapshotFile(sourceRoot, rel) });
      const { ontology: validated, accepted } = validateOntology(raw, verifier);
      // accepted.features === 0 → fail closed silently: ontology stays null, deterministic
      // clusters still become FEATURE nodes on their own (never demoted to ARCH_CLUSTER-only).
      if (accepted.features > 0) ontology = validated;
    }
  }

  onProgress?.({ phase: 'graph', pct: 80 });
  const graph = buildGraph({ inventories, clusters, ontology, legacyRows, project: { id: projectId, name: projectId }, snapshotId });

  onProgress?.({ phase: 'persist', pct: 90 });
  await writeNodes(store, projectId, graph.nodes, { snapshotId });
  await writeEdges(store, projectId, graph.edges, { snapshotId });
  await writeReconciliation(store, projectId, graph.reconciliation, { snapshotId });
  await store.appendEvent(projectId, { type: 'map.completed', features: graph.features.length });
  onProgress?.({ phase: 'persist', pct: 100 });

  const meta = inventoryMeta(inventories);
  const technical = meta.source_code_files ? Math.round((meta.represented_source_files / meta.source_code_files) * 100) / 100 : 0;
  // coverage.semantic mirrors mapper-design.md §4: real only once an AI ontology was actually
  // accepted; rules-only (or every AI entity rejected by evidence-validator) stays honestly 0 —
  // that in no way implies zero FEATURE nodes (see buildGraph's own fail-closed comment above).
  const semantic = ontology ? graph.coverage.semantic_coverage / 100 : 0;

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
  };
}

export async function featureGraph(store, projectId, featureId) {
  return neighbourhood(store, projectId, featureId);
}
