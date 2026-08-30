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

  const { nodes, edges, features, coverage } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });

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
  const { nodes, edges } = buildGraph({ inventories, ontology, project, snapshotId: 's1' });
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
