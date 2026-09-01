import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/graph.js';

const project = { id: 'project:demo', name: 'Demo' };

function inv(overrides = {}) {
  return {
    routes_endpoints: [], rest_api: [], graphql: [], workers_jobs: [], services_finders_policies: [],
    response_shaping: [], downloads_uploads_exports: [], search_aggregation: [], tokens_actors: [],
    processes_ipc: [], datastores_integrations: [], ...overrides,
  };
}
const byType = (nodes, type) => nodes.filter((n) => n.type === type);
const edge = (edges, type, src, dst) => edges.find((e) => e.type === type && e.src === src && e.dst === dst);

describe('buildGraph() — node/edge types from a hand-built inventory', () => {
  const inventories = inv({
    routes_endpoints: [{ file: 'app/controllers/orders_controller.rb', line: 10, entry: "get '/orders/:id'" }],
    workers_jobs: [{ file: 'app/jobs/export_job.rb', line: 1, entry: 'ExportJob' }],
    services_finders_policies: [
      { file: 'app/models/order.rb', line: 1, entry: 'order.rb', detail: 'model' },
      { file: 'app/services/order_service.rb', line: 1, entry: 'order_service.rb', detail: 'service' },
    ],
    datastores_integrations: [
      { file: 'config/database.yml', line: 1, entry: 'database.yml', detail: 'datastore' },
      { file: 'config/redis.yml', line: 1, entry: 'redis.yml', detail: 'integration' },
    ],
    processes_ipc: [{ file: 'Procfile', line: 1, entry: 'web: puma' }],
  });
  const ontology = { features: [{ name: 'Orders', slug: 'orders', domain: 'core', include_paths: ['orders_controller', 'order.rb', 'order_service.rb', 'export_job'] }] };

  const { nodes, edges, features, coverage, reconciliation } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });

  test('produces PROJECT, DOMAIN, FEATURE nodes and CONTAINS wiring', () => {
    assert.equal(byType(nodes, 'PROJECT').length, 1);
    assert.equal(byType(nodes, 'DOMAIN').length, 1);
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(feature);
    assert.equal(features.length, 1);
    assert.ok(edge(edges, 'CONTAINS', project.id, byType(nodes, 'DOMAIN')[0].id));
    assert.ok(edge(edges, 'CONTAINS', byType(nodes, 'DOMAIN')[0].id, feature.id));
  });

  test('routes_endpoints resolves to an ENDPOINT with EXPOSES from the feature', () => {
    const ep = byType(nodes, 'ENDPOINT').find((n) => n.data.route === '/orders/:id');
    assert.ok(ep);
    assert.equal(ep.data.method, 'GET');
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(edge(edges, 'EXPOSES', feature.id, ep.id));
    assert.ok(ep.claims.some((c) => c.file === 'app/controllers/orders_controller.rb' && c.line === 10));
  });

  test('workers_jobs → JOB wired HANDLED_BY (per design table)', () => {
    const job = byType(nodes, 'JOB')[0];
    assert.ok(job);
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(edge(edges, 'HANDLED_BY', feature.id, job.id));
  });

  test('services_finders_policies "model" → MODEL wired HANDLED_BY, not READS', () => {
    const model = byType(nodes, 'MODEL')[0];
    assert.ok(model);
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(edge(edges, 'HANDLED_BY', feature.id, model.id));
    assert.equal(edges.some((e) => e.type === 'READS' && e.dst === model.id), false);
  });

  test('services_finders_policies "service" → SERVICE wired USES_SERVICE', () => {
    const service = byType(nodes, 'SERVICE').find((n) => n.data.kind === 'service');
    assert.ok(service);
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(edge(edges, 'USES_SERVICE', feature.id, service.id));
  });

  test('datastores_integrations is PROJECT-level, never per-feature', () => {
    const ds = byType(nodes, 'DATA_STORE')[0];
    const integ = byType(nodes, 'INTEGRATION')[0];
    assert.ok(ds && integ);
    assert.ok(edge(edges, 'CONTAINS', project.id, ds.id));
    assert.ok(edge(edges, 'USES_INTEGRATION', project.id, integ.id));
    const feature = byType(nodes, 'FEATURE')[0];
    assert.equal(edges.some((e) => e.src === feature.id && (e.dst === ds.id || e.dst === integ.id)), false);
  });

  test('processes_ipc is PROJECT-level PROCESS via CONTAINS', () => {
    const proc = byType(nodes, 'PROCESS')[0];
    assert.ok(proc);
    assert.ok(edge(edges, 'CONTAINS', project.id, proc.id));
  });

  test('coverage reports feature/technical numbers, not hardcoded zero', () => {
    assert.ok(coverage.feature_count >= 1);
    assert.ok(coverage.semantic_coverage > 0);
  });

  test('reconciliation: one row per inventory row, zero UNRECONCILED', () => {
    // 1 routes_endpoints + 1 workers_jobs + 2 services_finders_policies (feature-bearing) +
    // 2 datastores_integrations + 1 processes_ipc (infra) = 7.
    assert.equal(reconciliation.length, 7);
    assert.equal(reconciliation.filter((r) => r.status === 'UNRECONCILED').length, 0);
    assert.equal(reconciliation.filter((r) => r.status === 'MAPPED_TO_FEATURE').length, 4);
    assert.equal(reconciliation.filter((r) => r.status === 'SHARED_INFRASTRUCTURE').length, 3);
  });
});

