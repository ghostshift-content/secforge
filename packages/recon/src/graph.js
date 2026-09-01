// @secforge/recon/graph — builds SecForge's knowledge graph (nodes/edges in @secforge/store's exact
// row shape) from codengram-style inventory rows. Ported + adapted from
// codengram-master/packages/recon/index.js (nodeForRow/buildGraph/buildInfra/buildArchitecture/
// reconcileAndGate). Zero deps, stdlib-only.
import { ID } from '@secforge/schemas';
import { deterministicSemanticPlan, validateLeadPlan, INVENTORY_KEYS, INFRA_KINDS, slug } from './semantic-planner.js';

const titleize = (s) => String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const claim = (file, line, method = 'grep', confidence = 'medium') => ({ file, line: line || 1, method, confidence });

// ── reconciliation coverage ledger (Phase A §2) ──────────────────────────────────────────────
// A short human label for a reconciliation row's `entry` field — best-effort, display only.
function reconLabel(row) {
  if (row.entry != null) return String(row.entry).slice(0, 120);
  if (row.name != null) return String(row.name).slice(0, 120);
  if (row.route != null) return `${row.method || ''} ${row.route}`.trim();
  if (row.role != null) return row.action ? `${row.role}->${row.action}` : row.role;
  if (row.action != null) return row.resource ? `${row.action}:${row.resource}` : row.action;
  return null;
}
const reconOf = (kind, row, status, feature_id) => ({ file: row.file ?? null, line: row.line ?? null, kind, entry: reconLabel(row), status, feature_id });

// Every node id reachable forward from some FEATURE node, mapped to (one of) that feature's id.
// Used to re-check a legacy structural row (ENDPOINT/SERVICE/JOB/DATA_STORE/AUTHN/AUTHZ) that the
// new-surface pipeline (or bridgeLegacySurfaces) already turned into a real, feature-reachable
// node under a DIFFERENT id path than the raw legacy row itself — so it isn't double-reported as
// a gap. ARCH_CLUSTER-owned nodes are deliberately excluded (not a FEATURE root), matching
// buildArchitecture's own "technical cluster, not a confirmed feature" stance.
function featureReachableMap(nodes, edges) {
  const bySrc = new Map();
  for (const e of edges) { if (!bySrc.has(e.src)) bySrc.set(e.src, []); bySrc.get(e.src).push(e); }
  const owner = new Map();
  for (const n of nodes) {
    if (n.type !== 'FEATURE') continue;
    const seen = new Set([n.id]);
    const queue = [n.id];
    while (queue.length) {
      const cur = queue.shift();
      for (const e of bySrc.get(cur) || []) {
        if (seen.has(e.dst)) continue;
        seen.add(e.dst);
        if (!owner.has(e.dst)) owner.set(e.dst, n.id);
        queue.push(e.dst);
      }
    }
  }
  return owner;
}

// Best-effort node id(s) a legacy structural row's real-world surface would land under once
// bridged/re-extracted by the new pipeline — mirrors nodeForRow's own id builders for each kind.
// Not exhaustive (AUTHN/AUTHZ have no single deterministic bridge): a row whose candidate ids all
// miss just stays an honest UNCLEAR_COVERAGE_GAP, same as before this fix.
function candidateNodeIds(row) {
  switch (row.kind) {
    case 'ENDPOINT': return row.method && row.route ? [ID.endpoint(row.method, row.route)] : [];
    case 'SERVICE': return [ID.scoped('service', row.file)];
    case 'JOB': return [ID.scoped('job', row.file, row.line, row.name)];
    case 'DATA_STORE': return [ID.scoped('model', row.file)];
    case 'AUTHN': return [ID.scoped('token', row.file, row.line), ID.scoped('authcheck', row.file, 'actor'), ID.scoped('rails-authn', row.file, row.line)];
    case 'AUTHZ': return [ID.scoped('authcheck', row.file), ID.scoped('authcheck', row.file, 'actor')];
    default: return [];
  }
}
// A path segment shaped like an id (drives GraphQL Query→ENDPOINT arg-in-route synthesis, §2/§7).
const ID_ARG_RE = /^(id|.*_id|.*Id)$/;

