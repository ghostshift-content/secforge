import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, readGraph } from '@secforge/store';
import { mapProject } from '@secforge/map';
import { retrieveFeatureContext } from '@secforge/retrieval';
import { renderFeatureMap } from '../src/index.js';

let tmpRoot, store;

before(async () => { tmpRoot = path.join(os.tmpdir(), 'sf-feature-map-' + crypto.randomBytes(4).toString('hex')); store = new Store(tmpRoot); });
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

// Same Meridian-shaped Rails fixture already used by packages/retrieval/test/retrieval.test.js:117-160
// and packages/recon/test/graph.test.js — copied, not reinvented.
describe('renderFeatureMap — real mapProject fixture (Meridian ExpensesController)', () => {
  let src, pid, sid, expensesFeatureId, graph, ctx;

  before(async () => {
    src = path.join(tmpRoot, 'expenses-proj');
    await fs.mkdir(path.join(src, 'app', 'controllers'), { recursive: true });
    await fs.mkdir(path.join(src, 'config'), { recursive: true });
    await fs.writeFile(path.join(src, 'app', 'controllers', 'application_controller.rb'),
      'class ApplicationController < ActionController::Base\n  before_action :authenticate_user!\nend\n');
    await fs.writeFile(path.join(src, 'app', 'controllers', 'expenses_controller.rb'), [
      'class ExpensesController < ApplicationController',
      '  def show',
      '    @expense = Expense.find(params[:id])',
      '    authorize @expense',
      '    render json: @expense',
      '  end',
      '',
      '  def download_receipt',
      '    @expense = Expense.find(params[:id])',
      '    send_file @expense.receipt_path',
      '  end',
      'end',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(src, 'config', 'routes.rb'), [
      'Rails.application.routes.draw do',
      '  resources :expenses, only: [:show] do',
      '    member do',
      '      get :download_receipt',
      '    end',
      '  end',
      'end',
      '',
    ].join('\n'));

    const project = await store.openProject({ sourceRoot: src, name: 'EXPENSES' });
    pid = project.id;
    const result = await mapProject({ sourceRoot: src, store, projectId: pid });
    sid = result.snapshotId;
    assert.equal(result.status, 'MAPPED');
    graph = await readGraph(store, pid, sid);
    expensesFeatureId = graph.nodes.find((n) => n.type === 'FEATURE' && n.name === 'Expense').id;
    ctx = await retrieveFeatureContext(store, pid, expensesFeatureId, { snapshotId: sid });
  });

  test('renders every section header from the design table', () => {
    const md = renderFeatureMap(ctx, graph);
    for (const header of [
      '## 1. Feature Identity', '## 2. Purpose', '## 3. Endpoints',
      '## 4. Actors / Roles / Permissions', '## 5. Services', '## 6. Jobs',
      '## 7. Data stores & data flows', '## 8. Trust boundary',
      '## 9. Same-functionality (shared implementation)', '## 10. Files', '## 11. Coverage',
    ]) {
      assert.ok(md.includes(header), `missing section: ${header}`);
    }
  });

  test('download_receipt row: authn ✓ / authz ✗ with its real citation', () => {
    const md = renderFeatureMap(ctx, graph);
    const row = md.split('\n').find((l) => l.includes('/expenses/:id/download_receipt'));
    assert.ok(row, 'expected a download_receipt endpoint row');
    assert.match(row, /GET \| \/expenses:?\/id\/download_receipt|GET \| \/expenses\/:id\/download_receipt/);
    assert.match(row, /✓/); // authn
    assert.match(row, /✗/); // authz
    assert.match(row, /expenses_controller\.rb:\d+/);
  });

  test('show row: authn — (file-scoped, not shown per-row) / authz ✓', () => {
    const md = renderFeatureMap(ctx, graph);
    const row = md.split('\n').find((l) => l.startsWith('| GET | /expenses/:id |'));
    assert.ok(row, 'expected a /expenses/:id row');
    assert.match(row, /✓ \| ✓/); // authn and authz both true for show
  });

  test('trust boundary section lists both endpoints crossing the shared boundary', () => {
    const md = renderFeatureMap(ctx, graph);
    const section = md.split('## 8. Trust boundary')[1].split('## 9.')[0];
    assert.match(section, /\/expenses\/:id/);
    assert.match(section, /\/expenses\/:id\/download_receipt/);
    assert.doesNotMatch(section, /none detected/);
  });

  test('same-functionality section is honestly empty for a single-feature fixture', () => {
    const md = renderFeatureMap(ctx, graph);
    const section = md.split('## 9. Same-functionality (shared implementation)')[1].split('## 10.')[0];
    assert.match(section, /_no shared implementation detected_/);
  });

  test('coverage section reports real counts, not zero placeholders', () => {
    const md = renderFeatureMap(ctx, graph);
    assert.match(md, /Endpoints: [1-9]\d*/); // rules-only mapping also surfaces ROUTE-shaped rows alongside the 2 real ENDPOINTs
    assert.match(md, /Auth checks: [1-9]\d*/);
  });
});

describe('renderFeatureMap — empty-state honesty (no services/jobs/shares)', () => {
  const emptyCtx = {
    ok: true,
    feature: { id: 'feature:empty', name: 'Empty', domain: 'core', planning_method: 'agent-lead', confidence: 'medium' },
    endpoints: [], authChecks: [], dataStores: [], services: [], jobs: [], actors: [], roles: [], permissions: [],
    files: [], facts: [], citations: [], depth: { hops: 1, endpointCount: 0, memberCount: 0, maxChainLength: 0, filesTouched: 0, capped: false },
  };

  test('every optional section literally reads "_none detected_" — never undefined/null', () => {
    const md = renderFeatureMap(emptyCtx);
    assert.doesNotMatch(md, /undefined/);
    assert.doesNotMatch(md, /\bnull\b/);
    assert.match(md, /_none detected_/);
    assert.match(md, /_no shared implementation detected_/);
    assert.match(md, /_not established — no purpose was derived for this feature_/);
  });

  test('degrades gracefully with NO graph argument at all (defaults to empty)', () => {
    const md = renderFeatureMap(emptyCtx);
    assert.ok(md.startsWith('# Empty'));
  });
});

describe('renderFeatureMap — coverage gap (ctx.ok === false)', () => {
  test('never throws; renders an honest coverage-gap document', () => {
    const md = renderFeatureMap({ ok: false, reason: 'coverage gap: feature not found', featureId: 'feature:missing' });
    assert.match(md, /^# Coverage gap/);
    assert.match(md, /coverage gap: feature not found/);
  });

  test('never throws on null/undefined ctx either', () => {
    assert.doesNotThrow(() => renderFeatureMap(null));
    assert.doesNotThrow(() => renderFeatureMap(undefined));
  });
});
