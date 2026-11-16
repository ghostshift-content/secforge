import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderPhase1Maps, renderFeatureDoc } from '@secforge/map';

// Synthetic graph in @secforge/store's row shape (see packages/recon/src/graph.js buildGraph()).
const claim = (file, line) => ({ file, line, method: 'grep', confidence: 'medium' });
const N = (id, type, name, data = {}, claims = []) => ({ id, type, name, data, claims });
const E = (type, src, dst, data) => (data ? { id: `edge:${type}:${src}:${dst}`, type, src, dst, data } : { id: `edge:${type}:${src}:${dst}`, type, src, dst });

const nodes = [
  N('project:demo', 'PROJECT', 'demo'),
  N('domain:billing', 'DOMAIN', 'Billing'),
  N('feature:invoices', 'FEATURE', 'Invoices', { domain: 'billing', slug: 'invoices', row_count: 3, purpose: 'Issue and view invoices', planning_method: 'module-cohesion', confidence: 'medium' }),
  N('feature:payments', 'FEATURE', 'Payments', { domain: 'billing', slug: 'payments', row_count: 1, purpose: null, planning_method: 'module-cohesion', confidence: 'low' }),
  N('endpoint:GET:/invoices', 'ENDPOINT', 'GET /invoices', { method: 'GET', route: '/invoices', interface_kind: 'web', file: 'app/invoices.js', line: 10 }, [claim('app/invoices.js', 10)]),
  N('endpoint:POST:/invoices', 'ENDPOINT', 'POST /invoices', { method: 'POST', route: '/invoices', interface_kind: 'rest', file: 'app/invoices.js', line: 20 }, [claim('app/invoices.js', 20)]),
  N('endpoint:DELETE:/invoices/:id', 'ENDPOINT', 'DELETE /invoices/:id', { method: 'DELETE', route: '/invoices/:id', interface_kind: 'rest', file: 'app/invoices.js', line: 30 }, [claim('app/invoices.js', 30)]),
  // Same handler as GET /invoices seen by the controller-action extractor: must collapse into that row.
  N('route:invoices-index', 'ROUTE', 'action index', { file: 'app/invoices.js', line: 10, path: 'action index' }, [claim('app/invoices.js', 10)]),
  N('endpoint:POST:/payments', 'ENDPOINT', 'POST /payments', { method: 'POST', route: '/payments', interface_kind: 'rest', file: 'app/payments.js', line: 5 }, [claim('app/payments.js', 5)]),
  N('authcheck:invoice-policy', 'AUTH_CHECK', 'InvoicePolicy', { kind: 'policy', file: 'app/policies/invoice_policy.rb', line: 1 }, [claim('app/policies/invoice_policy.rb', 1)]),
  N('token:api', 'TOKEN', 'api token check', { kind: 'token', file: 'app/auth.js', line: 3 }, [claim('app/auth.js', 3)]),
  N('role:admin', 'ROLE', 'admin', { name: 'admin' }, [claim('app/roles.js', 2)]),
  N('actor:user', 'ACTOR', 'User', { name: 'User' }, [claim('app/models/user.rb', 1)]),
  N('permission:manage:invoice', 'PERMISSION', 'manage:Invoice', { action: 'manage', resource: 'Invoice' }, [claim('app/ability.rb', 4)]),
  N('model:invoice', 'MODEL', 'Invoice', { kind: 'model', file: 'app/models/invoice.rb', line: 1 }, [claim('app/models/invoice.rb', 1)]),
  N('service:invoice-serializer', 'SERVICE', 'InvoiceSerializer', { kind: 'serializer', file: 'app/serializers/invoice.rb', line: 1 }, [claim('app/serializers/invoice.rb', 1)]),
  N('data_flow:invoice-response', 'DATA_FLOW', 'Response from invoice.rb', { source: 'app/serializers/invoice.rb', line: 1, direction: 'application-to-client' }),
  N('job:invoice-mailer', 'JOB', 'InvoiceMailerJob', { file: 'app/jobs/invoice_mailer.rb', line: 1 }, [claim('app/jobs/invoice_mailer.rb', 1)]),
  N('trust_boundary:untrusted-client-to-application', 'TRUST_BOUNDARY', 'Untrusted client → application', { kind: 'network' }),
  N('arch:core:legacy', 'ARCH_CLUSTER', 'Legacy Scripts', { domain: 'core', slug: 'legacy', row_count: 2, note: 'technical cluster — NOT a confirmed business feature' }),
];
const edges = [
  E('CONTAINS', 'project:demo', 'domain:billing'),
  E('CONTAINS', 'domain:billing', 'feature:invoices'),
  E('CONTAINS', 'domain:billing', 'feature:payments'),
  E('EXPOSES', 'feature:invoices', 'endpoint:GET:/invoices'),
  E('EXPOSES', 'feature:invoices', 'endpoint:POST:/invoices'),
  E('EXPOSES', 'feature:invoices', 'endpoint:DELETE:/invoices/:id'),
  E('EXPOSES', 'feature:invoices', 'route:invoices-index'),
  E('EXPOSES', 'feature:payments', 'endpoint:POST:/payments'),
  E('AUTHORIZED_BY', 'feature:invoices', 'authcheck:invoice-policy'),
  E('AUTHENTICATED_BY', 'feature:invoices', 'token:api'),
  E('HANDLED_BY', 'feature:invoices', 'model:invoice'),
  E('USES_SERVICE', 'feature:invoices', 'service:invoice-serializer'),
  E('USES_SERVICE', 'feature:payments', 'service:invoice-serializer'),
  E('RETURNS_DATA', 'service:invoice-serializer', 'data_flow:invoice-response'),
  E('HANDLED_BY', 'feature:invoices', 'job:invoice-mailer'),
  // GET: authn only. POST: authn + authz + role. DELETE: nothing (state-changing without authz).
  E('AUTHENTICATED_BY', 'endpoint:GET:/invoices', 'token:api'),
  E('AUTHENTICATED_BY', 'endpoint:POST:/invoices', 'token:api'),
  E('AUTHORIZED_BY', 'endpoint:POST:/invoices', 'authcheck:invoice-policy'),
  E('REQUIRES_ROLE', 'endpoint:POST:/invoices', 'role:admin'),
  E('CROSSES_BOUNDARY', 'endpoint:GET:/invoices', 'trust_boundary:untrusted-client-to-application'),
  E('CROSSES_BOUNDARY', 'endpoint:POST:/invoices', 'trust_boundary:untrusted-client-to-application'),
  E('HAS_ROLE', 'actor:user', 'role:admin'),
  E('GRANTS', 'role:admin', 'permission:manage:invoice'),
  E('SHARES_IMPLEMENTATION_WITH', 'feature:invoices', 'feature:payments'),
];
const graph = { nodes, edges };
const reconciliation = [
  { id: 1, kind: 'routes_endpoints', file: 'app/invoices.js', line: 10, entry: "get '/invoices'", status: 'MAPPED_TO_FEATURE', feature_id: 'feature:invoices' },
  { id: 2, kind: 'rest_api', file: 'app/invoices.js', line: 20, entry: "post '/invoices'", status: 'MAPPED_TO_FEATURE', feature_id: 'feature:invoices' },
  { id: 3, kind: 'rest_api', file: 'app/invoices.js', line: 30, entry: "delete '/invoices/:id'", status: 'MAPPED_TO_FEATURE', feature_id: 'feature:invoices' },
  { id: 4, kind: 'rest_api', file: 'app/payments.js', line: 5, entry: "post '/payments'", status: 'MAPPED_TO_FEATURE', feature_id: 'feature:payments' },
  { id: 5, kind: 'workers_jobs', file: 'scripts/cron.rb', line: 1, entry: 'NightlyJob', status: 'UNCLEAR_COVERAGE_GAP', feature_id: null },
  { id: 6, kind: 'ROLE', file: 'app/roles.js', line: 2, entry: 'admin', status: 'SHARED_INFRASTRUCTURE', feature_id: null },
];
const inventories = {
  routes_endpoints: [{ file: 'app/invoices.js', line: 10, entry: "get '/invoices'", detail: 'express' }],
  rest_api: [{ file: 'app/invoices.js', line: 20, entry: "post '/invoices'" }, { file: 'app/invoices.js', line: 30, entry: "delete '/invoices/:id'" }, { file: 'app/payments.js', line: 5, entry: "post '/payments'" }],
  workers_jobs: [{ file: 'scripts/cron.rb', line: 1, entry: 'NightlyJob', detail: 'worker' }],
};
const coverage = { feature_count: 2, technical_clusters: 1, feature_rows: 4, arch_rows: 2, total_rows: 6, technical_coverage: 100, semantic_coverage: 67 };
const provenance = { engine: 'rules', model: null, llmCalled: false, aiSemantic: false };