// Parse "Query.expense(id: ID!): Expense" / "expense(id: ID!)" style entries when Package A hasn't
// (yet) supplied structured {operation_type, field_name, id_args} fields directly on the row.
function parseGraphqlEntry(entry) {
  const m = /\b(Query|Mutation)\b[.\s]*([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(String(entry || ''));
  if (!m) return null;
  const [, operation_type, field_name, argsStr] = m;
  const id_args = [...argsStr.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]).filter((n) => ID_ARG_RE.test(n));
  return { operation_type, field_name, id_args };
}
function graphqlFields(row) {
  // @secforge/inventories (graphql-sdl.js) emits structured {operation_type, field_name,
  // args:[{name,type,isID}]} on 'graphql-sdl-field'/'graphql-resolver' rows; other extractors
  // (Rails grep hits, universal GRAPHQL_DEF) only emit a plain `entry` string — fall back to
  // parsing it, and any row this can't resolve becomes a bare GRAPHQL_OPERATION (design §2).
  if (row.operation_type && row.field_name) {
    const id_args = Array.isArray(row.args) ? row.args.filter((a) => a.isID).map((a) => a.name) : (row.id_args || []);
    return { operation_type: row.operation_type, field_name: row.field_name, id_args };
  }
  return parseGraphqlEntry(row.entry);
}
// Query → GET + `/{arg}` per ID-shaped arg (satisfies assess's PARAM_RE); Mutation → POST, no
// arg suffix (state-changing either way — STATE_CHANGING_METHODS already covers it).
function graphqlRoute(gf) {
  const method = gf.operation_type === 'Mutation' ? 'POST' : 'GET';
  const idSuffix = gf.operation_type === 'Mutation' ? '' : (gf.id_args || []).map((a) => `/{${a}}`).join('');
  return { method, route: `/graphql/${gf.operation_type}/${gf.field_name}${idSuffix}` };
}

// verb+path from a resolved row, or parsed out of the entry text (codengram's own fallback).
function methodRouteOf(row) {
  if (row.method && (row.route || row.path)) return { method: String(row.method).toUpperCase(), route: row.route || row.path };
  const mm = /\b(get|post|put|patch|delete)\b/i.exec(String(row.entry || ''));
  const pm = /['"]([^'"]+)['"]/.exec(String(row.entry || ''));
  return mm && pm ? { method: mm[1].toUpperCase(), route: pm[1] } : null;
}

// A row's own body span (Package A) if boundable — see design §7 (endpoint-scoped auth).
const withinBody = (row, body) => !!body && Number.isInteger(row.line) && row.line >= body.startLine && row.line <= body.endLine;

// ── Graph accumulator: plain arrays in @secforge/store's exact node/edge row shape ──────────────
function makeGraph() {
  const nodes = new Map();
  const edges = [];
  const edgeIds = new Set();
  const addNode = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, { data: {}, claims: [], ...n }); return nodes.get(n.id); };
  const addClaim = (id, c) => { const n = nodes.get(id); if (n && !n.claims.some((x) => x.file === c.file && x.line === c.line)) n.claims.push(c); };
  const addEdge = (type, src, dst, data) => {
    const id = `edge:${type}:${src}:${dst}`;
    if (edgeIds.has(id) || !nodes.has(src) || !nodes.has(dst)) return;
    edgeIds.add(id);
    edges.push(data && Object.keys(data).length ? { id, type, src, dst, data } : { id, type, src, dst });
  };
  return { nodes, edges, addNode, addClaim, addEdge };
}

