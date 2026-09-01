// RIX-csrf-missing-token (CWE-352): a state-changing endpoint with POSITIVE cookie/session-auth
// evidence and no CSRF-guard signal. Gated on POSITIVE evidence only — never on the mere absence
// of a bearer token — so a token/JWT API or an ActionController::API app never fires.
// See detector-expansion design §2.1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validateCandidate } from '../src/rules.js';

const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route }, claims: [{ file: 'a.js', line: 2 }] });
const authCheck = (id, kind) => ({ id, type: 'AUTH_CHECK', name: kind, data: { kind }, claims: [] });
const token = (id) => ({ id, type: 'TOKEN', name: 'token', data: { kind: 'token' }, claims: [] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

describe('ruleCsrf() — RIX-csrf-missing-token', () => {
  test('vuln: state-changing endpoint, POSITIVE cookie/session evidence, no csrf guard → fires', () => {
    const graph = {
      nodes: [feature('f:acct', 'account'), endpoint('ep', 'POST', '/account/email'), authCheck('ac:session', 'session-cookie')],
      edges: [edge('EXPOSES', 'f:acct', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:session')],
    };
    const cands = analyze(graph, {});
    const c = cands.find((x) => x.rule === 'RIX-csrf-missing-token');
    assert.ok(c, 'expected an RIX-csrf-missing-token candidate');
    assert.equal(c.family, 'RIX');
    assert.equal(c.cwe, 'CWE-352');
    assert.equal(validateCandidate(c, graph), true);
  });

  test('safe (decisive rejection — no cookie/session evidence at all, e.g. an ActionController::API app): does NOT fire', () => {
    const graph = {
      nodes: [feature('f:acct', 'account'), endpoint('ep', 'POST', '/account/email'), authCheck('ac:authn', 'before_action')],
      edges: [edge('EXPOSES', 'f:acct', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn')],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'RIX-csrf-missing-token'), false);
  });

  test('safe (decisive rejection — guard present): a GUARDED_BY csrf-guard edge suppresses the finding even with positive evidence', () => {
    const graph = {
      nodes: [
        feature('f:acct', 'account'), endpoint('ep', 'POST', '/account/email'),
        authCheck('ac:session', 'session-cookie'), authCheck('ac:csrf', 'csrf-guard'),
      ],
      edges: [
        edge('EXPOSES', 'f:acct', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:session'),
        edge('GUARDED_BY', 'ep', 'ac:csrf'),
      ],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'RIX-csrf-missing-token'), false);
  });

  test('safe (decisive rejection — bearer/API-token auth is exempt): AUTHENTICATED_BY → TOKEN, not session-cookie', () => {
    const graph = {
      nodes: [feature('f:acct', 'account'), endpoint('ep', 'POST', '/account/email'), token('tok:1')],
      edges: [edge('EXPOSES', 'f:acct', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'tok:1')],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'RIX-csrf-missing-token'), false);
  });

  test('does not fire on a GET (not state-changing), even with positive evidence', () => {
    const graph = {
      nodes: [feature('f:acct', 'account'), endpoint('ep', 'GET', '/account'), authCheck('ac:session', 'session-cookie')],
      edges: [edge('EXPOSES', 'f:acct', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:session')],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'RIX-csrf-missing-token'), false);
  });
});
