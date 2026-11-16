// @secforge/recon — the agentic mapping Lead (lead.js): engine selection, grounding, fail-closed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planLead, deriveOntology, buildLeadPrompt, PLAN_SCHEMA, leadTurns, LEAD_TURNS } from '../src/lead.js';

// A tiny frozen tree the fake Lead "reads" and the evidence validator proves citations against.
function frozenTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secforge-lead-'));
  fs.mkdirSync(path.join(dir, 'app/controllers'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'app/models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app/controllers/expenses_controller.rb'), 'class ExpensesController < ApplicationController\n  before_action :authenticate_user!\n  def show\n    authorize @expense\n  end\nend\n');
  fs.writeFileSync(path.join(dir, 'app/models/user.rb'), 'class User < ApplicationRecord\n  enum role: { member: 0, admin: 1 }\nend\n');
  return dir;
}
const read = (dir) => (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
const clusters = [{ slug: 'expense', domain: 'core', name: 'Expense', rows: [
  { kind: 'routes_endpoints', row: { file: 'app/controllers/expenses_controller.rb', line: 3, entry: 'action show' } },
  { kind: 'tokens_actors', row: { file: 'app/models/user.rb', line: 2, entry: 'enum role' } },
] }];
const inventories = { routes_endpoints: [clusters[0].rows[0].row], tokens_actors: [clusters[0].rows[1].row] };
const profile = { languages: ['Ruby'], frameworks: ['Rails'], files: 2, entry_points: [] };

const goodPlan = () => ({
  features: [{ name: 'Expense Management', slug: 'expense-management', domain: 'spend', purpose: 'CRUD for expenses.', include_paths: ['app/controllers/expenses_controller.rb'], evidence: [{ file: 'app/controllers/expenses_controller.rb', line: 3, symbol: 'show', reason: 'the action' }] }],
  actors: [{ name: 'User', kind: 'human', evidence: [{ file: 'app/models/user.rb', line: 1, symbol: 'User' }] }],
  roles: [{ name: 'admin', enables: ['expense:read'], evidence: [{ file: 'app/models/user.rb', line: 2, symbol: 'admin' }] }],
  permissions: [{ name: 'expense:read', resource: 'expense', operation: 'read', enabled_by_roles: ['admin'], evidence: [{ file: 'app/controllers/expenses_controller.rb', line: 4, symbol: 'authorize' }] }],
  relationships: [], gaps: [],
});

// Fake adapters: `explore` = agentic (sees cwd/maxTurns/schema); `ask` only = one-shot.
function agenticAdapter(onExplore) {
  const calls = [];
  return { id: 'fake-agentic', model: 'm', calls, async ask() { throw new Error('one-shot path must not be used when explore exists'); },
    async explore(opts) { calls.push(opts); return onExplore(opts); } };
}

describe('lead.js — engine selection', () => {
  test('planLead returns null for an adapter without explore, or without a cwd', async () => {
    assert.equal(await planLead(clusters, { async ask() { return '{}'; } }, { cwd: '/tmp' }), null);
    assert.equal(await planLead(clusters, agenticAdapter(() => ({ ok: true, structured: goodPlan() })), {}), null);
  });
  test('deriveOntology uses the agentic Lead when explore exists, with cwd pinned to the frozen dir and turns from effort', async () => {
    const dir = frozenTree();
    const adapter = agenticAdapter(() => ({ ok: true, structured: goodPlan(), sessionId: 's1', turns: 7, cost: 0.01 }));
    const r = await deriveOntology({ engine: 'fake-agentic', adapter, clusters, inventories, profile, model: 'm', effort: 'high', cwd: dir, readSnapshotFile: read(dir) });
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0].cwd, dir);
    assert.equal(adapter.calls[0].maxTurns, LEAD_TURNS.high);
    assert.deepEqual(adapter.calls[0].schema, PLAN_SCHEMA);
    assert.ok(adapter.calls[0].prompt.includes('ONLY use Read, Glob and Grep'));
    assert.equal(r.llmCalled, true);
    assert.equal(r.ontology.features.length, 1);
    assert.equal(r.ontology.roles.length, 1);
    assert.equal(r.lead.sessionId, 's1');
    assert.equal(r.lead.accepted.features, 1);
  });
  test('deriveOntology falls back to the one-shot ask() path for an adapter without explore', async () => {
    const dir = frozenTree();
    let prompts = 0;
    const adapter = { id: 'fake-oneshot', async ask() { prompts++; return JSON.stringify(goodPlan()); } };
    const r = await deriveOntology({ engine: 'fake-oneshot', adapter, clusters, inventories, profile, cwd: dir, readSnapshotFile: read(dir) });
    assert.equal(prompts, 1);
    assert.equal(r.ontology.features.length, 1);
    assert.equal(r.lead, null);
  });
  test('rules engine never calls anything', async () => {
    const r = await deriveOntology({ engine: 'rules', adapter: agenticAdapter(() => { throw new Error('no'); }), clusters });
    assert.deepEqual(r, { ontology: null, llmCalled: false, lead: null });
  });
});