describe('buildGraph() — GraphQL row synthesizes an ENDPOINT the rule engine can use', () => {
  test('Query field with an ID-shaped arg → GET /graphql/Query/<field>/{arg} (matches assess PARAM_RE)', () => {
    const inventories = inv({
      graphql: [{ file: 'src/resolvers/expense.js', line: 5, entry: 'Query expense(id): Expense',
        detail: 'graphql-sdl-field', operation_type: 'Query', field_name: 'expense', args: [{ name: 'id', type: 'ID!', isID: true }] }],
    });
    const ontology = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', include_paths: ['resolvers/expense'] }] };
    const { nodes } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const ep = nodes.find((n) => n.type === 'ENDPOINT' && n.data.interface_kind === 'graphql');
    assert.ok(ep, 'expected a synthesized GraphQL ENDPOINT');
    assert.equal(ep.data.method, 'GET');
    assert.equal(ep.data.route, '/graphql/Query/expense/{id}');
    assert.match(ep.data.route, /:\w+|<\w+>|\{\w+\}/); // assess/graph-utils.js PARAM_RE
  });

  test('Mutation field → POST /graphql/Mutation/<field>, no id suffix', () => {
    const inventories = inv({
      graphql: [{ file: 'src/resolvers/expense.js', line: 20, entry: 'Mutation createExpense(input): Expense',
        detail: 'graphql-sdl-field', operation_type: 'Mutation', field_name: 'createExpense', args: [{ name: 'input', type: 'ExpenseInput!', isID: false }] }],
    });
    const ontology = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', include_paths: ['resolvers/expense'] }] };
    const { nodes } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const ep = nodes.find((n) => n.type === 'ENDPOINT' && n.data.interface_kind === 'graphql');
    assert.ok(ep);
    assert.equal(ep.data.method, 'POST');
    assert.equal(ep.data.route, '/graphql/Mutation/createExpense');
  });

  test('an unresolvable graphql row (bare type/field decl) becomes GRAPHQL_OPERATION, never ENDPOINT', () => {
    const inventories = inv({
      graphql: [{ file: 'app/graphql/types/expense_type.rb', line: 3, entry: 'field :amount, Integer', detail: 'graphql-field' }],
    });
    const { nodes } = buildGraph({ inventories, ontology: null, project, snapshotId: 's1' });
    assert.equal(nodes.filter((n) => n.type === 'ENDPOINT').length, 0);
    assert.equal(byType(nodes, 'GRAPHQL_OPERATION').length, 1);
  });
});

