import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, ID, NODE_TYPES, EDGE_TYPES } from '@secforge/schemas';

describe('assertTransition', () => {
  test('allows legal transitions', () => {
    assert.equal(assertTransition('created', 'running'), 'running');
    assert.equal(assertTransition('running', 'paused'), 'paused');
    assert.equal(assertTransition('paused', 'running'), 'running');
    assert.equal(assertTransition('running', 'completed'), 'completed');
  });

  test('throws on illegal transitions', () => {
    assert.throws(() => assertTransition('completed', 'running'), /illegal session transition/);
    assert.throws(() => assertTransition('created', 'paused'), /illegal session transition/);
  });
});

describe('ID builders', () => {
  test('are deterministic', () => {
    assert.equal(ID.feature('My Feature'), ID.feature('My Feature'));
    assert.equal(ID.project('Some Project'), ID.project('Some Project'));
  });

  test('slugify feature names', () => {
    assert.equal(ID.feature('My Feature'), 'feature:my-feature');
  });

  test('build endpoint ids from method + route', () => {
    assert.equal(ID.endpoint('get', '/foo'), 'endpoint:GET:/foo');
  });
});

describe('vocabulary sets', () => {
  test('NODE_TYPES includes the security additions', () => {
    assert.ok(NODE_TYPES.includes('FINDING'));
    assert.ok(NODE_TYPES.includes('VULN_CANDIDATE'));
  });

  test('EDGE_TYPES includes the security additions', () => {
    assert.ok(EDGE_TYPES.includes('GUARDED_BY'));
    assert.ok(EDGE_TYPES.includes('MAPS_TO_CWE'));
  });
});