describe('lead.js — grounding and fail-closed', () => {
  test('an entity citing a file that is not in the frozen snapshot is dropped by validation', async () => {
    const dir = frozenTree();
    const plan = goodPlan();
    plan.features.push({ name: 'Ghost', slug: 'ghost', domain: 'core', purpose: 'invented', evidence: [{ file: 'app/controllers/ghost_controller.rb', line: 1 }] });
    plan.roles.push({ name: 'superuser', evidence: [{ file: 'spec/factories/users.rb', line: 1, symbol: 'superuser' }] }); // spec-only → never establishes a role
    const r = await deriveOntology({ engine: 'fake-agentic', adapter: agenticAdapter(() => ({ ok: true, structured: plan })), clusters, inventories, profile, cwd: dir, readSnapshotFile: read(dir) });
    assert.deepEqual(r.ontology.features.map((f) => f.slug), ['expense-management']);
    assert.deepEqual(r.ontology.roles.map((x) => x.name), ['admin']);
    assert.equal(r.lead.rejected, 2);
  });
  test('explore failure → ontology null, llmCalled true, lead.ok false (never throws)', async () => {
    const dir = frozenTree();
    const r = await deriveOntology({ engine: 'fake-agentic', adapter: agenticAdapter(() => ({ ok: false, error: 'boom' })), clusters, inventories, profile, cwd: dir, readSnapshotFile: read(dir) });
    assert.equal(r.ontology, null);
    assert.equal(r.llmCalled, true);
    assert.equal(r.lead.ok, false);
  });
  test('prose-wrapped JSON in text is parsed when structured_output is absent; pure prose fails closed', async () => {
    const dir = frozenTree();
    const wrapped = agenticAdapter(() => ({ ok: true, structured: null, text: 'Here you go:\n```json\n' + JSON.stringify(goodPlan()) + '\n```' }));
    const r1 = await deriveOntology({ engine: 'fake-agentic', adapter: wrapped, clusters, inventories, profile, cwd: dir, readSnapshotFile: read(dir) });
    assert.equal(r1.ontology.features.length, 1);
    const prose = agenticAdapter(() => ({ ok: true, structured: null, text: 'I could not map this.' }));
    const r2 = await deriveOntology({ engine: 'fake-agentic', adapter: prose, clusters, inventories, profile, cwd: dir, readSnapshotFile: read(dir) });
    assert.equal(r2.ontology, null);
  });
  test('buildLeadPrompt is recon-only, cites the methodology, and carries the cluster samples verbatim', () => {
    const p = buildLeadPrompt({ profile, inventories, summarized: [{ slug: 'expense', domain: 'core', name: 'Expense', row_count: 2, kinds: {}, paths: ['app'], samples: [{ kind: 'routes_endpoints', file: 'app/controllers/expenses_controller.rb', line: 3, entry: 'action show' }] }] });
    assert.ok(p.includes('Recon only'));
    assert.ok(p.includes('MAPPING, NOT HUNTING'));
    assert.ok(p.includes('"file":"app/controllers/expenses_controller.rb","line":3'));
    assert.ok(!/vulnerab\w+ (to|you should) report/i.test(p));
  });
  test('leadTurns maps effort to a turn cap and defaults to medium', () => {
    assert.equal(leadTurns('low'), 16); assert.equal(leadTurns('max'), 60); assert.equal(leadTurns('bogus'), LEAD_TURNS.medium);
  });
});
