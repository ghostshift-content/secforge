# Phase 1 completion — ACTOR/ROLE/PERMISSION + inventory persistence (design)

Status: design only, no code. Scope: `docs/SECFORGE-PLAN.md` §5.1, closing QA gaps P3-1
(Inventories subtab) and P3-2 (Roles subtab). Everything below is regex/keyword over a frozen
file manifest — no AST, no LLM. Same engine shape as the existing `ENDPOINT`/`SERVICE`/`JOB`/
`DATA_STORE`/`AUTHN`/`AUTHZ` extraction in `packages/map/src/index.js`; this just adds five more
row kinds to the same `scanFile()` loop and a persistence step the engine currently skips.

Reuse-first: `NODE_TYPES` already reserves `ACTOR`/`ROLE`/`PERMISSION` (unused today) and
`EDGE_TYPES` already has `REQUIRES_ROLE` (unused today). The design below **wires up existing
vocabulary** rather than inventing a parallel one. Only two edge types are genuinely new.

---

## 1. ACTOR / ROLE / PERMISSION extraction — deterministic heuristics

### 1.1 New inventory row kinds (added to `scanFile()`'s per-line loop)

| kind | what it means | honest scope |
|---|---|---|
| `ROLE` | a role name is *declared* somewhere in source (a constant, enum, or config array) | this is the app's role **vocabulary**, not who holds it |
| `ACTOR` | a class defines the app's user/principal type | usually one per app (the auth-user model) |
| `PERMISSION` | an ability/authority string is *declared* (CanCan `can`, Spring `hasAuthority`, Laravel `Gate::define`, Django `permission_required`) | the ability vocabulary, not a runtime grant |
| `ROLE_CHECK` | a call site *names* a specific role in an authz decision (`hasRole('admin')`, `current_user.admin?`) | ties a role name to the file the check lives in, same as today's `AUTHZ` row |
| `ROLE_GRANTS` | a single line names **both** a role and a permission together | the only case we treat as evidence of "this role grants this permission" — see §1.4 |

### 1.2 Matchers (parallel to `matchEndpoint`/`matchService`/etc. — first match wins, same style)

```js
// ROLE — vocabulary only (constants / enums / config arrays), can return several names per line.
function matchRoles(line) {
  let m = /\benum\s+role:\s*\{([^}]+)\}/i.exec(line);                 // Rails: enum role: { admin: 0, editor: 1 }
  if (m) return [...m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]);
  m = /\benum\s+Role\b[^{]*\{([^}]+)\}/.exec(line);                    // Java/TS: enum Role { ADMIN, EDITOR }
  if (m) return m[1].split(',').map((s) => s.trim().split(/[=\s(]/)[0]).filter(Boolean);
  m = /\bROLE_([A-Z][A-Z0-9_]*)\s*[:=]/.exec(line);                    // ROLE_ADMIN = ...
  if (m) return [m[1]];
  m = /\broles?\s*[:=]\s*\[([^\]]+)\]/i.exec(line);                    // roles: ['admin','editor'] / ROLES = [...]
  if (m) return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  return [];
}

// ACTOR — the auth-user model. Two independent signals, both attributed to the *nearest preceding*
// `class X` line in the same file (scanFile already reads the file top-to-bottom; keep one small
// `lastClass = {name, line}` local var, updated whenever a class-def matches — no cross-file state).
const ACTOR_CLASS_RE =
  /\bclass\s+([A-Za-z0-9_]+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/,  // Rails model
  // .concat other class-def shapes reused from matchDataStore: models.Model, mongoose.model, sequelize.define
const ACTOR_NOUN_RE = /^(User|Account|Member|Admin|Customer|Employee|Staff|Actor|Person)$/;
const ACTOR_SIGNAL_RE = /\bdevise\s*:|has_(?:and_belongs_to_)?many\s+:roles\b|belongs_to\s+:role\b|has_one\s+:role\b/;
// matchActorClass(line) → class name IF it's a data-store-shaped class AND its name matches
//   ACTOR_NOUN_RE (curated noun list — the honest, conservative signal).
// matchActorSignal(line) → true IF the line is a devise call or a role association; caller
//   attributes it to `lastClass.name`, overriding the noun-list requirement (a class named
//   anything that calls `devise :database_authenticatable` or has a `:roles` association IS
//   the actor, regardless of its name).

// PERMISSION — ability vocabulary declared at a call site.
function matchPermission(line) {
  let m = /\bcan\s+(:\w+|\[[^\]]+\])\s*,\s*([A-Za-z0-9_:]+)/.exec(line);  // CanCanCan: can :read, Project
  if (m) return { action: m[1].replace(/[:\[\]\s]/g, ''), resource: m[2] };
  m = /hasAuthority\(\s*['"]([\w:-]+)['"]\s*\)/i.exec(line);             // Spring: hasAuthority('EDIT_POST')
  if (m) return { action: m[1], resource: null };
  m = /Gate::define\(\s*['"]([\w-]+)['"]/i.exec(line);                   // Laravel: Gate::define('update-post', ...)
  if (m) return { action: m[1], resource: null };
  m = /permission_required\(\s*['"]([\w.]+)['"]/i.exec(line);            // Django: permission_required('app.can_edit')
  if (m) return { action: m[1], resource: null };
  return null;
}

// ROLE_CHECK — an authz decision that NAMES a role (first match wins).
function matchRoleCheck(line) {
  let m = /\b(?:requireRole|hasRole|has_role\?|is_role\?)\s*\(\s*['"]([\w-]+)['"]/i.exec(line);
  if (m) return m[1];
  m = /@Roles\(\s*\{?\s*['"]([\w-]+)['"]/i.exec(line);                   // NestJS/Spring decorator
  if (m) return m[1];
  m = /current_user\.(\w+)\?/.exec(line);                                // Rails idiom: current_user.admin?
  if (m) return m[1];
  m = /\brole\?\(\s*:(\w+)\s*\)/.exec(line);                             // role?(:admin)
  if (m) return m[1];
  return null;
}
```