// Build one typed node (+ claim) for an inventory row, wired FEATURE --edgeType--> node. Returns
// the created node's id, or null for an unrecognized kind.
function nodeForRow(g, featureId, kind, row) {
  const mk = (node, edgeType, extra = {}) => {
    const n = g.addNode({ ...node, data: { file: row.file, line: row.line, ...(node.data || {}), ...extra } });
    g.addEdge(edgeType, featureId, n.id);
    g.addClaim(n.id, claim(row.file, row.line));
    return n.id;
  };
  switch (kind) {
    case 'routes_endpoints': case 'rest_api': {
      if (row.detail === 'controller-helper') return mk({ type: 'SYMBOL', id: ID.scoped('symbol', row.file, row.entry), name: String(row.entry).replace(/^helper\s+/, ''), data: { kind: 'controller-helper' } }, 'DEFINES');
      const mr = methodRouteOf(row);
      const nodeId = mr
        ? mk({ type: 'ENDPOINT', id: ID.endpoint(mr.method, mr.route), name: `${mr.method} ${mr.route}`, data: { method: mr.method, route: mr.route, interface_kind: kind === 'rest_api' ? 'rest' : 'web' } }, 'EXPOSES')
        : mk({ type: 'ROUTE', id: ID.scoped('route', row.file, row.line, row.entry), name: String(row.entry || '').slice(0, 60), data: { path: row.entry } }, 'EXPOSES');
      // Every client-facing HTTP surface crosses the same untrusted-client->application trust
      // boundary — one boundary node total per graph (dedup guard below). GraphQL/workers_jobs are
      // deliberately left unwired, same scope.
      const boundaryId = 'trust_boundary:untrusted-client-to-application';
      if (!g.nodes.has(boundaryId)) {
        g.addNode({ type: 'TRUST_BOUNDARY', id: boundaryId, name: 'Untrusted client → application', data: { kind: 'network', confidence: 'high' } });
      }
      g.addEdge('CROSSES_BOUNDARY', nodeId, boundaryId);
      return nodeId;
    }
    case 'graphql': {
      const gf = graphqlFields(row);
      if (!gf) return mk({ type: 'GRAPHQL_OPERATION', id: ID.scoped('graphql', row.file, row.line, row.entry), name: String(row.entry || '').slice(0, 60) }, 'DEFINES');
      const { method, route } = graphqlRoute(gf);
      return mk({ type: 'ENDPOINT', id: ID.endpoint(method, route), name: `${method} ${route}`,
        data: { method, route, interface_kind: 'graphql', operation_type: gf.operation_type, field_name: gf.field_name } }, 'EXPOSES');
    }
    case 'workers_jobs': return mk({ type: 'JOB', id: ID.scoped('job', row.file, row.line, row.entry), name: String(row.entry || '').slice(0, 60) }, 'HANDLED_BY');
    case 'services_finders_policies': {
      if (row.detail === 'source-module') return mk({ type: 'SYMBOL', id: ID.scoped('symbol', row.file, row.entry), name: row.entry, data: { kind: 'source-module' } }, 'DEFINES');
      if (row.detail === 'weak-crypto') return mk({ type: 'SYMBOL', id: ID.scoped('symbol', row.file, row.entry), name: row.entry, data: { kind: 'weak-crypto' } }, 'DEFINES');
      if (row.detail === 'policy') return mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file), name: row.entry, data: { kind: 'policy' } }, 'AUTHORIZED_BY');
      if (row.detail === 'model') return mk({ type: 'MODEL', id: ID.scoped('model', row.file), name: String(row.entry || '').replace(/\.\w+$/, ''), data: { kind: 'model' } }, 'HANDLED_BY');
      return mk({ type: 'SERVICE', id: ID.scoped('service', row.file), name: row.entry, data: { kind: row.detail === 'finder' ? 'finder' : 'service' } }, 'USES_SERVICE');
    }
    case 'response_shaping': {
      const serializer = mk({ type: 'SERVICE', id: ID.scoped('service', row.file, row.line, 'serializer'), name: String(row.entry || '').slice(0, 60), data: { kind: 'serializer' } }, 'USES_SERVICE');
      const flowId = ID.scoped('data_flow', featureId, row.file, row.line);
      g.addNode({ id: flowId, type: 'DATA_FLOW', name: `Response from ${String(row.file).split('/').pop()}`, data: { source: row.file, line: row.line, direction: 'application-to-client' } });
      g.addEdge('RETURNS_DATA', serializer, flowId);
      return serializer;
    }
    case 'tokens_actors': {
      if (row.detail === 'token') return mk({ type: 'TOKEN', id: ID.scoped('token', row.file, row.line), name: String(row.entry || '').slice(0, 60), data: { kind: 'token' } }, 'AUTHENTICATED_BY');
      // CSRF guard — belongs in the same "security layer" edge bucket as GUARDED_BY (not
      // AUTHENTICATED_BY: it's neither "who" nor "may you"). Line-scoped id (not the shared
      // per-file 'actor' id below) so wireEndpointAuth can look it up the same way it looks up a
      // 'token' row's node id.
      if (row.detail === 'csrf') return mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file, row.line, 'csrf'), name: String(row.entry || '').slice(0, 60), data: { kind: 'csrf-guard' } }, 'GUARDED_BY');
      // POSITIVE cookie/session-auth evidence (RIX-csrf design) — a real signal graph-utils'
      // hasCookieSessionAuth() looks for; line-scoped like the csrf-guard bucket above.
      if (row.detail === 'session-cookie') return mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file, row.line, 'session-cookie'), name: String(row.entry || '').slice(0, 60), data: { kind: 'session-cookie' } }, 'AUTHENTICATED_BY');
      // A raw `class X < ActionController::Base|API` declaration is only inventory-layer fuel for
      // railsControllerCookieSession()'s resolution below — not itself a security check to graph.
      if (row.detail === 'action-controller-base') return null;
      return mk({ type: 'AUTH_CHECK', id: ID.scoped('authcheck', row.file, 'actor'), name: String(row.entry || '').slice(0, 60), data: { kind: row.detail === 'permission' ? 'ability' : 'before_action' } }, 'AUTHENTICATED_BY');
    }
    case 'downloads_uploads_exports': case 'search_aggregation':
      return mk({ type: 'SERVICE', id: ID.scoped('service', row.file, row.line, kind), name: String(row.entry || '').slice(0, 50), data: { kind: 'service' } }, 'USES_SERVICE');
    default: return null;
  }
}

// ── §7 endpoint-scoped auth attribution ──────────────────────────────────────────────────────
// AUTHN (tokens_actors 'token' rows — "who are you", e.g. an API-token check) legitimately
// applies file-wide even when an endpoint has a body span: the guard is declared once, outside
// every action body, and covers every action in the file/controller. GraphQL is project-wide
// instead, gated on an explicit context/JWT-bootstrap marker (never assumed) — recall over
// precision: unsure ⇒ do NOT claim AUTHENTICATED_BY (a masked BOLA is worse).
// Rails is class/inherited-level (refinement 1): `before_action`/`skip_before_action` are
// class-body macros, so AUTHENTICATED_BY is resolved from the owning controller FILE (walking up
// to whichever ancestor controller — typically ApplicationController — declares it), never from
// the action body. AUTHZ ("may you" — services_finders_policies 'policy' rows, or tokens_actors
// 'permission' rows) is body-scoped FIRST in every case: when the endpoint row has a body span,
// only a signal inside that span counts — a guarded sibling in the same file must never mask an
// unguarded action/resolver.
function graphqlContextDetected(inventories) {
  return (inventories.tokens_actors || []).some((r) => r.detail === 'token' && r.scope === 'global');
}

