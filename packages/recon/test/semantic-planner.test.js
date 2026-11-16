import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicSemanticPlan, summarizeClusters, validateLeadPlan, inventoryRows, INVENTORY_KEYS } from '../src/semantic-planner.js';

function inv(overrides = {}) {
  return {
    routes_endpoints: [], rest_api: [], graphql: [], workers_jobs: [], services_finders_policies: [],
    response_shaping: [], downloads_uploads_exports: [], search_aggregation: [], tokens_actors: [],
    processes_ipc: [], datastores_integrations: [], ...overrides,
  };
}

describe('deterministicSemanticPlan()', () => {
  test('small repo clusters feature-bearing rows by capability noun', () => {
    const inventories = inv({
      routes_endpoints: [
        { file: 'app/controllers/expenses_controller.rb', line: 10, entry: "get '/expenses'" },
        { file: 'app/controllers/expenses_controller.rb', line: 20, entry: "get '/expenses/:id'" },
      ],
      services_finders_policies: [
        { file: 'app/models/expense.rb', line: 1, entry: 'expense.rb', detail: 'model' },
      ],
    });
    const clusters = deterministicSemanticPlan(inventories);
    assert.ok(clusters.length >= 1);
    const expenseCluster = clusters.find((c) => c.slug === 'expense');
    assert.ok(expenseCluster, `expected an 'expense' cluster, got ${clusters.map((c) => c.slug)}`);
    assert.equal(expenseCluster.rows.length, 3);
  });

  test('infra kinds (processes_ipc/datastores_integrations) never enter a feature cluster', () => {
    const inventories = inv({
      processes_ipc: [{ file: 'Procfile', line: 1, entry: 'web: puma' }],
      datastores_integrations: [{ file: 'config/database.yml', line: 1, entry: 'database.yml', detail: 'datastore' }],
    });
    const clusters = deterministicSemanticPlan(inventories);
    assert.equal(clusters.length, 0);
    assert.equal(inventoryRows(inventories).length, 0);
  });

  test('ignores empty inventories (no crash, no fabricated cluster)', () => {
    assert.deepEqual(deterministicSemanticPlan(inv()), []);
  });
});

describe('summarizeClusters()', () => {
  test('carries structured {kind,file,line,entry} samples verbatim (line number must survive)', () => {
    const inventories = inv({
      routes_endpoints: [{ file: 'app/controllers/orders_controller.rb', line: 42, entry: "get '/orders'" }],
    });
    const clusters = deterministicSemanticPlan(inventories);
    const summary = summarizeClusters(clusters);
    assert.equal(summary.length, 1);
    assert.deepEqual(summary[0].samples[0], { kind: 'routes_endpoints', file: 'app/controllers/orders_controller.rb', line: 42, entry: "get '/orders'" });
  });
});

describe('validateLeadPlan()', () => {
  const inventories = inv({
    routes_endpoints: [
      { file: 'app/controllers/expenses_controller.rb', line: 10, entry: "get '/expenses'" },
      { file: 'app/controllers/reports_controller.rb', line: 5, entry: "get '/reports'" },
    ],
  });

  test('returns null for a plan with no features', () => {
    assert.equal(validateLeadPlan(null, inventories), null);
    assert.equal(validateLeadPlan({ features: [] }, inventories), null);
  });

  test('claims rows by explicit inventory_keys, leaves the rest as archClusters', () => {
    const rows = inventoryRows(inventories);
    const expenseRow = rows.find((r) => r.row.file.includes('expenses'));
    const plan = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', inventory_keys: [expenseRow.key] }] };
    const result = validateLeadPlan(plan, inventories);
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].rows.length, 1);
    assert.equal(result.features[0].rows[0].row.file, 'app/controllers/expenses_controller.rb');
    // the unclaimed reports_controller row is preserved as architecture, never silently dropped.
    assert.ok(result.archClusters.length >= 1);
    const archRowCount = result.archClusters.reduce((s, c) => s + c.rows.length, 0);
    assert.equal(archRowCount, 1);
  });

  test('claims rows by include_paths matching', () => {
    const plan = { features: [{ name: 'Expenses', slug: 'expenses', domain: 'core', include_paths: ['expenses_controller'] }] };
    const result = validateLeadPlan(plan, inventories);
    assert.equal(result.features[0].rows.length, 1);
    assert.equal(result.features[0].rows[0].row.file, 'app/controllers/expenses_controller.rb');
  });
});

describe('deterministicSemanticPlan() — module clusters are split by noun (rules-only precision)', () => {
  test('a >40-row module cluster becomes per-noun sub-features; singleton nouns pool into "· Other"', async () => {
    const { INVENTORY_KEYS } = await import('../src/semantic-planner.js');
    const inventories = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));
    const nouns = ['expenses', 'approvals', 'invoices', 'teams'];
    let line = 1;
    for (const n of nouns) for (let i = 0; i < 20; i++) inventories.routes_endpoints.push({ file: `rails-api/app/controllers/${n}_controller.rb`, line: line++, entry: `GET '/${n}/${i}'`, method: 'GET', path: `/${n}/${i}` });
    inventories.routes_endpoints.push({ file: 'rails-api/app/controllers/health_controller.rb', line: 999, entry: "GET '/healthz'", method: 'GET', path: '/healthz' });
    inventories.processes_ipc.push({ file: 'Dockerfile', line: 1, entry: 'Dockerfile', detail: 'process' });
    const clusters = deterministicSemanticPlan(inventories);
    assert.ok(clusters.length >= 5, `expected per-noun split, got ${clusters.map((c) => c.slug).join(',')}`);
    for (const n of ['expense', 'approval', 'invoice', 'team']) {
      const c = clusters.find((x) => x.slug.endsWith('-' + n));
      assert.ok(c, `missing noun cluster ${n}`);
      assert.equal(c.rows.length, 20);
      assert.equal(c.planning_method, 'module-noun-cohesion');
      assert.match(c.name, / · /);
    }
    const other = clusters.find((x) => x.slug.endsWith('-other'));
    assert.ok(other && other.rows.length === 1, 'the lone healthz row pools into · Other, never a 1-row feature');
    assert.equal(clusters.reduce((s, c) => s + c.rows.length, 0), 81, 'no row lost or duplicated by the split');
  });
  test('a module cluster at or under the split threshold is left as one module feature', () => {
    const inventories = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));
    for (let i = 0; i < 40; i++) inventories.routes_endpoints.push({ file: `svc/app/controllers/a_controller.rb`, line: i + 1, entry: `GET '/a/${i}'` });
    for (let i = 0; i < 45; i++) inventories.workers_jobs.push({ file: `svc/app/jobs/j${i}.rb`, line: 1, entry: `J${i}` });
    const clusters = deterministicSemanticPlan(inventories);
    // 85 rows → module mode; module "svc" has 85 rows → split by noun; module "svc" alone would stay if ≤ 40.
    assert.ok(clusters.every((c) => c.rows.length <= 85));
    const small = deterministicSemanticPlan(inventories, { splitThreshold: 1000 });
    assert.equal(small.length, 1);
    assert.equal(small[0].planning_method, 'module-cohesion');
  });
});