describe('buildGraph() — §7 refinement 1: Rails AUTHN is class-level, AUTHZ stays body-scoped', () => {
  // Rails-shaped: `before_action :authenticate_user!` is a CLASS-level macro (never inside an
  // action body) and applies to the whole controller; `authorize @expense` is BODY-scoped
  // (inside one action only). Rows use the real detail values @secforge/map's rails-routes
  // synthesis + @secforge/inventories/rails.js produce ('rails-synth' / 'authn').
  const file = 'app/controllers/expenses_controller.rb';
  const inventories = inv({
    routes_endpoints: [
      { file, line: 10, method: 'GET', route: '/expenses/:id', entry: 'action show', detail: 'rails-synth', body: { startLine: 10, endLine: 14 } },
      { file, line: 20, method: 'GET', route: '/expenses/:id/download_receipt', entry: 'action download_receipt', detail: 'rails-synth', body: { startLine: 20, endLine: 24 } },
    ],
    tokens_actors: [
      { file, line: 2, entry: 'before_action :authenticate_user!', detail: 'authn', controllerClass: 'ExpensesController', controllerParent: 'ApplicationController' }, // class-level, outside any body span
      { file, line: 11, entry: 'authorize @expense', detail: 'permission' }, // inside show's body only
    ],
  });
  const ontology = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', include_paths: ['expenses_controller'] }] };
  const { nodes, edges, features, reconciliation } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
  const show = nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id');
  const download = nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id/download_receipt');

  test('both actions inherit class-level AUTHENTICATED_BY (before_action applies to the whole controller)', () => {
    assert.ok(show && download);
    assert.ok(edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === show.id));
    assert.ok(edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === download.id));
  });

  test('only show (whose body contains the authorize call) gets AUTHORIZED_BY — download_receipt is the IDOR', () => {
    assert.ok(edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === show.id));
    assert.equal(edges.some((e) => e.type === 'AUTHORIZED_BY' && e.src === download.id), false);
  });

  // Phase A §2 reconciliation ledger — both endpoint rows land MAPPED_TO_FEATURE, tied to the
  // Expenses feature id (auth outcome is orthogonal: reconciliation proves the row was TRACED
  // somewhere, not that it was found safe).
  test('reconciliation: both endpoint rows are MAPPED_TO_FEATURE with the Expenses feature_id', () => {
    assert.equal(features.length, 1);
    const expensesId = nodes.find((n) => n.type === 'FEATURE' && n.name === 'Expenses').id;
    const showRecon = reconciliation.find((r) => r.line === 10 && r.kind === 'routes_endpoints');
    const downloadRecon = reconciliation.find((r) => r.line === 20 && r.kind === 'routes_endpoints');
    assert.ok(showRecon && downloadRecon);
    assert.equal(showRecon.status, 'MAPPED_TO_FEATURE');
    assert.equal(downloadRecon.status, 'MAPPED_TO_FEATURE');
    assert.equal(showRecon.feature_id, expensesId);
    assert.equal(downloadRecon.feature_id, expensesId);
  });
});

describe('buildGraph() — §7 refinement 1: inherited authn from ApplicationController + skip_before_action', () => {
  // No before_action in the subclass itself — authn is inherited from ApplicationController.
  const appCtrl = 'app/controllers/application_controller.rb';
  const expensesCtrl = 'app/controllers/expenses_controller.rb';
  const webhooksCtrl = 'app/controllers/webhooks/receipt_ocr_controller.rb';
  const inventories = inv({
    routes_endpoints: [
      { file: expensesCtrl, line: 5, method: 'GET', route: '/expenses/:id', entry: 'action show', detail: 'rails-synth' },
      { file: webhooksCtrl, line: 3, method: 'POST', route: '/webhooks/receipt_ocr', entry: 'action create', detail: 'rails-synth' },
    ],
    tokens_actors: [
      { file: appCtrl, line: 4, entry: 'before_action :authenticate_user!', detail: 'authn', controllerClass: 'ApplicationController', controllerParent: 'ActionController::API' },
      { file: webhooksCtrl, line: 2, entry: 'skip_before_action :authenticate_user!', detail: 'skip-authn', controllerClass: 'Webhooks::ReceiptOcrController', controllerParent: 'ApplicationController' },
    ],
  });
  const ontology = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', include_paths: ['expenses_controller', 'receipt_ocr_controller'] }] };
  const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
  const show = nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/expenses/:id');
  const webhook = nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/webhooks/receipt_ocr');

  test('a subclass with no before_action of its own still gets AUTHENTICATED_BY via the inherited default', () => {
    assert.ok(show);
    assert.ok(edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === show.id));
  });

  test('skip_before_action :authenticate_user! overrides the inherited default — genuinely unauthenticated', () => {
    assert.ok(webhook);
    assert.equal(edges.some((e) => e.type === 'AUTHENTICATED_BY' && e.src === webhook.id), false);
  });
});

