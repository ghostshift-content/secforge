import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicSemanticPlan, summarizeClusters, validateLeadPlan, inventoryRows } from '../src/semantic-planner.js';

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
