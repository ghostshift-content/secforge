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

const fsp = fs.promises;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'vendor', 'build', 'coverage', '.next', 'out']);
const MAX_BYTES = 1_000_000; // ponytail: flat cap, not a size histogram — raise if real repos need it
// Bounds so mapping a huge (or root) tree can't hang the single-threaded server. P0-1.
const MAX_FILES = 25_000;
const MAX_DEPTH = 24;
const MAX_TOTAL_BYTES = 500_000_000; // 500MB read budget across the whole manifest
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

async function buildManifest(sourceRoot) {
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

// ---------- FEATURES: cluster inventory rows by their own directory structure ----------
const moduleDirOf = (rel) => { const d = path.dirname(rel); return d === '.' ? 'root' : d; };

// Per-file auth signals — an endpoint inherits its file's guards (before_action etc. are file-level).
function buildFileAuth(inventory) {
  const fileAuth = new Map();
  for (const row of inventory) {
    if (row.kind !== 'AUTHN' && row.kind !== 'AUTHZ') continue;
    const fa = fileAuth.get(row.file) || {};
    if (row.kind === 'AUTHN' && fa.authn == null) fa.authn = row.line;
    if (row.kind === 'AUTHZ' && fa.authz == null) fa.authz = row.line;
    fileAuth.set(row.file, fa);
  }
  return fileAuth;
}

// Per-kind extra fields for one inventory.jsonl row (docs/PHASE1-ROLES-INVENTORY-DESIGN.md §2.2).
// `guarded` on ENDPOINT rows is the one derived field — cheap because fileAuth is already built.
function inventoryDetail(row, fileAuth) {
  switch (row.kind) {
    case 'ENDPOINT': return { method: row.method, route: row.route, guarded: fileAuth.has(row.file) };
    case 'SERVICE': case 'JOB': case 'DATA_STORE': case 'ROLE': case 'ACTOR': return { name: row.name };
    case 'PERMISSION': return { action: row.action, resource: row.resource || null };
    case 'ROLE_CHECK': return { role: row.role };
    case 'ROLE_GRANTS': return { role: row.role, action: row.action, resource: row.resource || null };
    default: return {};
  }
}

// snapshots/<snapshotId>/inventory.jsonl — the full per-line inventory, otherwise thrown away
// once buildGraph() consumes it. Same tmp+rename idiom as persistSnapshot()'s manifest write.
function persistInventory(store, projectId, snapshotId, inventory) {
  const dir = path.join(store.projectDir(projectId), 'snapshots', snapshotId);
  fs.mkdirSync(dir, { recursive: true });
  const fileAuth = buildFileAuth(inventory);
  const lines = inventory.map((row) => JSON.stringify({ kind: row.kind, file: row.file, line: row.line, detail: inventoryDetail(row, fileAuth) }));
  const invFile = path.join(dir, 'inventory.jsonl');
  fs.writeFileSync(invFile + '.tmp', lines.join('\n') + (lines.length ? '\n' : ''));
  fs.renameSync(invFile + '.tmp', invFile);
}

function buildGraph(inventory) {
  const nodes = new Map();
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, n); };
  const edges = [];
  const edgeIds = new Set();
  const addEdge = (id, type, src, dst) => { if (!edgeIds.has(id)) { edgeIds.add(id); edges.push({ id, type, src, dst }); } };

  const fileAuth = buildFileAuth(inventory);

  // Per-file role-check signals — an endpoint checked by hasRole('x') in the same file REQUIRES_ROLE x.
  const fileRoles = new Map();
  for (const row of inventory) {
    if (row.kind !== 'ROLE_CHECK') continue;
    const roles = fileRoles.get(row.file) || new Map();
    if (!roles.has(row.role)) roles.set(row.role, row.line);
    fileRoles.set(row.file, roles);
  }

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
        const fa = fileAuth.get(row.file);
        if (fa && fa.authn != null) {
          const acId = `authcheck:authn:${slugify(row.file)}`;
          addNode({ id: acId, type: 'AUTH_CHECK', name: 'authenticate', data: { kind: 'authentication' }, claims: [{ file: row.file, line: fa.authn, method: 'grep', confidence: 'medium' }] });
          addEdge(`edge:${id}:AUTHENTICATED_BY:${acId}`, 'AUTHENTICATED_BY', id, acId);
        }
        if (fa && fa.authz != null) {
          const acId = `authcheck:authz:${slugify(row.file)}`;
          addNode({ id: acId, type: 'AUTH_CHECK', name: 'authorize', data: { kind: 'authorization' }, claims: [{ file: row.file, line: fa.authz, method: 'grep', confidence: 'medium' }] });
          addEdge(`edge:${id}:AUTHORIZED_BY:${acId}`, 'AUTHORIZED_BY', id, acId);
        }
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
      } else if (row.kind === 'ROLE') {
        const id = ID.role(row.name);
        addNode({ id, type: 'ROLE', name: row.name, data: { name: row.name }, claims: [claim] });
      } else if (row.kind === 'ACTOR') {
        const id = ID.actor(row.name);
        addNode({ id, type: 'ACTOR', name: row.name, data: { name: row.name }, claims: [claim] });
      } else if (row.kind === 'PERMISSION') {
        const id = ID.permission(row.action, row.resource);
        addNode({ id, type: 'PERMISSION', name: row.resource ? `${row.action}:${row.resource}` : row.action, data: { action: row.action, resource: row.resource || null }, claims: [claim] });
      }
    }
    features.push({ id: featureId, name: dir, slug: slugify(dir), counts });
  }

  // ENDPOINT --REQUIRES_ROLE--> ROLE: only when the named role was actually DECLARED as a ROLE
  // node (the extracted role vocabulary). A role CHECK can name something that merely LOOKS like
  // a role — matchRoleCheck's `current_user.x?` idiom matches any boolean predicate
  // (current_user.confirmed?/.active?/...), not just roles — so gate on "a ROLE node with this id
  // exists", never on "a check matched", or an undeclared name fabricates a relationship the
  // source never showed (honest-coverage principle, not an enumeration of non-role predicates).
  // Run as its own pass (not inside the cluster loop above) so it doesn't depend on directory
  // processing order — the ROLE node may live in a directory clustered after the endpoint's.
  for (const row of inventory) {
    if (row.kind !== 'ENDPOINT') continue;
    const roleChecks = fileRoles.get(row.file);
    if (!roleChecks) continue;
    const endpointId = ID.endpoint(row.method, row.route);
    for (const roleName of roleChecks.keys()) {
      const roleId = ID.role(roleName);
      if (!nodes.has(roleId)) continue; // honest miss: role never declared as vocabulary
      addEdge(`edge:${endpointId}:REQUIRES_ROLE:${roleId}`, 'REQUIRES_ROLE', endpointId, roleId);
    }
  }

  // ROLE --GRANTS--> PERMISSION: same-line co-occurrence only (§1.4 — no cross-line wiring), and
  // same "ROLE must be declared" gate as REQUIRES_ROLE above — a ROLE_GRANTS row's role side comes
  // from the same non-vocabulary-checked matchRoleCheck, so it needs the identical honesty guard.
  for (const row of inventory) {
    if (row.kind !== 'ROLE_GRANTS') continue;
    const roleId = ID.role(row.role);
    if (!nodes.has(roleId)) continue; // honest miss: role never declared as vocabulary
    const permId = ID.permission(row.action, row.resource);
    addEdge(`edge:${roleId}:GRANTS:${permId}`, 'GRANTS', roleId, permId);
  }

  // ACTOR --HAS_ROLE--> ROLE (§1.3): a single actor project-wide inherits every declared role;
  // with multiple actors, only ones with an observed role-association line get linked, and only
  // to the full role set (a line-level "this actor has THIS role" signal doesn't exist statically).
  const actorNodes = [...nodes.values()].filter((n) => n.type === 'ACTOR');
  const roleNodes = [...nodes.values()].filter((n) => n.type === 'ROLE');
  if (roleNodes.length) {
    if (actorNodes.length === 1) {
      for (const r of roleNodes) addEdge(`edge:${actorNodes[0].id}:HAS_ROLE:${r.id}`, 'HAS_ROLE', actorNodes[0].id, r.id);
    } else if (actorNodes.length > 1) {
      const assocActorNames = new Set(inventory.filter((r) => r.kind === 'ACTOR' && r.assoc).map((r) => r.name));
      for (const a of actorNodes) {
        if (!assocActorNames.has(a.name)) continue;
        for (const r of roleNodes) addEdge(`edge:${a.id}:HAS_ROLE:${r.id}`, 'HAS_ROLE', a.id, r.id);
      }
    }
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
  const { manifest, truncated } = await buildManifest(sourceRoot);
  // O-2: never report a successful map of a tree we read nothing from. An empty manifest is only
  // honest for a genuinely empty directory; if the root has entries we couldn't read (permissions)
  // or nothing we could inventory, that is an ERROR — not "MAPPED · 0 findings" reading as clean.
  if (manifest.length === 0) {
    let entries; try { entries = await fsp.readdir(sourceRoot); } catch { entries = null; }
    if (entries === null) {
      return { status: 'ERROR', error: 'source directory is not readable (permission denied)', sourceRoot, features: [], coverage: { technical: 0, semantic: 0 }, nodeCount: 0, edgeCount: 0 };
    }
    if (entries.length > 0) {
      return { status: 'ERROR', error: 'read 0 files from a non-empty directory — check read permissions or that it contains supported source files', sourceRoot, features: [], coverage: { technical: 0, semantic: 0 }, nodeCount: 0, edgeCount: 0 };
    }
  }
  const snapshotId = hashManifest(manifest);
  persistSnapshot(store, projectId, snapshotId, manifest);
  onProgress?.({ phase: 'snapshot', pct: 25 });

  onProgress?.({ phase: 'inventory', pct: 25 });
  const inventory = [];
  for (const m of manifest) inventory.push(...await scanFile(sourceRoot, m.path));
  persistInventory(store, projectId, snapshotId, inventory);
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
    truncated, // true if the tree hit MAX_FILES / byte budget and was only partially mapped
    coverage: { technical, semantic: 0 }, // ponytail: semantic/LLM coverage lands with the AI mapping pass
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export async function featureGraph(store, projectId, featureId) {
  return neighbourhood(store, projectId, featureId);
}