// Rows this recon build recognizes as Rails-origin ENDPOINT sources (controller actions resolved
// by @secforge/map's rails-routes synthesis, or Grape/API-routes.rb rows) — everything else
// (GraphQL/Express/universal) keeps the pre-refinement file-scoped 'token' behavior unchanged.
const RAILS_ENDPOINT_DETAILS = new Set(['rails-synth', 'grape', 'rails-api-route']);

// Project-wide Rails inherited-authentication resolver (built once per buildGraph() call from
// the 'authn'/'skip-authn' tokens_actors rows @secforge/inventories/rails.js surfaces).
// authenticatedByDefault: true when some BASE controller (application_controller.rb, or any
// *_controller.rb another controller's `class X < Y` names as its parent Y) has its own
// class-level `before_action ...authenticate...`. Per controller: authenticated = it's a
// controller that either defaults on, or declares its own before_action authenticate — UNLESS
// it also declares `skip_before_action ...authenticate...` (still file-scoped, not per-action).
function railsControllerAuth(inventories) {
  const byFile = new Map();
  for (const r of inventories.tokens_actors || []) {
    if (r.detail !== 'authn' && r.detail !== 'skip-authn') continue;
    const e = byFile.get(r.file) || { className: '', parentClass: '', authnAnchor: null, hasSkip: false };
    if (r.detail === 'authn' && !e.authnAnchor) e.authnAnchor = { file: r.file, line: r.line };
    if (r.detail === 'skip-authn') e.hasSkip = true;
    if (r.controllerClass) e.className = r.controllerClass;
    if (r.controllerParent) e.parentClass = r.controllerParent;
    byFile.set(r.file, e);
  }
  const inheritedParents = new Set([...byFile.values()].map((e) => e.parentClass).filter(Boolean));
  const isBaseController = (file, e) => /(^|\/)application_controller\.rb$/i.test(file) || (e.className && inheritedParents.has(e.className));
  let defaultAnchor = null;
  for (const [file, e] of byFile) if (e.authnAnchor && isBaseController(file, e)) { defaultAnchor = e.authnAnchor; break; }
  return {
    anchorFor(file) {
      const e = byFile.get(file);
      if (e?.hasSkip) return null;
      return defaultAnchor || e?.authnAnchor || null;
    },
  };
}

// Project-wide Rails cookie-session base-class resolver (design §RIX-csrf), built from
// 'action-controller-base' tokens_actors rows @secforge/inventories/rails.js surfaces for a
// controller's own `class X < ActionController::Y` declaration. Mirrors railsControllerAuth's own
// default-resolution precedent: a controller with no declared base falls back to whichever base
// controller (ApplicationController, by convention) declares one. ActionController::API resolves
// to false — CSRF is never applicable there, positively exempting the whole app.
function railsControllerCookieSession(inventories) {
  const byFile = new Map();
  for (const r of inventories.tokens_actors || []) {
    if (r.detail !== 'action-controller-base') continue;
    byFile.set(r.file, r.controllerParent);
  }
  let defaultBase = null;
  for (const [file, base] of byFile) if (/(^|\/)application_controller\.rb$/i.test(file)) { defaultBase = base; break; }
  return { isCookieSession: (file) => (byFile.get(file) || defaultBase) === 'ActionController::Base' };
}

