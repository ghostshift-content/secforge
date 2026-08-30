import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvidenceVerifier, validateOntology } from '../src/evidence-validator.js';

// Tiny in-memory frozen snapshot: rel path -> file text.
const SNAPSHOT = {
  'app/controllers/expenses_controller.rb': [
    'class ExpensesController < ApplicationController',
    '  before_action :authenticate_user!',
    '  def show',
    '    authorize @expense',
    '  end',
    '  def download_receipt',
    '    @expense = Expense.find(params[:id])',
    '  end',
    'end',
  ].join('\n'),
  'app/policies/expense_policy.rb': [
    'class ExpensePolicy < ApplicationPolicy',
    '  def show?',
    '    user.admin? || record.owner == user',
    '  end',
    'end',
  ].join('\n'),
  'spec/policies/expense_policy_spec.rb': 'role "admin" # only ever asserted in tests, never establishes identity\n',
};

function makeVerifier() {
  return makeEvidenceVerifier({ readSource: (rel) => SNAPSHOT[rel] || '' });
}

describe('makeEvidenceVerifier', () => {
  test('grounds a real file:line:symbol citation', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'app/controllers/expenses_controller.rb', line: 3, symbol: 'show' });
    assert.equal(r.ok, true);
  });

  test('rejects a citation against a file not in the snapshot', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'app/controllers/nope_controller.rb', line: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /does not exist in snapshot/);
  });

  test('rejects an out-of-range line', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'app/controllers/expenses_controller.rb', line: 9999 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cited line/);
  });

  test('rejects a symbol that does not appear in the file', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'app/controllers/expenses_controller.rb', symbol: 'totally_made_up_method' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /symbol/);
  });

  test('requireEstablishing rejects identity evidence sourced only from spec/fixture paths', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'spec/policies/expense_policy_spec.rb', line: 1, symbol: 'admin' }, { requireEstablishing: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /non-authoritative/);
  });

  test('requireEstablishing accepts identity evidence from production source', () => {
    const v = makeVerifier();
    const r = v.verify({ file: 'app/policies/expense_policy.rb', line: 2, symbol: 'show?' }, { requireEstablishing: true });
    assert.equal(r.ok, true);
  });
});

describe('validateOntology', () => {
  test('accepts a well-formed plan whose evidence grounds against the snapshot', () => {
    const v = makeVerifier();
    const { ontology, accepted, rejected } = validateOntology({
      features: [{ slug: 'expenses', name: 'Expenses', evidence: [{ file: 'app/controllers/expenses_controller.rb', line: 3, symbol: 'show' }] }],
      actors: [{ name: 'employee', kind: 'human', evidence: [{ file: 'app/policies/expense_policy.rb', line: 2, symbol: 'show?' }] }],
      roles: [{ name: 'admin', evidence: [{ file: 'app/policies/expense_policy.rb', line: 3, symbol: 'admin?' }] }],
      permissions: [{ name: 'view_expense', enabled_by_roles: ['admin'], granted_to_actors: [],
        evidence: [{ file: 'app/policies/expense_policy.rb', line: 2 }] }],
      relationships: [{ from: 'expenses', to: 'admin' }],
    }, v);
    assert.equal(accepted.features, 1);
    assert.equal(accepted.roles, 1);
    assert.equal(accepted.permissions, 1);
    assert.equal(ontology.relationships.length, 1);
    assert.equal(rejected.length, 0);
  });

  test('drops a feature citing a nonexistent file:line', () => {
    const v = makeVerifier();
    const { ontology, rejected } = validateOntology({
      features: [
        { slug: 'real', name: 'Real', evidence: [{ file: 'app/controllers/expenses_controller.rb', line: 1 }] },
        { slug: 'hallucinated', name: 'Hallucinated', evidence: [{ file: 'app/controllers/does_not_exist.rb', line: 1 }] },
      ],
    }, v);
    assert.equal(ontology.features.length, 1);
    assert.equal(ontology.features[0].slug, 'real');
    assert.ok(rejected.some((r) => r.kind === 'feature' && r.name === 'Hallucinated'));
  });

  test('rejects a role cited ONLY from a test/fixture path (canEstablishIdentity gate)', () => {
    const v = makeVerifier();
    const { ontology, rejected } = validateOntology({
      roles: [{ name: 'admin', evidence: [{ file: 'spec/policies/expense_policy_spec.rb', line: 1, symbol: 'admin' }] }],
    }, v);
    assert.equal(ontology.roles.length, 0);
    assert.ok(rejected.some((r) => r.kind === 'role' && r.name === 'admin'));
  });

  test('drops a permission with zero grounded grantee', () => {
    const v = makeVerifier();
    const { ontology, rejected } = validateOntology({
      roles: [{ name: 'admin', evidence: [{ file: 'app/policies/expense_policy.rb', line: 3, symbol: 'admin?' }] }],
      permissions: [{ name: 'orphan_permission', enabled_by_roles: ['nonexistent_role'], granted_to_actors: [],
        evidence: [{ file: 'app/policies/expense_policy.rb', line: 2 }] }],
    }, v);
    assert.equal(ontology.permissions.length, 0);
    assert.ok(rejected.some((r) => r.kind === 'permission' && r.name === 'orphan_permission'));
  });

  test('drops a relationship whose endpoint vanished', () => {
    const v = makeVerifier();
    const { ontology } = validateOntology({
      features: [{ slug: 'real', name: 'Real', evidence: [{ file: 'app/controllers/expenses_controller.rb', line: 1 }] }],
      relationships: [{ from: 'real', to: 'ghost-that-never-existed' }],
    }, v);
    assert.equal(ontology.relationships.length, 0);
  });
});
