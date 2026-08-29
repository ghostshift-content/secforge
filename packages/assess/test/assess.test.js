import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { mapProject } from '@secforge/map';
import { cweName } from '@secforge/patterns';
import {
  analyze, validateCandidate, computeCoverage,
  severityFromScore, decorateFinding, buildSnippet, loadManifest, readSourceRoot, runAssessment,
} from '@secforge/assess';

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

describe('severityFromScore() — CVSS v3.1 bands', () => {
  test('band boundaries', () => {
    assert.equal(severityFromScore(9.0), 'critical');
    assert.equal(severityFromScore(7.5), 'high');   // SDX & missing-auth land here
    assert.equal(severityFromScore(7.0), 'high');
    assert.equal(severityFromScore(6.5), 'medium'); // IDOR
    assert.equal(severityFromScore(5.3), 'medium'); // REX
    assert.equal(severityFromScore(4.0), 'medium');
    assert.equal(severityFromScore(0.1), 'low');
    assert.equal(severityFromScore(0), 'info');
  });
});

describe('decorateFinding() — pure enrichment', () => {
  const base = (rule, cwe) => ({
    id: 'finding:F-1-x', rule, cwe, family: 'SDX', title: 't',
    method: 'GET', route: '/x/:id', evidence: { file: 'a.js', line: 3 }, severity: 'critical',
  });

  test('SDX derives high (not the old hardcoded critical) + carries cvss vector/score', () => {
    const d = decorateFinding(base('SDX-unauth-datastore-reachable', 'CWE-200'), {});
    assert.equal(d.severity, 'high');
    assert.equal(d.cvss.score, 7.5);
    assert.match(d.cvss.vector, /^CVSS:3\.1\//);
  });

  test('cwe_name is looked up (never invented); unknown cwe → null', () => {
    const d = decorateFinding(base('ACX-idor-no-owner-check', 'CWE-639'), {});
    assert.equal(d.cwe_name, 'Insecure Direct Object Reference (IDOR)');
    assert.equal(cweName('CWE-639'), d.cwe_name);
    assert.equal(cweName('CWE-99999'), null);
    const u = decorateFinding({ ...base('ACX-idor-no-owner-check', 'CWE-99999') }, {});
    assert.equal(u.cwe_name, null);
  });

  test('description + remediation are non-empty and carry the graph clearing condition', () => {
    const d = decorateFinding(base('ACX-missing-authentication', 'CWE-306'), {});
    assert.ok(d.description.includes('/x/:id') && d.description.includes('a.js:3'));
    assert.match(d.remediation, /AUTHENTICATED_BY edge/);
  });

  test('snippet is passed through untouched', () => {
    const snip = { file: 'a.js', startLine: 1, endLine: 5, lines: ['x'], sha256: 'abc', stale: false };
    assert.deepEqual(decorateFinding(base('REX-no-rate-limit', 'CWE-770'), { snippet: snip }).snippet, snip);
  });
});

describe('buildSnippet() — sha match vs stale-on-edit (source is NOT frozen)', () => {
  let tmpRoot, store, pid, sourceRoot;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-snip-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    sourceRoot = path.join(tmpRoot, 'proj');
    await fs.mkdir(path.join(sourceRoot, 'api'), { recursive: true });
    // one feature (dir=api) with an UNAUTHENTICATED endpoint + a data store → SDX + missing-auth
    await fs.writeFile(path.join(sourceRoot, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));
    const project = await store.openProject({ sourceRoot, name: 'SNIP' });
    pid = project.id;
    await mapProject({ sourceRoot, store, projectId: pid });
  });

  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('end-to-end scan: SDX finding is high, and its snippet matches the snapshot (stale:false)', async () => {
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules' });
    const sdx = result.findings.find((f) => f.rule === 'SDX-unauth-datastore-reachable');
    assert.ok(sdx, 'an SDX finding was produced');
    assert.equal(sdx.severity, 'high'); // was hardcoded critical before S6
    assert.equal(sdx.cwe_name, 'Exposure of Sensitive Information to an Unauthorized Actor');
    assert.ok(sdx.snippet, 'snippet present');
    assert.equal(sdx.snippet.stale, false);
    assert.ok(sdx.snippet.lines.some((l) => l.includes("/orders/:id")));
  });

  test('editing the source after the scan → re-read shows stale:true with the NEW lines', async () => {
    const manifest = await loadManifest(store, pid);
    const root = await readSourceRoot(store, pid);
    assert.equal(root, sourceRoot);
    // edit the file AFTER the snapshot was taken
    await fs.writeFile(path.join(sourceRoot, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({ CHANGED: true }));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));
    const snip = buildSnippet(root, manifest, { file: 'api/orders.js', line: 1 });
    assert.equal(snip.stale, true);
    assert.ok(snip.lines.some((l) => l.includes('CHANGED')), 'reflects the edited source');
  });

  test('no manifest entry or unreadable file → null', () => {
    assert.equal(buildSnippet(sourceRoot, new Map(), { file: 'api/orders.js', line: 1 }), null);
    const m = new Map([['nope.js', 'deadbeef']]);
    assert.equal(buildSnippet(sourceRoot, m, { file: 'nope.js', line: 1 }), null);
  });
});