function wireEndpointAuth(g, endpointId, row, inventories, isGraphql, railsAuth, cookieSession) {
  const tokenRows = inventories.tokens_actors || [];
  const authzRows = [
    ...(inventories.services_finders_policies || []).filter((r) => r.detail === 'policy'),
    ...tokenRows.filter((r) => r.detail === 'permission'),
  ];
  const csrfRows = tokenRows.filter((r) => r.detail === 'csrf');
  const sessionCookieRows = tokenRows.filter((r) => r.detail === 'session-cookie');
  const sameFile = (r) => r.file === row.file;

  if (isGraphql) {
    if (graphqlContextDetected(inventories)) {
      const ctx = tokenRows.find((r) => r.detail === 'token' && r.scope === 'global');
      const tokId = ID.scoped('token', ctx.file, ctx.line);
      if (g.nodes.has(tokId)) g.addEdge('AUTHENTICATED_BY', endpointId, tokId);
    }
  } else if (RAILS_ENDPOINT_DETAILS.has(row.detail)) {
    const anchor = railsAuth.anchorFor(row.file);
    if (anchor) {
      const tokId = ID.scoped('rails-authn', anchor.file, anchor.line);
      if (!g.nodes.has(tokId)) g.addNode({ type: 'AUTH_CHECK', id: tokId, name: 'before_action :authenticate', data: { kind: 'before_action', file: anchor.file, line: anchor.line } });
      g.addClaim(tokId, claim(anchor.file, anchor.line));
      g.addEdge('AUTHENTICATED_BY', endpointId, tokId);
    }
  } else {
    const authnRow = tokenRows.find((r) => r.detail === 'token' && sameFile(r));
    if (authnRow) { const tokId = ID.scoped('token', authnRow.file, authnRow.line); if (g.nodes.has(tokId)) g.addEdge('AUTHENTICATED_BY', endpointId, tokId); }
  }

  const inBody = row.body ? authzRows.filter((r) => sameFile(r) && withinBody(r, row.body)) : authzRows.filter(sameFile);
  for (const r of inBody) {
    const acId = r.detail === 'policy' ? ID.scoped('authcheck', r.file) : ID.scoped('authcheck', r.file, 'actor');
    if (g.nodes.has(acId)) g.addEdge('AUTHORIZED_BY', endpointId, acId);
  }

  // CSRF guard is declared once (protect_from_forgery / csurf() etc.), same-file scope — same
  // "declared once, covers the file" precedent already used for API-token tokens_actors rows.
  const csrfRow = csrfRows.find(sameFile);
  if (csrfRow) {
    const csrfId = ID.scoped('authcheck', csrfRow.file, csrfRow.line, 'csrf');
    if (g.nodes.has(csrfId)) g.addEdge('GUARDED_BY', endpointId, csrfId);
  }

  // POSITIVE cookie/session-auth evidence (RIX-csrf design) — same-file scope, same precedent as
  // the csrf-guard bucket above. Explicit session[]/cookies.signed/cookies.encrypted/express-session/
  // req.session/cookie-session/Set-Cookie/form-render evidence wins outright; failing that, a
  // Rails-recognized endpoint whose controller resolves to ActionController::Base still counts —
  // an ActionController::API app resolves false and gets no edge, so RIX-csrf never fires there.
  const sessionCookieRow = sessionCookieRows.find(sameFile);
  if (sessionCookieRow) {
    const scId = ID.scoped('authcheck', sessionCookieRow.file, sessionCookieRow.line, 'session-cookie');
    if (g.nodes.has(scId)) g.addEdge('AUTHENTICATED_BY', endpointId, scId);
  } else if (!isGraphql && RAILS_ENDPOINT_DETAILS.has(row.detail) && cookieSession.isCookieSession(row.file)) {
    const scId = ID.scoped('authcheck', row.file, 'action-controller-base');
    if (!g.nodes.has(scId)) g.addNode({ type: 'AUTH_CHECK', id: scId, name: 'ActionController::Base', data: { kind: 'session-cookie' } });
    g.addEdge('AUTHENTICATED_BY', endpointId, scId);
  }
}

// ── ontology (AI-derived identity) ───────────────────────────────────────────────────────────
function buildOntology(g, ontology, features) {
  const featByKey = new Map(features.map((f) => [`${f.domain}/${f.slug}`, ID.feature(featureKey(f))]));
  const featureId = (f) => featByKey.get(`${slug(f.domain || 'core')}/${slug(f.slug || f.name)}`) || null;
  const ev0 = (e) => (Array.isArray(e?.evidence) && e.evidence[0]) || null;
  const roleId = (name) => ID.role(name), permId = (name) => ID.permission(name), actorId = (name) => ID.actor(name);
  const made = new Set();
  const link = (type, from, to, data) => { if (made.has(from) && made.has(to)) g.addEdge(type, from, to, data); };
  for (const a of ontology.actors || []) { if (!slug(a.name)) continue; const id = actorId(a.name); if (made.has(id)) continue;
    g.addNode({ type: 'ACTOR', id, name: a.name, data: { kind: a.kind || null, obtained_via: a.obtained_via || null, scopes: a.scopes || [], hierarchical: !!a.hierarchical } });
    const e = ev0(a); if (e?.file) g.addClaim(id, claim(e.file, e.line, 'llm-map', 'high'));
    made.add(id); }
  for (const r of ontology.roles || []) { if (!slug(r.name)) continue; const id = roleId(r.name); if (made.has(id)) continue;
    g.addNode({ type: 'ROLE', id, name: titleize(String(r.name).replace(/[_-]+/g, ' ')), data: { description: r.description || null, scope: r.scope || null, obtained_via: r.obtained_via || null, hierarchical: !!r.hierarchical, lead_derived: true } });
    const e = ev0(r); if (e?.file) g.addClaim(id, claim(e.file, e.line, 'llm-map', 'high'));
    made.add(id); }
  for (const p of ontology.permissions || []) { if (!slug(p.name)) continue; const id = permId(p.name); if (made.has(id)) continue;
    g.addNode({ type: 'PERMISSION', id, name: String(p.name).replace(/[_-]+/g, ' '), data: { description: p.description || null, resource: p.resource || null, operation: p.operation || null, lead_derived: true } });
    const e = ev0(p); if (e?.file) g.addClaim(id, claim(e.file, e.line, 'llm-map', 'high'));
    made.add(id); }
  for (const r of ontology.roles || []) for (const p of r.enables || []) link('AUTHORIZED_BY', roleId(r.name), permId(p), { relationship: 'role-enables-permission' });
  for (const p of ontology.permissions || []) for (const rn of p.enabled_by_roles || []) link('REQUIRES_ROLE', permId(p.name), roleId(rn), { relationship: 'permission-requires-role' });
  for (const p of ontology.permissions || []) for (const an of p.granted_to_actors || []) link('AUTHORIZED_BY', actorId(an), permId(p.name), { relationship: 'actor-granted-permission' });
  for (const f of ontology.features || []) { const fid = featureId(f); if (!fid) continue;
    for (const an of f.actors || []) if (made.has(actorId(an))) g.addEdge('AUTHENTICATED_BY', fid, actorId(an), { relationship: 'feature-reachable-by-actor' });
    for (const pn of f.permissions || []) if (made.has(permId(pn))) g.addEdge('AUTHORIZED_BY', fid, permId(pn), { relationship: 'feature-governed-by-permission' });
  }
}