// mapper-design.md §CRITICAL rule 2: SecForge's coverage/UI/rules need FEATURE nodes to exist even
// rules-only (no LLM) — codengram's own stricter "no AI → ARCH_CLUSTER only" fail-closed does NOT
// apply here. Fail-closed applies ONLY to ungrounded AI ontology entities, never to feature
// existence: the deterministic cluster is promoted straight to FEATURE, and (since no ontology ran)
// still scrapes zero ACTOR/ROLE/PERMISSION from it — identity stays exclusively the ontology's and
// the legacyRows path's job.
describe('buildGraph() — no ontology → deterministic clusters still become FEATURE, never ROLE', () => {
  const inventories = inv({
    routes_endpoints: [{ file: 'app/controllers/widgets_controller.rb', line: 1, entry: "get '/widgets'" }],
  });
  const { nodes, edges, features } = buildGraph({ inventories, ontology: null, project, snapshotId: 's1' });

  test('the deterministic cluster is promoted to a FEATURE, no ACTOR/ROLE/PERMISSION scraped', () => {
    assert.ok(features.length >= 1);
    assert.ok(byType(nodes, 'FEATURE').length >= 1);
    assert.equal(byType(nodes, 'ARCH_CLUSTER').length, 0);
    assert.equal(byType(nodes, 'ACTOR').length, 0);
    assert.equal(byType(nodes, 'ROLE').length, 0);
    assert.equal(byType(nodes, 'PERMISSION').length, 0);
  });

  test('an ENDPOINT is still reachable from the promoted feature (rules-only mapping stays usable)', () => {
    const feature = byType(nodes, 'FEATURE')[0];
    const ep = byType(nodes, 'ENDPOINT')[0];
    assert.ok(feature && ep);
    assert.ok(edge(edges, 'EXPOSES', feature.id, ep.id));
  });
});

describe('buildGraph() — legacyRows (ROLE/ACTOR/PERMISSION) keep working alongside the AI ontology', () => {
  const legacyRows = [
    { kind: 'ACTOR', file: 'app/models/user.rb', line: 1, name: 'User', assoc: false },
    { kind: 'ROLE', file: 'app/models/role.rb', line: 1, name: 'admin' },
    { kind: 'ROLE_CHECK', file: 'app/controllers/admin_controller.rb', line: 5, role: 'admin' },
    { kind: 'PERMISSION', file: 'app/models/ability.rb', line: 1, action: 'manage', resource: 'Post' },
  ];
  const inventories = inv({
    routes_endpoints: [{ file: 'app/controllers/admin_controller.rb', line: 3, method: 'GET', route: '/admin' }],
  });
  const ontology = { features: [{ name: 'Admin', slug: 'admin', domain: 'core', include_paths: ['admin_controller'] }] };
  const { nodes, edges } = buildGraph({ inventories, ontology, legacyRows, project, snapshotId: 's1' });

  test('ACTOR/ROLE/PERMISSION nodes are created and HAS_ROLE wired (single-actor rule)', () => {
    const actor = nodes.find((n) => n.type === 'ACTOR');
    const role = nodes.find((n) => n.type === 'ROLE');
    const perm = nodes.find((n) => n.type === 'PERMISSION');
    assert.ok(actor && role && perm);
    assert.ok(edge(edges, 'HAS_ROLE', actor.id, role.id));
  });

  test('REQUIRES_ROLE wires the same-file endpoint to the declared role', () => {
    const ep = nodes.find((n) => n.type === 'ENDPOINT' && n.data.route === '/admin');
    const role = nodes.find((n) => n.type === 'ROLE');
    assert.ok(edge(edges, 'REQUIRES_ROLE', ep.id, role.id));
  });
});

