import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { analyze, validateCandidate, computeCoverage } from '@secforge/assess';

// --- tiny in-memory graph builders (mirror the shapes the map engine emits) ---
const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route, extra = {}) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route, ...extra }, claims: [{ file: 'a.js', line: 2 }] });
const dataStore = (id, name) => ({ id, type: 'DATA_STORE', name, data: {}, claims: [] });
const authNode = (id, kind) => ({ id, type: 'AUTH_CHECK', name: kind, data: { kind }, claims: [] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

describe('analyze() — deterministic rules', () => {
  test('IDOR: GET object-read with authn but no authz → ACX/CWE-639', () => {
    const graph = {
      nodes: [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id'), authNode('ac:authn', 'authentication')],
      edges: [edge('EXPOSES', 'f:orders', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn')],
    };
    const cands = analyze(graph, {});
    assert.equal(cands.length, 1);
    const c = cands[0];
    assert.equal(c.rule, 'ACX-idor-no-owner-check');
    assert.equal(c.family, 'ACX');
    assert.equal(c.cwe, 'CWE-639');
    assert.equal(c.endpointId, 'ep');
    assert.equal(c.featureId, 'f:orders');
    assert.equal(validateCandidate(c, graph), true);
  });

  test('IDOR is suppressed once an authz edge is present', () => {
    const graph = {
      nodes: [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id'), authNode('ac:authn', 'authentication'), authNode('ac:authz', 'authorization')],
      edges: [edge('EXPOSES', 'f:orders', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn'), edge('AUTHORIZED_BY', 'ep', 'ac:authz')],
    };
    assert.equal(analyze(graph, {}).length, 0);
  });

  test('missing-auth: endpoint with no authn and no authz → ACX/CWE-306', () => {
    const graph = {
      nodes: [feature('f:pub', 'pub'), endpoint('ep', 'GET', '/public')],
      edges: [edge('EXPOSES', 'f:pub', 'ep')],
    };
    const cands = analyze(graph, {});
    assert.equal(cands.length, 1);
    assert.equal(cands[0].rule, 'ACX-missing-authentication');
    assert.equal(cands[0].cwe, 'CWE-306');
    assert.equal(validateCandidate(cands[0], graph), true);
  });

  test('rate-limit: state-changing endpoint with no rate-limit signal → REX/CWE-770', () => {
    const graph = {
      nodes: [feature('f:orders', 'orders'), endpoint('ep', 'POST', '/orders'), authNode('ac:authn', 'authentication')],
      edges: [edge('EXPOSES', 'f:orders', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn')],
    };
    const cands = analyze(graph, {});
    assert.equal(cands.length, 1);
    assert.equal(cands[0].rule, 'REX-no-rate-limit');
    assert.equal(cands[0].family, 'REX');
    assert.equal(cands[0].cwe, 'CWE-770');
    assert.equal(cands[0].severity, 'medium');
  });

  test('rate-limit is suppressed when the endpoint carries a rateLimited flag', () => {
    const graph = {
      nodes: [feature('f:orders', 'orders'), endpoint('ep', 'POST', '/orders', { rateLimited: true }), authNode('ac:authn', 'authentication')],
      edges: [edge('EXPOSES', 'f:orders', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn')],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'REX-no-rate-limit'), false);
  });

  test('pattern scope filters by family', () => {
    const graph = {
      nodes: [feature('f:orders', 'orders'), endpoint('ep', 'POST', '/orders')],
      edges: [edge('EXPOSES', 'f:orders', 'ep')],
    };
    // POST with no auth → both ACX-missing-authentication and REX-no-rate-limit apply.
    assert.equal(analyze(graph, { patterns: ['REX'] }).every((c) => c.family === 'REX'), true);
    assert.equal(analyze(graph, { patterns: ['ACX'] }).every((c) => c.family === 'ACX'), true);
  });
});

describe('computeCoverage()', () => {
  let tmpRoot, store, pid;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-assess-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    const project = await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'COV' });
    pid = project.id;
    const snapshotId = 'snap-test';
    await writeNodes(store, pid, [
      feature('f:orders', 'orders'),
      endpoint('ep', 'GET', '/orders/:id'),
      authNode('ac:authn', 'authentication'),
      dataStore('ds', 'Order'),
    ], { snapshotId });
    await writeEdges(store, pid, [
      edge('EXPOSES', 'f:orders', 'ep'),
      edge('AUTHENTICATED_BY', 'ep', 'ac:authn'),
      edge('HANDLED_BY', 'f:orders', 'ds'),
    ], { snapshotId });
  });

  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('no findings yet → an ACX cell that has surface reads pass, matrix covers the feature', async () => {
    const cov = await computeCoverage(store, pid);
    assert.equal(typeof cov.percent, 'number');
    assert.equal(cov.matrix.length, 1);
    assert.equal(cov.matrix[0].feature, 'f:orders');
    const acx = cov.matrix[0].cells.find((c) => c.family === 'ACX');
    assert.equal(acx.verdict, 'pass');
    assert.deepEqual(cov.byCwe, []);
  });

  test('after an IDOR finding is written, the ACX cell reads vuln and byCwe groups it', async () => {
    await store.writeFinding(pid, { id: 'finding:F-1-idor', family: 'ACX', cwe: 'CWE-639', feature: 'f:orders', title: 'IDOR' });
    const cov = await computeCoverage(store, pid);
    const acx = cov.matrix[0].cells.find((c) => c.family === 'ACX');
    assert.equal(acx.verdict, 'vuln');
    assert.equal(cov.byCwe.some((r) => r.cwe === 'CWE-639' && r.count === 1), true);
  });
});