const HEADINGS = ['## 1. Feature Identity', '## 2. Feature Purpose', '## 3. Entry Points', '## 4. Endpoint / Action Ledger',
  '## 5. Full Code Paths', '## 6. Authorization Map', '## 7. Authentication / Actor Context Map', '## 8. Data Exposure Map',
  '## 9. Background Job Map', '## 10. Same-Functionality Map', '## 11. Assess Handoff', '## 12. Files Reviewed', '## 13. Coverage Notes'];

describe('renderPhase1Maps', () => {
  let tmp, out, read;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-p1maps-'));
    out = renderPhase1Maps({ graph, reconciliation, inventories, features: [], project: { id: 'project:demo', name: 'Demo', sourceRoot: '/src/demo' },
      snapshotId: 'snap1', coverage, provenance, outDir: tmp });
    read = (rel) => fs.readFileSync(path.join(out.root, rel), 'utf8');
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('every feature doc has the 13 headings in order', () => {
    for (const slug of ['invoices', 'payments']) {
      const md = read(`features/${slug}.md`);
      let last = -1;
      for (const h of HEADINGS) { const i = md.indexOf(h); assert.ok(i > last, `${slug}: ${h} missing or out of order`); last = i; }
    }
  });

  test('ledger is per-endpoint with correct authn/authz ticks, guards and roles', () => {
    const md = read('features/invoices.md');
    const ledger = md.slice(md.indexOf('## 4.'), md.indexOf('## 5.'));
    const rows = ledger.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Interface'));
    assert.equal(rows.length, 3);
    const row = (method, route) => rows.find((l) => l.includes(`| ${method} | ${route} |`));
    assert.equal(row('GET', '/invoices'), '| web | GET | /invoices | app/invoices.js:10 | ✓ | ✗ | api token check | — | mapped |');
    assert.equal(row('POST', '/invoices'), '| rest | POST | /invoices | app/invoices.js:20 | ✓ | ✓ | api token check, InvoicePolicy | admin | mapped |');
    assert.equal(row('DELETE', '/invoices/:id'), '| rest | DELETE | /invoices/:id | app/invoices.js:30 | ✗ | ✗ | — | — | mapped |');
    assert.ok(!/action index/.test(ledger), 'a ROUTE sharing an ENDPOINT handler must not become a second ledger row');
    assert.equal(rows.length, 3);
    assert.match(md, /- State-changing without authorization: 1/);
    assert.match(md, /- Endpoints total: 3/);
    assert.match(md, /asserts no findings/);
  });

  test('feature doc content: entry points, data exposure, siblings, files', () => {
    const md = read('features/invoices.md');
    assert.match(md, /### Web Routes \/ Controllers\n\| Route\/Action/);
    assert.match(md, /### GraphQL\n\*\*COVERAGE_GAP\*\*/);
    assert.match(md, /### RPC\n\*\*EXTRACTOR_UNSUPPORTED\*\*/);
    assert.match(md, /GET \/invoices → Untrusted client → application `app\/invoices\.js:10`/);
    assert.match(md, /- \[Payments\]\(\.\/payments\.md\) — shares implementation/);
    assert.match(md, /- InvoiceMailerJob `app\/jobs\/invoice_mailer\.rb:1`/);
    assert.match(md, /\| InvoicePolicy \| policy \|/);
    assert.match(md, /- `app\/policies\/invoice_policy\.rb`/);
    assert.match(md, /Observed roles: `admin`/);
    assert.match(read('features/payments.md'), /_no grounded authorization context mapped_/);
  });

  test('renderFeatureDoc equals the emitted feature file', () => {
    const f = nodes.find((n) => n.id === 'feature:invoices');
    assert.equal(renderFeatureDoc(graph, f, reconciliation), read('features/invoices.md'));
  });

  test('gate reports COMPLETE_WITH_GAPS naming the gap kind', () => {
    const gate = read('consolidated/phase1_completion_gate.md');
    assert.match(gate, /Status: \*\*COMPLETE_WITH_GAPS\*\*/);
    assert.match(gate, /workers_jobs=1/);
    assert.match(gate, /Executed engine: `rules`/);
    assert.equal(JSON.parse(read('manifest.json')).gate, 'COMPLETE_WITH_GAPS');
  });

  test('crosscheck matches and graph jsonl uses from/to', () => {
    assert.match(read('consolidated/phase1_crosscheck_verification.md'), /\*\*match: YES\*\*/);
    const e = JSON.parse(read('graph/edges.jsonl').split('\n')[0]);
    assert.deepEqual(Object.keys(e), ['id', 'type', 'from', 'to', 'data']);
    assert.equal(read('graph/nodes.jsonl').trim().split('\n').length, nodes.length);
  });

  test('roles matrix has the GRANTS wiring tick and actor→role', () => {
    assert.match(read('roles/role-ability-matrix.md'), /\| manage:Invoice \| ✓ \| app\/ability\.rb:4 \|/);
    assert.match(read('roles/role-structure.md'), /\| User \| admin \|/);
    assert.equal(read('roles/role_authz_source_files.txt'), 'app/ability.rb\napp/models/user.rb\napp/roles.js\n');
    assert.match(read('roles/role_structure_hints.txt'), /ROLE\tadmin\tapp\/roles\.js:2/);
  });

  test('manifest lists every emitted file; no phase2 queue; consolidated set complete', () => {
    const manifest = JSON.parse(read('manifest.json'));
    assert.deepEqual(manifest.files, out.files);
    assert.equal(out.files.at(-1), 'manifest.json');
    for (const rel of manifest.files) assert.ok(fs.existsSync(path.join(out.root, rel)), rel);
    assert.ok(!out.files.includes('consolidated/phase2_review_queue.md'));
    for (const rel of ['README.md', 'AI_CONTEXT.md', 'inventories/00_MANIFEST.md', 'inventories/01_routes_endpoints.txt', 'inventories/11_datastores_integrations.txt',
      'ledgers/invoices.jsonl', 'consolidated/00_INDEX.md', 'consolidated/feature_coverage_matrix.md', 'consolidated/source_inventory_coverage_matrix.md',
      'consolidated/same_functionality_cross_feature_map.md', 'consolidated/architecture.md']) assert.ok(out.files.includes(rel), rel);
    assert.equal(manifest.exporter_version, '1');
    assert.equal(manifest.counts.nodes, nodes.length);
    assert.equal(manifest.feature_count, 2);
    assert.equal(manifest.technical_clusters, 1);
  });

  test('ledger jsonl record shapes', () => {
    const recs = read('ledgers/invoices.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(recs[0].record_type, 'feature_summary');
    assert.deepEqual(recs[0].roles, ['admin']);
    assert.equal(recs.filter((r) => r.record_type === 'inventory_row').length, 3);
    const ep = recs.find((r) => r.node_id === 'endpoint:GET:/invoices');
    assert.deepEqual(ep.evidence, [{ file: 'app/invoices.js', line_start: 10, line_end: 10, method: 'grep', confidence: 'medium' }]);
  });

  test('consolidated matrices and index', () => {
    assert.match(read('consolidated/feature_coverage_matrix.md'), /\| \[Invoices\]\(\.\.\/features\/invoices\.md\) \| 1 \| 2 \|/);
    assert.match(read('consolidated/source_inventory_coverage_matrix.md'), /`workers_jobs` \| 1 \| UNCLEAR_COVERAGE_GAP=1/);
    const index = read('consolidated/00_INDEX.md');
    assert.match(index, /Assess handoff \(per-feature §11\)/);
    assert.doesNotMatch(index, /Phase 2 review queue/);
    assert.match(index, /## Billing\n- \[Invoices\]/);
    assert.match(read('consolidated/same_functionality_cross_feature_map.md'), /\| Invoices \| Payments \| shared implementation \|/);
    assert.match(read('consolidated/same_functionality_cross_feature_map.md'), /\| SERVICE \| InvoiceSerializer \| 2 \|/);
    assert.match(read('consolidated/architecture.md'), /## core\n\n\| Technical cluster/);
    assert.match(read('inventories/00_MANIFEST.md'), /`rest_api` \| 3 \| MAPPED_TO_FEATURE=3/);
  });
});