// ── ARCH_CLUSTER (fail-closed / partial-coverage architecture, never FEATURE) ────────────────
function buildArchitecture(g, clusters, reconciliation) {
  for (const c of clusters) {
    const clusterId = ID.scoped('arch', c.domain, c.slug);
    g.addNode({ type: 'ARCH_CLUSTER', id: clusterId, name: c.name, data: { domain: c.domain, slug: c.slug, technical: true, unverified: true, row_count: c.rows.length, planning_method: c.planning_method || 'module-cohesion',
      note: 'technical cluster derived from directory structure — NOT a confirmed business feature' } });
    for (const { kind, row } of c.rows) {
      nodeForRow(g, clusterId, kind, row);
      // Not FEATURE-reachable (ARCH_CLUSTER is an unconfirmed technical cluster, per its own
      // node data comment above) — an honest coverage gap, not MAPPED_TO_FEATURE.
      reconciliation.push(reconOf(kind, row, 'UNCLEAR_COVERAGE_GAP', null));
    }
  }
}

// project-level infra: processes_ipc → PROCESS (CONTAINS); datastores_integrations → DATA_STORE
// (CONTAINS) / INTEGRATION (USES_INTEGRATION). Never per-feature — see design §2 rationale.
function buildInfra(g, projectId, inventories, reconciliation) {
  for (const kind of INFRA_KINDS) for (const row of inventories[kind] || []) {
    const type = kind === 'datastores_integrations' ? (row.detail === 'datastore' ? 'DATA_STORE' : 'INTEGRATION') : 'PROCESS';
    const id = ID.scoped(type.toLowerCase(), row.file, row.line, row.entry);
    g.addNode({ id, type, name: String(row.entry || '').slice(0, 60), data: { file: row.file, line: row.line } });
    g.addEdge(type === 'INTEGRATION' ? 'USES_INTEGRATION' : 'CONTAINS', projectId, id);
    g.addClaim(id, claim(row.file, row.line));
    reconciliation.push(reconOf(kind, row, 'SHARED_INFRASTRUCTURE', null));
  }
}

// ── legacy deterministic identity path (ROLE/ACTOR/PERMISSION/ROLE_CHECK/ROLE_GRANTS) ────────
// Runs unconditionally, unchanged from today's map/src/index.js — this is SecForge's own honest
// role vocabulary, independent of (and alongside) the AI ontology. AUTHN/AUTHZ legacy rows are
// NOT re-wired to endpoints here (that whole-file wiring is superseded by §7's body-scoped logic).
function wireLegacyIdentity(g, legacyRows, endpointsByFile) {
  const fileRoles = new Map();
  for (const row of legacyRows) {
    if (row.kind !== 'ROLE_CHECK') continue;
    const roles = fileRoles.get(row.file) || new Map();
    if (!roles.has(row.role)) roles.set(row.role, row.line);
    fileRoles.set(row.file, roles);
  }
  for (const row of legacyRows) {
    if (row.kind === 'ROLE') g.addNode({ id: ID.role(row.name), type: 'ROLE', name: row.name, data: { name: row.name }, claims: [claim(row.file, row.line)] });
    else if (row.kind === 'ACTOR') g.addNode({ id: ID.actor(row.name), type: 'ACTOR', name: row.name, data: { name: row.name }, claims: [claim(row.file, row.line)] });
    else if (row.kind === 'PERMISSION') g.addNode({ id: ID.permission(row.action, row.resource), type: 'PERMISSION', name: row.resource ? `${row.action}:${row.resource}` : row.action, data: { action: row.action, resource: row.resource || null }, claims: [claim(row.file, row.line)] });
  }
  // ENDPOINT --REQUIRES_ROLE--> ROLE: only when the named role was actually DECLARED (honest miss otherwise).
  for (const [file, endpointIds] of endpointsByFile) {
    const roleChecks = fileRoles.get(file); if (!roleChecks) continue;
    for (const roleName of roleChecks.keys()) {
      const roleId = ID.role(roleName); if (!g.nodes.has(roleId)) continue;
      for (const epId of endpointIds) g.addEdge('REQUIRES_ROLE', epId, roleId);
    }
  }
  // ROLE --GRANTS--> PERMISSION: same-line co-occurrence only; role must be declared vocabulary.
  for (const row of legacyRows) {
    if (row.kind !== 'ROLE_GRANTS') continue;
    const roleId = ID.role(row.role); if (!g.nodes.has(roleId)) continue;
    g.addEdge('GRANTS', roleId, ID.permission(row.action, row.resource));
  }
  // ACTOR --HAS_ROLE--> ROLE: one actor project-wide inherits every declared role; with several,
  // only ones with an observed role-association line link to the full role set.
  const actorNodes = [...g.nodes.values()].filter((n) => n.type === 'ACTOR');
  const roleNodes = [...g.nodes.values()].filter((n) => n.type === 'ROLE');
  if (roleNodes.length && actorNodes.length === 1) {
    for (const r of roleNodes) g.addEdge('HAS_ROLE', actorNodes[0].id, r.id);
  } else if (roleNodes.length && actorNodes.length > 1) {
    const assocActorNames = new Set(legacyRows.filter((r) => r.kind === 'ACTOR' && r.assoc).map((r) => r.name));
    for (const a of actorNodes) { if (!assocActorNames.has(a.name)) continue; for (const r of roleNodes) g.addEdge('HAS_ROLE', a.id, r.id); }
  }
}

