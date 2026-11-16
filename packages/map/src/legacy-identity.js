// @secforge/map/legacy-identity — SecForge's own line-regex identity + surface extraction, kept
// alongside the @secforge/inventories pipeline as a recall safety net: ENDPOINT/SERVICE/JOB/DATA_STORE
// hits are bridged forward (bridgeLegacySurfaces in index.js), and the ROLE/ACTOR/PERMISSION/
// ROLE_CHECK/ROLE_GRANTS vocabulary is SecForge's honest, declared-only role model (docs/PHASE1-ROLES-
// INVENTORY-DESIGN.md §1). Pure line scanning over the snapshot; no LLM, no graph.
import fs from 'node:fs';
import path from 'node:path';

const fsp = fs.promises;

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

export async function scanFile(sourceRoot, rel) {
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
export function buildFileAuth(rows) {
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
export function legacyInventoryDetail(row, fileAuth) {
  switch (row.kind) {
    case 'ENDPOINT': return { method: row.method, route: row.route, guarded: fileAuth.has(row.file) };
    case 'SERVICE': case 'JOB': case 'DATA_STORE': case 'ROLE': case 'ACTOR': return { name: row.name };
    case 'PERMISSION': return { action: row.action, resource: row.resource || null };
    case 'ROLE_CHECK': return { role: row.role };
    case 'ROLE_GRANTS': return { role: row.role, action: row.action, resource: row.resource || null };
    default: return {};
  }
}