`scanFile` calls these alongside the existing checks; a line can legitimately match more than one
(e.g. `hasRole('ADMIN') and hasAuthority('EDIT_POST')` on one Spring `@PreAuthorize` line hits both
`matchRoleCheck` and `matchPermission`) — that co-occurrence is exactly the `ROLE_GRANTS` signal
(§1.4), captured with no extra logic beyond "both matched on this line".

### 1.3 Node/edge construction in `buildGraph()`

Same per-file attribution pattern already used for `fileAuth` (AUTHN/AUTHZ → nearest endpoint in
the same file): add a `fileRoles: Map<file, Set<roleName>>` built from `ROLE_CHECK` rows, and dedupe
`ROLE`/`ACTOR`/`PERMISSION` rows into one node per distinct name (first occurrence wins the claim,
exactly like `ENDPOINT` nodes dedupe by `ID.endpoint`).

| row kind | node | id | edges created |
|---|---|---|---|
| `ROLE` | `ROLE` | `ID.role(name)` | — |
| `ACTOR` | `ACTOR` | `ID.actor(name)` | see below |
| `PERMISSION` | `PERMISSION` | `ID.permission(action, resource)` | — |
| `ROLE_CHECK` (in a file with an `ENDPOINT`) | *(no new node)* | — | `ENDPOINT --REQUIRES_ROLE--> ROLE` (reuses the existing edge type — an endpoint checked by `hasRole('admin')` in the same file *requires* that role, exactly the semantic `REQUIRES_ROLE` was reserved for) |
| `ROLE_GRANTS` | *(no new node)* | — | `ROLE --GRANTS--> PERMISSION` (new edge type, §3) |

**ACTOR → ROLE (`HAS_ROLE`, new edge type, §3)** — the honest-coverage-sensitive part. Static
line-scanning cannot know which *instances* of a user hold which role; it can only say "the app's
actor model is associated with this role vocabulary". Rule, stated plainly so it can't silently
overclaim:

- Exactly **one** `ACTOR` node found project-wide → link it `HAS_ROLE` to **every** `ROLE` node
  found project-wide (there is only one actor type, so any declared role must belong to it).
- **More than one** `ACTOR` node found → link `ACTOR --HAS_ROLE--> ROLE` **only** when a role
  association line (`has_many :roles`, `belongs_to :role`, etc.) was attributed to that specific
  actor's class. Roles with no such tie stay in the `ROLE` catalog **with no `HAS_ROLE` edge** —
  a visible, honest gap, not a guess.