// RIX-csrf-missing-token map signal wiring (detector-expansion design §2.1/§3 WP3): the FIRST
// real emitter of the GUARDED_BY edge type.
describe('buildGraph() — RIX-csrf map signal wiring', () => {
  test('a tokens_actors csrf row in the same file adds a GUARDED_BY edge, endpoint -> csrf-guard AUTH_CHECK node', () => {
    const inventories = inv({
      routes_endpoints: [{ file: 'src/routes/account.js', line: 5, entry: "post '/account/email'" }],
      tokens_actors: [{ file: 'src/routes/account.js', line: 2, entry: 'app.use(csrf())', detail: 'csrf' }],
    });
    const ontology = { features: [{ name: 'Account', slug: 'account', domain: 'core', include_paths: ['routes/account'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const ep = byType(nodes, 'ENDPOINT').find((n) => n.data.route === '/account/email');
    assert.ok(ep, 'expected the synthesized POST /account/email endpoint');
    const guard = byType(nodes, 'AUTH_CHECK').find((n) => n.data.kind === 'csrf-guard');
    assert.ok(guard, 'expected a csrf-guard AUTH_CHECK node');
    assert.ok(edge(edges, 'GUARDED_BY', ep.id, guard.id));
  });

  test('no csrf row in the file → no GUARDED_BY edge, no csrf-guard node', () => {
    const inventories = inv({
      routes_endpoints: [{ file: 'src/routes/account.js', line: 5, entry: "post '/account/email'" }],
    });
    const ontology = { features: [{ name: 'Account', slug: 'account', domain: 'core', include_paths: ['routes/account'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    assert.equal(byType(nodes, 'AUTH_CHECK').some((n) => n.data.kind === 'csrf-guard'), false);
    assert.equal(edges.some((e) => e.type === 'GUARDED_BY'), false);
  });
});

// POSITIVE cookie/session-auth evidence wiring (RIX-csrf design — zero false positives): an
// ActionController::Base controller wires AUTHENTICATED_BY -> AUTH_CHECK{kind:'session-cookie'};
// an ActionController::API controller (Meridian rails-api's own shape) never does.
describe('buildGraph() — cookie/session positive-evidence wiring (RIX-csrf zero-false-positive gate)', () => {
  test('an ActionController::Base controller wires AUTHENTICATED_BY to a session-cookie AUTH_CHECK', () => {
    const file = 'app/controllers/sessions_controller.rb';
    const inventories = inv({
      routes_endpoints: [{ file, line: 5, method: 'POST', route: '/sessions', entry: 'action create', detail: 'rails-synth' }],
      tokens_actors: [{ file, line: 1, entry: 'class SessionsController < ActionController::Base', detail: 'action-controller-base', controllerClass: 'SessionsController', controllerParent: 'ActionController::Base' }],
    });
    const ontology = { features: [{ name: 'Sessions', slug: 'sessions', domain: 'core', include_paths: ['controllers/sessions'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const ep = byType(nodes, 'ENDPOINT').find((n) => n.data.route === '/sessions');
    const sc = byType(nodes, 'AUTH_CHECK').find((n) => n.data.kind === 'session-cookie');
    assert.ok(sc, 'expected a session-cookie AUTH_CHECK node');
    assert.ok(edge(edges, 'AUTHENTICATED_BY', ep.id, sc.id));
  });

  test('an ActionController::API controller wires NO session-cookie AUTH_CHECK (rules-only exempt, matches Meridian rails-api)', () => {
    const file = 'app/controllers/users_controller.rb';
    const inventories = inv({
      routes_endpoints: [{ file, line: 5, method: 'POST', route: '/users', entry: 'action create', detail: 'rails-synth' }],
      tokens_actors: [{ file, line: 1, entry: 'class UsersController < ActionController::API', detail: 'action-controller-base', controllerClass: 'UsersController', controllerParent: 'ActionController::API' }],
    });
    const ontology = { features: [{ name: 'Users', slug: 'users', domain: 'core', include_paths: ['controllers/users'] }] };
    const { nodes } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    assert.equal(byType(nodes, 'AUTH_CHECK').some((n) => n.data.kind === 'session-cookie'), false);
  });
});

// CRX-weak-crypto-primitive map signal wiring (detector-expansion design §2.2/§3 WP4).
describe('buildGraph() — CRX weak-crypto map signal wiring', () => {
  test('a services_finders_policies weak-crypto row produces a SYMBOL node via DEFINES', () => {
    const inventories = inv({
      services_finders_policies: [{ file: 'src/crypto.js', line: 3, entry: "createCipheriv('des-ede3', key, iv)", detail: 'weak-crypto' }],
    });
    const ontology = { features: [{ name: 'Crypto', slug: 'crypto', domain: 'core', include_paths: ['crypto.js'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const sym = byType(nodes, 'SYMBOL').find((n) => n.data.kind === 'weak-crypto');
    assert.ok(sym, 'expected a weak-crypto SYMBOL node');
    const feature = byType(nodes, 'FEATURE')[0];
    assert.ok(edge(edges, 'DEFINES', feature.id, sym.id));
  });
});

// Per-feature maps (additive design §2a): every routes_endpoints/rest_api ENDPOINT crosses the
// same untrusted-client -> application trust boundary.
describe('buildGraph() — trust boundary wiring', () => {
  test('an ENDPOINT crosses a shared TRUST_BOUNDARY node via CROSSES_BOUNDARY', () => {
    const inventories = inv({
      routes_endpoints: [{ file: 'app/controllers/orders_controller.rb', line: 10, entry: "get '/orders/:id'" }],
    });
    const ontology = { features: [{ name: 'Orders', slug: 'orders', domain: 'core', include_paths: ['orders_controller'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    const ep = byType(nodes, 'ENDPOINT')[0];
    const boundary = byType(nodes, 'TRUST_BOUNDARY')[0];
    assert.ok(ep && boundary);
    assert.ok(edge(edges, 'CROSSES_BOUNDARY', ep.id, boundary.id));
  });

  test('two endpoints share exactly one TRUST_BOUNDARY node (dedup guard)', () => {
    const inventories = inv({
      routes_endpoints: [
        { file: 'app/controllers/orders_controller.rb', line: 10, entry: "get '/orders/:id'" },
        { file: 'app/controllers/orders_controller.rb', line: 20, entry: "post '/orders'" },
      ],
    });
    const ontology = { features: [{ name: 'Orders', slug: 'orders', domain: 'core', include_paths: ['orders_controller'] }] };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    assert.equal(byType(nodes, 'TRUST_BOUNDARY').length, 1);
    assert.equal(edges.filter((e) => e.type === 'CROSSES_BOUNDARY').length, 2);
  });
});

// Per-feature maps (additive design §2b): two features that share a SERVICE/AUTH_CHECK are
// flagged as likely-same-functionality.
describe('buildGraph() — same-functionality (SHARES_IMPLEMENTATION_WITH) wiring', () => {
  test('two features using the same service node get a SHARES_IMPLEMENTATION_WITH edge', () => {
    // Same file -> same ID.scoped('service', row.file) node id (nodeForRow dedups by id), but two
    // distinct rows so validateLeadPlan's single-winner-per-row scoring can assign one each to
    // Orders (matches "orders") and Billing (matches "billing") — mirrors two features that both
    // call into one shared service module.
    const inventories = inv({
      services_finders_policies: [
        { file: 'app/services/shared_service.rb', line: 1, entry: 'orders helper', detail: 'service' },
        { file: 'app/services/shared_service.rb', line: 2, entry: 'billing helper', detail: 'service' },
      ],
    });
    const ontology = {
      features: [
        { name: 'Orders', slug: 'orders', domain: 'core', include_entries: ['orders'] },
        { name: 'Billing', slug: 'billing', domain: 'core', include_entries: ['billing'] },
      ],
    };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    assert.equal(byType(nodes, 'SERVICE').length, 1, 'both rows must resolve to the same shared service node');
    const [orders, billing] = byType(nodes, 'FEATURE');
    assert.ok(orders && billing);
    assert.ok(
      edge(edges, 'SHARES_IMPLEMENTATION_WITH', orders.id, billing.id) || edge(edges, 'SHARES_IMPLEMENTATION_WITH', billing.id, orders.id),
      'expected SHARES_IMPLEMENTATION_WITH between the two features sharing one service node',
    );
  });

  test('two features using unrelated services get no SHARES_IMPLEMENTATION_WITH edge', () => {
    const inventories = inv({
      services_finders_policies: [
        { file: 'app/services/orders_service.rb', line: 1, entry: 'orders_service.rb', detail: 'service' },
        { file: 'app/services/billing_service.rb', line: 1, entry: 'billing_service.rb', detail: 'service' },
      ],
    });
    const ontology = {
      features: [
        { name: 'Orders', slug: 'orders', domain: 'core', include_paths: ['orders_service'] },
        { name: 'Billing', slug: 'billing', domain: 'core', include_paths: ['billing_service'] },
      ],
    };
    const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
    assert.equal(edges.filter((e) => e.type === 'SHARES_IMPLEMENTATION_WITH').length, 0);
  });
});
