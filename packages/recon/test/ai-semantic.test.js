import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planClusters, summarizeClusters, mergeReconPlans } from '../src/ai-semantic.js';
import { makeEvidenceVerifier, validateOntology } from '../src/evidence-validator.js';

// A minimal deterministic-cluster fixture shaped like semantic-planner.js's deterministicSemanticPlan output.
function cluster({ slug, domain = 'core', name, file, line, entry }) {
  return { slug, domain, name: name || slug, rows: [{ kind: 'routes_endpoints', row: { file, line, entry } }] };
}

// A tiny frozen snapshot for evidence-validator to ground against.
const SNAPSHOT = {
  'app/controllers/expenses_controller.rb': [
    'class ExpensesController < ApplicationController',
    '  def show',
    '    authorize @expense',
    '  end',
    'end',
  ].join('\n'),
  'spec/roles/admin_spec.rb': 'role "admin" # test-only, never establishes identity\n',
};
const verifier = () => makeEvidenceVerifier({ readSource: (rel) => SNAPSHOT[rel] || '' });

// Fake adapter: echoes back one feature per candidate cluster found in the prompt, citing that cluster's own first
// sample {file, line} verbatim — exactly the "only cite what you were shown" contract planClusters enforces.
function echoAdapter(extra = {}) {
  const calls = [];
  return {
    calls,
    async ask(prompt) {
      calls.push(prompt);
      const clustersJson = prompt.match(/CANDIDATE CLUSTERS \(\d+\):\n([\s\S]*)$/)[1];
      const clusters = JSON.parse(clustersJson);
      const features = clusters.map((c) => ({
        name: c.name, slug: c.slug, domain: c.domain, purpose: 'test feature',
        include_paths: c.paths, include_terms: [],
        evidence: c.samples.length ? [{ file: c.samples[0].file, line: c.samples[0].line }] : [],
      }));
      return JSON.stringify({ features, actors: [], roles: [], permissions: [], relationships: [], gaps: [], ...extra(clusters) });
    },
  };
}

describe('summarizeClusters', () => {
  test('carries structured {kind, file, line, entry} samples the model can legally cite', () => {
    const [summary] = summarizeClusters([cluster({ slug: 'expenses', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' })]);
    assert.deepEqual(summary.samples[0], { kind: 'routes_endpoints', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' });
  });
});

describe('planClusters', () => {
  test('(a) well-formed plan with grounding evidence is accepted by validateOntology', async () => {
    const clusters = [cluster({ slug: 'expenses', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' })];
    const adapter = echoAdapter(() => ({}));
    const raw = await planClusters(clusters, adapter, { model: 'test-model' });
    assert.ok(raw);
    const { ontology, accepted } = validateOntology(raw, verifier());
    assert.equal(accepted.features, 1);
    assert.equal(ontology.features[0].slug, 'expenses');
  });

  test('(b) a plan citing a nonexistent file:line is rejected by evidence-validator', async () => {
    const clusters = [cluster({ slug: 'ghost', file: 'app/controllers/does_not_exist.rb', line: 1, entry: 'def nope' })];
    const adapter = echoAdapter(() => ({}));
    const raw = await planClusters(clusters, adapter, {});
    assert.ok(raw);
    const { ontology, rejected } = validateOntology(raw, verifier());
    assert.equal(ontology.features.length, 0);
    assert.ok(rejected.some((r) => r.kind === 'feature' && r.name === 'ghost'));
  });

  test('(c) a role cited ONLY from a test/fixture path is rejected by canEstablishIdentity', async () => {
    const clusters = [cluster({ slug: 'admin-role', file: 'spec/roles/admin_spec.rb', line: 1, entry: 'role "admin"' })];
    const adapter = {
      async ask() {
        return JSON.stringify({
          features: [], actors: [], permissions: [], relationships: [], gaps: [],
          roles: [{ name: 'admin', evidence: [{ file: 'spec/roles/admin_spec.rb', line: 1 }] }],
        });
      },
    };
    const raw = await planClusters(clusters, adapter, {});
    assert.ok(raw);
    const { ontology, rejected } = validateOntology(raw, verifier());
    assert.equal(ontology.roles.length, 0);
    assert.ok(rejected.some((r) => r.kind === 'role' && r.name === 'admin'));
  });

  test('(d) adapter returns garbage/prose -> planClusters fails closed and returns null, never throws', async () => {
    const clusters = [cluster({ slug: 'expenses', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' })];
    const proseAdapter = { async ask() { return "Sure! Here are the business features you asked about, no JSON needed."; } };
    const raw = await planClusters(clusters, proseAdapter, {});
    assert.equal(raw, null);
  });

  test('(d) adapter that throws is fail-closed, not a thrown exception', async () => {
    const clusters = [cluster({ slug: 'expenses', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' })];
    const throwingAdapter = { async ask() { throw new Error('network exploded'); } };
    const raw = await planClusters(clusters, throwingAdapter, {});
    assert.equal(raw, null);
  });

  test('returns null when there is nothing to plan', async () => {
    const adapter = echoAdapter(() => ({}));
    assert.equal(await planClusters([], adapter, {}), null);
  });

  test('returns null when adapter is missing/malformed', async () => {
    const clusters = [cluster({ slug: 'expenses', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' })];
    assert.equal(await planClusters(clusters, null, {}), null);
    assert.equal(await planClusters(clusters, {}, {}), null);
  });

  test('(e) chunking + parallel merge: multiple domains fan out to separate ask() calls and merge into one plan', async () => {
    const clusters = [
      cluster({ slug: 'expenses', domain: 'core', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' }),
      cluster({ slug: 'invoices', domain: 'billing', file: 'app/controllers/expenses_controller.rb', line: 3, entry: 'authorize @expense' }),
      cluster({ slug: 'audits', domain: 'ops', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' }),
    ];
    const adapter = echoAdapter(() => ({}));
    // maxBytes tiny enough that the single-shot budget check fails and planClusters must fan out per-domain.
    const raw = await planClusters(clusters, adapter, { maxBytes: 10 });
    assert.ok(raw);
    assert.ok(adapter.calls.length > 1, 'expected more than one ask() call (fanned out per domain)');
    const slugs = raw.features.map((f) => f.slug).sort();
    assert.deepEqual(slugs, ['audits', 'expenses', 'invoices']);
  });

  test('(e) chunking path folds a failed chunk into gaps without dropping the plan', async () => {
    const clusters = [
      cluster({ slug: 'expenses', domain: 'core', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' }),
      cluster({ slug: 'broken', domain: 'billing', file: 'app/controllers/expenses_controller.rb', line: 2, entry: 'def show' }),
    ];
    let call = 0;
    const adapter = {
      async ask(prompt) {
        call += 1;
        if (prompt.includes('"billing"')) return 'not json at all, sorry';
        return echoAdapter(() => ({})).ask(prompt);
      },
    };
    const raw = await planClusters(clusters, adapter, { maxBytes: 10 });
    assert.ok(raw);
    assert.equal(raw.features.length, 1);
    assert.equal(raw.features[0].slug, 'expenses');
    assert.ok(raw.gaps.length >= 1);
  });
});

describe('mergeReconPlans', () => {
  test('deduplicates features by domain/slug and unions evidence', () => {
    const merged = mergeReconPlans([
      { features: [{ slug: 'x', domain: 'core', evidence: [{ file: 'a.rb', line: 1 }] }] },
      { features: [{ slug: 'x', domain: 'core', evidence: [{ file: 'b.rb', line: 2 }] }] },
    ]);
    assert.equal(merged.features.length, 1);
    assert.equal(merged.features[0].evidence.length, 2);
  });
});