- **Zero** `ACTOR` nodes found → no `HAS_ROLE` edges at all; `ROLE`/`PERMISSION` nodes still
  persist (the Roles subtab shows the role/permission catalog with an explicit "no actor model
  detected" note, §4).

### 1.4 What this CANNOT detect (state this in the UI, not just the docs)

- **Runtime role assignment** — which actual users/rows carry which role. This is schema/vocabulary
  extraction, never instance data.
- **Cross-line role→permission wiring** — CanCanCan's real pattern is `can :manage, Post if
  user.admin?` split across an `if`/method-guard a few lines away from the `can` call; unless role
  and permission tokens land on the *same source line*, no `GRANTS` edge is created. This under-detects
  on purpose rather than fabricating a link the source doesn't literally show.
- **Dynamic/computed roles** — roles built from a database table, a feature-flag service, or a
  string built at runtime (`"ROLE_#{tier}"`) are invisible; only literal string/symbol roles in
  source are matched.
- **Framework-specific but unlisted idioms** — the matcher list above covers Rails/Devise/CanCan,
  Spring `@PreAuthorize`, NestJS `@Roles`, Laravel `Gate`, Django `permission_required`. Anything
  outside that list (a bespoke in-house RBAC helper, a different framework) yields zero rows —
  an honest miss, not a wrong answer. This mirrors the existing `AUTHN_RE`/`AUTHZ_RE` disclaimer.
- **Multi-tenant/ABAC systems** with no named "role" concept at all (pure attribute checks) will
  show an empty Roles subtab correctly — there is nothing to extract, and nothing should be shown.

### 1.5 Determinism

All new ids are pure functions of extracted names (`ID.role`, `ID.actor`, `ID.permission`, below)
— identical source ⇒ identical ids ⇒ re-scans are idempotent, same guarantee `ENDPOINT`/`FEATURE`
already have.

---

## 2. Inventory persistence

### 2.1 What's already computed and thrown away

`mapProject()` builds the full `inventory` array (every `scanFile()` row across every manifest
file) at line ~243 of `packages/map/src/index.js`, feeds it into `buildGraph()`, then lets the
array fall out of scope. Nothing new needs to be *computed* for inventory — it needs to be
*written to disk* before it's dropped.

### 2.2 File layout

```
snapshots/<snapshotId>/inventory.jsonl     # one JSON row per line, same tmp+rename pattern as
                                            # source-manifest.jsonl (persistSnapshot already does
                                            # this — inventory gets the identical treatment)
```

Row shape (uniform across all kinds, so the file is one flat append-only-looking list):

```json
{"kind":"ENDPOINT","file":"api/orders.js","line":12,"detail":{"method":"GET","route":"/orders/:id","guarded":true}}
{"kind":"ROLE","file":"app/models/role.rb","line":3,"detail":{"name":"admin"}}
{"kind":"ACTOR","file":"app/models/user.rb","line":1,"detail":{"name":"User"}}
```

`detail` is kind-specific (mirrors each row's extra fields today: `{method,route}` for `ENDPOINT`,
`{name}` for `SERVICE`/`JOB`/`DATA_STORE`/`ROLE`/`ACTOR`, `{action,resource}` for `PERMISSION`,
`{role}` for `ROLE_CHECK`). `{}` for `AUTHN`/`AUTHZ` (no extra data today).

One cheap, already-computed addition: `ENDPOINT` rows get `detail.guarded` (`true` if the row's
file has an `AUTHN` or `AUTHZ` hit — literally the same `fileAuth` map `buildGraph()` already
builds; exposing it in inventory costs nothing new and gives the Inventories subtab a real signal
without inventing one).

Written in `persistSnapshot()`'s neighbourhood — right after `mapProject()` computes `inventory`,
alongside the existing `manifest.map(...).join('\n')` write, same `.tmp` + `fs.renameSync` idiom.
No new directory, no new package: it's one more file next to `source-manifest.jsonl`.

### 2.3 API

```
GET /api/projects/:id/inventory
```

Follows `packages/assess/src/decorate.js`'s existing `loadManifest()` pattern exactly (read
`graph/current.json` → resolve `snapshotId` → read the file under that snapshot's directory) —
reused verbatim in `routes.js`, not a new resolution mechanism:

```js
if (sub === 'inventory') {
  let rows = [];
  try {
    const pointer = JSON.parse(await fsp.readFile(path.join(store.projectDir(pid), 'graph', 'current.json'), 'utf8'));
    const text = await fsp.readFile(path.join(store.projectDir(pid), 'snapshots', pointer.snapshotId, 'inventory.jsonl'), 'utf8');
    rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* not mapped yet — empty, not an error */ }
  const counts = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  return json(res, 200, { rows, counts }), true;
}
```

Response shape: `{ rows: [{kind,file,line,detail}], counts: {ENDPOINT: 12, ROLE: 3, ...} }`. Flat
array, UI groups by `kind` client-side — same division of labour as `/graph` (flat nodes/edges,
UI groups by `type` for the SVG columns).

### 2.4 The 5-category reconciliation (mapped / shared-infra / not-relevant / gap / dead)

**Scoped out, honestly.** The plan's reconciliation ledger (`SECFORGE-PLAN.md` §5.1: "proves every
inventory row... reached a terminal status") requires *semantic* judgment — "this file is
vendored, not relevant", "this method is dead code", "this is shared infra, not a feature" — none
of which a regex/line scan can determine. Faking it would violate the honest-coverage principle
harder than not having it.

What IS cheap and already true today, and worth stating explicitly rather than silently omitting:
`buildGraph()`'s clustering is unconditional (every row's file lands in some directory, every
directory becomes a `FEATURE`) — so **100% of inventory rows are always "mapped" to some feature**
under the current clustering rule. There is no "orphan" bucket to compute because nothing can fail
to cluster. This is worth one line in the Inventories subtab's footer text so it doesn't read as
a suppressed feature: "every row is attached to a feature by directory; classifying rows as
shared-infra/not-relevant/dead needs semantic review, not implemented here." The real 5-category
reconciliation is Phase-2/agentic work (`phase1-feature-map` skill's LLM pass), not this phase.

---

## 3. Schema changes (`packages/schemas/src/index.js`)

`NODE_TYPES` — **no change**. `ACTOR`, `ROLE`, `PERMISSION` are already in the frozen list, unused
until now. Confirmed against plan §4's `ACTOR`/`ROLE`/`PERMISSION` reservation.

`EDGE_TYPES` — **two additions**, `REQUIRES_ROLE` is reused as-is (also already reserved, also
unused until now):

```diff
 export const EDGE_TYPES = Object.freeze([
   // structure
   'CONTAINS', 'DEFINES', 'EXPOSES', 'HANDLED_BY', 'CALLS', 'READS', 'WRITES', 'ENQUEUES',
   'AUTHENTICATED_BY', 'AUTHORIZED_BY', 'REQUIRES_ROLE', 'CROSSES_BOUNDARY', 'RETURNS_DATA',
   'USES_SERVICE', 'USES_INTEGRATION', 'SHARES_IMPLEMENTATION_WITH',
+  'HAS_ROLE', 'GRANTS',
   // security layer
   'CANDIDATE_IN', 'VIOLATES', 'GUARDED_BY', 'MAPS_TO_CWE', 'PROMOTED_TO', 'VALIDATED_BY', 'COVERS',
 ]);
```

Why not the task prompt's example `CAN_ACCESS`: `REQUIRES_ROLE` (`ENDPOINT/FEATURE → ROLE`) already
covers that exact edge — adding `CAN_ACCESS` alongside it would be two edge types for one
relationship. Ladder rung 2 (already in the codebase) wins.

`ID` — three new deterministic builders, same `slug()` helper already used by every other builder:

```diff
 export const ID = Object.freeze({
   project: (name) => `project:${slug(name)}`,
   feature: (s) => `feature:${slug(s)}`,
   endpoint: (method, route) => `endpoint:${String(method).toUpperCase()}:${route}`,
   file: (rel) => `file:${rel}`,
   finding: (n, s) => `finding:F-${n}-${slug(s)}`,
   candidate: (n) => `candidate:C-${n}`,
   run: (sessionId) => `run:${sessionId}`,
   cwe: (id) => `cwe:${id}`,
+  role: (name) => `role:${slug(name)}`,
+  actor: (name) => `actor:${slug(name)}`,
+  permission: (action, resource) => `permission:${slug(action)}${resource ? ':' + slug(resource) : ''}`,
 });
```

`writeNodes`/`writeEdges` (`packages/store/src/graph.js`) need **zero changes** — `assertType`
already validates against `NODE_TYPES`/`EDGE_TYPES`, which is exactly why this whole design fits
inside the frozen API.

---

## 4. UI wiring

### 4.1 Roles subtab (`#rolesBody`) — from the graph the page already fetches

`refreshGraph()` already does `GET /api/projects/:id/graph` into `state.graph` on every Map-tab
load. No new endpoint. Add `renderRoles()`, called from `refreshGraph()` right where
`renderGraphSvg()`/`renderLedger()` already are:

```js
function renderRoles(){
  var g = state.graph, host = document.getElementById('rolesBody');
  if(!host || !g) return;
  var actors = (g.nodes||[]).filter(function(n){ return n.type==='ACTOR'; });
  var roles  = (g.nodes||[]).filter(function(n){ return n.type==='ROLE'; });
  if(!actors.length && !roles.length){
    host.innerHTML = sfEmpty('No ACTOR or ROLE nodes found in this codebase — the current heuristics (role constants/enums, requireRole/hasRole/@Roles/current_user.x? checks, CanCan/Spring/Laravel/Django ability declarations) found nothing to extract. Real gap, not a rendering bug.');
    return;
  }
  // actor catalog + a role × (actors / endpoints / permissions) table, each cell built from
  // g.edges filtered by HAS_ROLE / REQUIRES_ROLE / GRANTS touching that role's id — same
  // "filter edges by src/dst" pattern endpointsForFeature() already uses.
  ...
}
```

Table shape: one row per `ROLE` node — columns *Role*, *Held by* (actor names via incoming
`HAS_ROLE`, or "—" if none — the honest gap from §1.3), *Required by* (endpoint/feature names via
incoming `REQUIRES_ROLE`), *Grants* (permission names via outgoing `GRANTS`, or "—"). Plus a
plain actor list above it (name + `file:line` claim) for actors with no roles at all.

### 4.2 Inventories subtab (`#invBody`) — new fetch, new render

Add a `refreshInventory()` called alongside `refreshGraph()` (same trigger points: initial Map-tab
load, and after a re-map):

```js
function refreshInventory(){
  if(!state.project) return Promise.resolve();
  return get('/api/projects/'+state.project.id+'/inventory').then(function(inv){
    state.inventory = inv;
    renderInventory();
  });
}
function renderInventory(){
  var inv = state.inventory, host = document.getElementById('invBody');
  if(!host || !inv) return;
  if(!inv.rows.length){ host.innerHTML = sfEmpty('No inventory recorded yet. Run Map to generate one.'); return; }
  var byKind = {};
  inv.rows.forEach(function(r){ (byKind[r.kind]=byKind[r.kind]||[]).push(r); });
  host.innerHTML = Object.keys(byKind).sort().map(function(kind){
    var rows = byKind[kind];
    return '<div class="kicker" style="margin-top:14px;">'+esc(kind)+' <span class="muted">· '+rows.length+'</span></div>'
      + '<table class="grid"><tbody>' + rows.map(function(r){
          return '<tr><td class="mono muted">'+esc(r.file)+':'+r.line+'</td><td>'+esc(JSON.stringify(r.detail))+'</td></tr>';
        }).join('') + '</tbody></table>';
  }).join('');
}
```

(Real implementation formats `detail` per-kind instead of raw JSON — e.g. `GET /orders/:id ·
guarded` for `ENDPOINT` — the JSON dump above is the design-doc placeholder for "group by kind,
one table per kind, file:line + detail per row"; no fabricated columns beyond what `detail`
actually carries.)

### 4.3 No fabricated data — the S1 guard

Both renderers follow the existing rule already enforced by `renderLedger`/`renderGraphSvg`: if
the relevant node/row set is empty, render `sfEmpty(...)` with an honest, specific message — never
placeholder rows. `apps/server/test/ui-smoke.test.js` greps `index.html` for known fabrication
markers; this design adds no new sample strings to that file (the two subtabs' current static
empty-state divs are *replaced* by the JS renderers above, not left as dead markup, so there's no
new string for that test to need updating for — it only forbids specific literal marker strings
that never appear here).

---

## 5. Test plan

**`packages/map/test/map.test.js`** — one new fixture-based test alongside the existing ones,
same `tmpRoot`/`store`/`mapProject()` harness:

- Fixture files under a fresh project dir:
  - `app/models/user.rb`: `class User < ApplicationRecord` + `devise :database_authenticatable` +
    `has_many :roles` → expect an `ACTOR` row/node named `User`.
  - `app/models/role.rb`: `enum role: { admin: 0, editor: 1 }` → expect `ROLE` rows/nodes `admin`,
    `editor`.
  - `app/controllers/admin_controller.rb`: an `ENDPOINT` line (`get '/admin', to: ...`) plus
    `before_action :authenticate_user!` plus `hasRole('admin')` in the same file → expect a
    `ROLE_CHECK` row, and the resulting graph to have `ENDPOINT --REQUIRES_ROLE--> ROLE(admin)`.
  - `app/models/ability.rb`: `can :manage, Post` → expect a `PERMISSION` node
    (`action: manage, resource: Post`).
- Assertions:
  - `result.status === 'MAPPED'`.
  - `graph.nodes` contains one `ACTOR` node, two `ROLE` nodes, one `PERMISSION` node.
  - `graph.edges` contains a `HAS_ROLE` edge from the `ACTOR` to each `ROLE` (single-actor rule,
    §1.3) and a `REQUIRES_ROLE` edge from the `ENDPOINT` to `ROLE(admin)`.
  - `snapshots/<sid>/inventory.jsonl` exists on disk, parses as JSONL, and contains rows of kind
    `ACTOR`, `ROLE`, `PERMISSION`, `ROLE_CHECK` with the expected `file`/`line`.
- A second, smaller test: a fixture with **no** role/actor signals at all (just an endpoint) —
  assert `graph.nodes` has no `ACTOR`/`ROLE`/`PERMISSION` nodes and `inventory.jsonl` has no rows
  of those kinds. This is the honest-negative-case guard — proves the feature doesn't invent hits.

**`apps/server/test/routes.test.js`** — one new test: map a fixture project, then
`GET /api/projects/:id/inventory` and assert `{rows, counts}` shape and that counts match the rows
persisted by `mapProject()` in the same test.

**Regression** — run the full suite (`npm test` at repo root, currently 80 tests): the schema
additions are purely additive (`assertType` allow-lists grow, nothing is removed or renamed), the
graph API signature is untouched, and `buildGraph()`'s existing `ENDPOINT`/`SERVICE`/`JOB`/
`DATA_STORE` node/edge construction is unmodified — only new `if (row.kind === ...)` branches are
added alongside it — so no existing map/assess/routes/ui-smoke test should need updating.

---

## 6. Risks

- **False positives.** The curated `ACTOR_NOUN_RE` list (`User`, `Account`, `Member`, ...) will
  miss a domain that calls its actor something else (`Tenant`, `Player`) unless the devise/role-
  association signal also fires — accepted as an honest miss, not silently guessed. Conversely a
  non-actor model coincidentally named `Member` (e.g. a `TeamMember` join-table with no auth role
  at all) becomes a false-positive `ACTOR` node — low blast radius (it's additive catalog noise,
  not a security verdict) but worth a note in the Roles subtab's caption ("heuristic, may include
  unrelated domain models").
- **False negatives dominate.** Every regex list here is intentionally short (a handful of
  frameworks) — most real codebases will show partial or empty Roles/Inventories data even when
  roles genuinely exist in source, if the framework isn't one of the six covered. This is the
  correct failure mode (say nothing rather than guess) but will look "incomplete" to a user
  comparing against a codebase with home-grown RBAC. Document this expectation, don't try to
  cover every framework in v1 — expand the matcher table when a real project needs it (YAGNI).
- **Language-agnosticism.** The matcher table is deliberately per-framework rather than
  per-language, same as the existing `matchEndpoint`/`AUTHN_RE`/`AUTHZ_RE` design — a codebase in
  an uncovered framework yields zero role/actor/permission rows, same honest-empty behaviour as
  today's engine for an uncovered routing style.
- **`GRANTS` under-detection is by design** (§1.4) — flag this loudly in the Roles subtab caption
  so a reader doesn't conclude "this role has no permissions" when the real story is "the
  permission check happens on a different line than the role check."
- **Breaking the 80 existing tests.** Mitigated by the additive-only schema change and by not
  touching any existing `buildGraph()` branch — see §5. The one place with real risk is
  `persistSnapshot()` gaining a second write (`inventory.jsonl`) next to `source-manifest.jsonl`;
  keep it in the same function, same tmp+rename idiom, so a failure there fails the same way a
  manifest write failure already would (nothing partially commits — same pattern, no new failure
  mode introduced).
- **Honest-coverage principle.** Every new node type ships with an explicit "what this can't
  detect" surfaced in the UI caption (§4.1, §4.3), not just this doc — QA's P3-1/P3-2 gap was
  about a *missing feature*; the fix must not create a new gap where the feature is *present but
  overclaims*. No table in this design renders a placeholder row when data is absent.