const featureKey = (f) => (f.domain && f.domain !== 'core' ? `${f.domain}-${f.slug}` : f.slug);

function coverage(inventories, features, archClusters) {
  const totalRows = INVENTORY_KEYS.reduce((s, k) => s + (inventories[k] || []).length, 0);
  const featureRows = features.reduce((s, f) => s + f.rows.length, 0);
  const archRows = archClusters.reduce((s, c) => s + c.rows.length, 0);
  const featureBearing = totalRows - (inventories.processes_ipc?.length || 0) - (inventories.datastores_integrations?.length || 0);
  const technical_coverage = totalRows ? Math.round(((featureRows + archRows) / (featureBearing || 1)) * 100) : 0;
  const semantic_coverage = featureBearing === 0 ? 0 : Math.round((featureRows / featureBearing) * 100);
  return { feature_count: features.length, technical_clusters: archClusters.length, feature_rows: featureRows,
    arch_rows: archRows, total_rows: totalRows, technical_coverage, semantic_coverage };
}

/**
 * Build the full knowledge graph from deterministic inventories + clusters, an optional
 * evidence-validated AI ontology, and SecForge's own legacy identity rows.
 * @returns {{nodes: object[], edges: object[], features: object[], coverage: object}}
 */
export function buildGraph({ inventories = {}, clusters = null, ontology = null, legacyRows = [], project, snapshotId, readSource = null } = {}) {
  const g = makeGraph();
  const projectId = project?.id || 'project:unknown';
  g.addNode({ type: 'PROJECT', id: projectId, name: project?.name || projectId, data: {} });

  const deterministicClusters = clusters || deterministicSemanticPlan(inventories);
  const domainIds = new Map();
  const ensureDomain = (domain) => {
    if (domainIds.has(domain)) return domainIds.get(domain);
    const id = ID.scoped('domain', domain);
    g.addNode({ id, type: 'DOMAIN', name: titleize(domain) });
    g.addEdge('CONTAINS', projectId, id);
    domainIds.set(domain, id);
    return id;
  };

  // FEATURE nodes ALWAYS exist from the deterministic clusters — SecForge's coverage/UI/rules
  // require them even rules-only (no LLM); codengram's own stricter "no AI → ARCH_CLUSTER only,
  // zero features" fail-closed does NOT apply here (mapper-design.md §CRITICAL rule 2). Fail-closed
  // instead applies ONLY to ungrounded AI ontology entities — those are dropped by
  // evidence-validator.js before ever reaching here, never to feature existence itself. An AI
  // ontology (once evidence-validated) still ENRICHES: it can rename/refine features and adds
  // evidence-validated ACTOR/ROLE/PERMISSION (buildOntology below) — it just never gates FEATURE
  // existence, planning_method stays 'module-cohesion'/'local-cohesion' (never dressed up as
  // agent-confirmed) when it is the deterministic clusters standing in directly.
  let features = [], archClusters = [];
  if (ontology) {
    const validated = validateLeadPlan(ontology, inventories);
    features = validated?.features || [];
    archClusters = validated?.archClusters || [];
  } else {
    features = deterministicClusters;
  }

  const endpointsByFile = new Map();
  const noteEndpoint = (nodeId, file) => { const t = endpointsByFile.get(file) || new Set(); t.add(nodeId); endpointsByFile.set(file, t); };
  // Reconciliation universe MUST match persistInventory's inventory.jsonl exactly (Phase A §2):
  // every FEATURE_KINDS row lands in exactly one of `features`/`archClusters` (guaranteed by
  // deterministicSemanticPlan/validateLeadPlan), every INFRA_KINDS row is processed unconditionally
  // by buildInfra, and every legacyRow gets its own entry below — so the count is exact by
  // construction, not by re-deriving persistInventory's logic here.
  const reconciliation = [];

  const railsAuth = railsControllerAuth(inventories);
  const cookieSession = railsControllerCookieSession(inventories);
  const endpointRows = []; // { nodeId, row, isGraphql } — auth-wired in a SECOND pass (below), once
                            // every TOKEN/AUTH_CHECK node in the feature exists (row order within a
                            // feature is not guaranteed to put tokens_actors before routes_endpoints).
  const serviceUsers = new Map(); // nodeId (service:*/authcheck:*) -> Set(featureId) — same-functionality detection
  for (const f of features) {
    const domId = ensureDomain(f.domain);
    const featId = ID.feature(featureKey(f));
    g.addNode({ id: featId, type: 'FEATURE', name: f.name, data: { domain: f.domain, slug: f.slug, row_count: f.rows.length, purpose: f.purpose || null, planning_method: f.planning_method || 'agent-lead', confidence: f.confidence || 'medium' } });
    g.addEdge('CONTAINS', domId, featId);
    for (const { kind, row } of f.rows) {
      const nodeId = nodeForRow(g, featId, kind, row);
      if (nodeId && (kind === 'routes_endpoints' || kind === 'rest_api' || kind === 'graphql') && g.nodes.get(nodeId).type === 'ENDPOINT') {
        noteEndpoint(nodeId, row.file);
        endpointRows.push({ nodeId, row, isGraphql: kind === 'graphql' });
      }
      if (nodeId && /^service:|^authcheck:/.test(nodeId)) {
        if (!serviceUsers.has(nodeId)) serviceUsers.set(nodeId, new Set());
        serviceUsers.get(nodeId).add(featId);
      }
      reconciliation.push(reconOf(kind, row, nodeId ? 'MAPPED_TO_FEATURE' : 'UNCLEAR_COVERAGE_GAP', nodeId ? featId : null));
    }
  }
  // Two features that both use the same SERVICE/AUTH_CHECK likely implement the same functionality
  // — surfaced as an undirected pairwise edge, same-functionality detection (design §2b).
  for (const [, users] of serviceUsers) {
    const list = [...users];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      g.addEdge('SHARES_IMPLEMENTATION_WITH', list[i], list[j]);
    }
  }
  for (const { nodeId, row, isGraphql } of endpointRows) wireEndpointAuth(g, nodeId, row, inventories, isGraphql, railsAuth, cookieSession);
  buildArchitecture(g, archClusters, reconciliation);
  // ARCH_CLUSTER-anchored endpoints still get §7 auth wiring (a partially-mapped or blocked run
  // must not silently under-report ACX findings just because no ontology confirmed the feature).
  for (const c of archClusters) for (const { kind, row } of c.rows) {
    if (kind !== 'routes_endpoints' && kind !== 'rest_api' && kind !== 'graphql') continue;
    const isGraphql = kind === 'graphql';
    const gf = isGraphql ? graphqlFields(row) : null;
    const mr = isGraphql ? (gf && graphqlRoute(gf)) : methodRouteOf(row);
    if (!mr) continue;
    const id = ID.endpoint(mr.method, mr.route);
    if (!g.nodes.has(id)) continue;
    noteEndpoint(id, row.file);
    wireEndpointAuth(g, id, row, inventories, isGraphql, railsAuth, cookieSession);
  }

  if (ontology) buildOntology(g, ontology, features);
  buildInfra(g, projectId, inventories, reconciliation);
  wireLegacyIdentity(g, legacyRows, endpointsByFile);

  // legacyRows: every row gets exactly one reconciliation entry, unconditionally (matches
  // persistInventory's own unconditional legacyRows.map(...) line, map/src/index.js:282).
  // ACTOR/ROLE/PERMISSION/ROLE_CHECK/ROLE_GRANTS are project-wide identity vocabulary wired by
  // wireLegacyIdentity above (no single owning feature) → SHARED_INFRASTRUCTURE. ENDPOINT/SERVICE/
  // JOB/DATA_STORE/AUTHN/AUTHZ are structural rows superseded by the new-surface pipeline (bridged
  // forward by bridgeLegacySurfaces, or by §7's body-scoped auth logic) — most of these DO already
  // have a real, feature-reachable node under the bridged/new-surface id, just not the raw legacy
  // row's own id, so re-check via candidateNodeIds before calling it a gap. Only a row whose
  // surface truly produced no feature-reachable node stays UNCLEAR_COVERAGE_GAP.
  const LEGACY_IDENTITY_KINDS = new Set(['ACTOR', 'ROLE', 'PERMISSION', 'ROLE_CHECK', 'ROLE_GRANTS']);
  const featureOwner = featureReachableMap([...g.nodes.values()], g.edges);
  for (const row of legacyRows) {
    if (LEGACY_IDENTITY_KINDS.has(row.kind)) { reconciliation.push(reconOf(row.kind, row, 'SHARED_INFRASTRUCTURE', null)); continue; }
    const featureId = candidateNodeIds(row).map((id) => featureOwner.get(id)).find(Boolean) || null;
    reconciliation.push(reconOf(row.kind, row, featureId ? 'MAPPED_TO_FEATURE' : 'UNCLEAR_COVERAGE_GAP', featureId));
  }

  return { nodes: [...g.nodes.values()], edges: g.edges, features, coverage: coverage(inventories, features, archClusters), reconciliation };
}
