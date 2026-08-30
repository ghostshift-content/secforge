// Phase B — the citation-grounding gate (packages/assess/src/grounding.js). Every LLM-proposed
// candidate must name a file:line that is a REAL member of the fed-forward citation pool for the
// feature whose bundle produced it, checked BEFORE the candidate reaches TRIAGE/reproveLlmCandidate.
// This gate COMPOSES with, never replaces, the existing executor→verifier separation (assess.test.js)
// — both must hold for a finding to be promoted.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { mapProject } from '@secforge/map';
import { register } from '@secforge/adapters';
import { runAssessment, citationIndex, citationFromLine } from '@secforge/assess';

const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route, extra = {}) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route, ...extra }, claims: [{ file: 'a.js', line: 2 }] });
const authNode = (id, kind) => ({ id, type: 'AUTH_CHECK', name: kind, data: { kind }, claims: [] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

// ---- pure unit tests: citationIndex() / citationFromLine() --------------------------------------
describe('citationIndex() / citationFromLine() — pure gate logic', () => {
  const bundle = { citations: [{ file: 'app/orders_controller.rb', line: 47, excerpt: 'def show' }] };
  const idx = citationIndex(bundle);

  test('a citation present in the index is found via the strict trailing 6th field', () => {
    const c = citationFromLine('ACX|IDOR|GET|/orders/:id|high|app/orders_controller.rb:47', idx);
    assert.ok(c, 'citation found');
    assert.equal(c.file, 'app/orders_controller.rb');
    assert.equal(c.line, 47);
  });

  test('a citation present in the index is found via the lenient substring path (no strict 6th field)', () => {
    const c = citationFromLine('IDOR at app/orders_controller.rb:47 looks unauthorized', idx);
    assert.ok(c, 'citation found via substring scan');
    assert.equal(c.line, 47);
  });

  test('a citation NOT in the index (nonexistent line) returns null', () => {
    assert.equal(citationFromLine('ACX|IDOR|GET|/orders/:id|high|app/orders_controller.rb:99999', idx), null);
  });

  test('a citation belonging to a DIFFERENT feature\'s bundle returns null — indexes never merge across features', () => {
    const otherIdx = citationIndex({ citations: [{ file: 'app/accounts_controller.rb', line: 10 }] });
    assert.equal(citationFromLine('ACX|IDOR|GET|/orders/:id|high|app/orders_controller.rb:47', otherIdx), null);
  });
});

// ---- end-to-end: the gate wired into runAssessment ----------------------------------------------
describe('runAssessment(): Phase B citation-grounding gate (deterministic FAKE adapter)', () => {
  let tmpRoot, store;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-grounding-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
  });
  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  async function makeProject(tag, nodes, edges) {
    const sourceRoot = path.join(tmpRoot, tag);
    await fs.mkdir(sourceRoot, { recursive: true });
    const project = await store.openProject({ sourceRoot, name: tag });
    await writeNodes(store, project.id, nodes, { snapshotId: 'snap' });
    await writeEdges(store, project.id, edges, { snapshotId: 'snap' });
    return project.id;
  }

  test('a candidate citing a REAL feature file:line passes the gate and, when deterministically corroborated, becomes a verified finding', async () => {
    // Fully unauthenticated endpoint — deterministic engine independently flags ACX-missing-authentication.
    const nodes = [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id')];
    const edges = [edge('EXPOSES', 'f:orders', 'ep')];
    const pid = await makeProject('grounded-corroborated', nodes, edges);
    // ep's own claim (endpoint() helper above) is {file:'a.js', line:2} — a real citation in
    // f:orders' fed-forward bundle.
    register({ id: 'fake-grounded-good', available: async () => true, ask: async () => 'ACX|bogus IDOR|GET|/orders/:id|high|a.js:2' });
    const result = await runAssessment({ store, projectId: pid, scope: { patterns: ['REX'] }, engine: 'fake-grounded-good' });
    assert.equal(result.llmCitationDropped, 0, 'the citation was real — nothing dropped at the gate');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].rule, 'ACX-missing-authentication', 're-attributed to the deterministic rule, per the executor→verifier gate');
  });

  test('a candidate citing a REAL feature file:line but with NO deterministic corroborator still never becomes a finding (executor→verifier still holds)', async () => {
    // Endpoint is genuinely authenticated + authorized — deterministic engine finds nothing here,
    // even though the LLM's citation is perfectly real and grounded.
    const nodes = [feature('f:orders', 'orders'), endpoint('ep', 'GET', '/orders/:id'), authNode('ac:authn', 'authentication'), authNode('ac:authz', 'authorization')];
    const edges = [edge('EXPOSES', 'f:orders', 'ep'), edge('AUTHENTICATED_BY', 'ep', 'ac:authn'), edge('AUTHORIZED_BY', 'ep', 'ac:authz')];
    const pid = await makeProject('grounded-uncorroborated', nodes, edges);
    register({ id: 'fake-grounded-bogus', available: async () => true, ask: async () => 'ACX|bogus IDOR|GET|/orders/:id|high|a.js:2' });
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'fake-grounded-bogus' });
    assert.equal(result.llmCitationDropped, 0, 'the citation itself was real — gate 1 passes');
    assert.equal(result.findings.length, 0, 'gate 2 (executor→verifier) still rejects the unsupported claim');
  });

  test('a candidate citing a NONEXISTENT file:line (against a real frozen source snapshot) is dropped before TRIAGE, counted in llmCitationDropped, never reaches findings', async () => {
    const sourceRoot = path.join(tmpRoot, 'grounding-nonexistent');
    await fs.mkdir(path.join(sourceRoot, 'api'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      '',
    ].join('\n'));
    const project = await store.openProject({ sourceRoot, name: 'grounding-nonexistent' });
    const pid = project.id;
    await mapProject({ sourceRoot, store, projectId: pid }); // real frozen source under snapshots/<id>/source/

    // A real file, but a line number that is not part of any claim ever surfaced to the model —
    // never a real citation in the feature's fed-forward pool, however plausible it looks. Note:
    // this endpoint IS genuinely unauthenticated, so if the candidate ever reached gate 2
    // (reproveLlmCandidate) it WOULD be corroborated — proving the drop happens at gate 1, before
    // that is ever attempted, not a coincidental gate-2 rejection.
    register({ id: 'fake-grounded-nonexistent-line', available: async () => true, ask: async () => 'ACX|bogus IDOR|GET|/orders/:id|high|api/orders.js:99999' });
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'fake-grounded-nonexistent-line' });
    assert.equal(result.llmCitationDropped, 1, 'dropped at the citation gate, counted honestly');
    assert.equal(result.findings.some((f) => f.verified_by === 'llm-nominated+rule-confirmed'), false, 'never even reached the executor→verifier gate');
  });
});
