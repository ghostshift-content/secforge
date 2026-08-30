import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { decorateFinding, computeCoverage, buildReport, renderMarkdown, reportJson } from '@secforge/assess';

// docs/PHASE5-POLISH-DESIGN.md §5 — the fabrication guard's exact marker list. Belt-and-suspenders:
// the report builder must never be able to produce these either, on top of ui-smoke.test.js.
const FABRICATION_MARKERS = [
  'orders_controller.rb', 'checkout_controller.rb', 'models/user.rb', 'tokens.yml',
  'payments-svc', 'staging.acme.test', 'IDOR in Checkout order lookup',
  'SQL injection in report export', 'Auth bypass on admin refund', 'runtime-confirmed',
  'RLX-04', 'CSX-02', 'Authority verified', 'acme-house-rules', '84% triage',
];

function assertNoFabrication(output) {
  for (const m of FABRICATION_MARKERS) assert.equal(output.includes(m), false, `fabricated marker "${m}" leaked into a report`);
}

// --- hand-built decorated findings (bypass the full pipeline so we control exactly which
// fields are present — in particular, a finding with NO cvss, which every rule-driven finding
// from the real engine always has today since every deterministic rule carries a RULE_CVSS entry). ---
const withCvss = decorateFinding({
  id: 'finding:F-1-idor', family: 'ACX', cwe: 'CWE-639', title: 'IDOR on order lookup',
  severity: 'medium', feature: 'f:orders', endpoint: 'ep', method: 'GET', route: '/orders/:id',
  evidence: { file: 'src/orders.js', line: 12 }, rule: 'ACX-idor-no-owner-check',
  assessment_mode: 'static_confirmed',
}, { snippet: { file: 'src/orders.js', startLine: 10, endLine: 14, lines: ['a', 'b', 'target', 'd', 'e'], stale: false } });

const noCvss = decorateFinding({
  id: 'finding:F-2-unknown', family: 'QIX', cwe: 'CWE-89', title: 'unrated finding',
  severity: 'low', feature: 'f:reports', endpoint: 'ep2', method: 'POST', route: '/reports',
  evidence: { file: 'src/reports.js', line: 3 }, rule: 'unknown-rule-not-in-RULE_CVSS',
  assessment_mode: 'static_confirmed',
}, {});

const FINDINGS = [withCvss, noCvss];
const COVERAGE = {
  percent: 42,
  features: [{ id: 'f:orders', name: 'orders' }],
  families: ['ACX', 'REX', 'SDX'],
  matrix: [{ feature: 'f:orders', name: 'orders', cells: [{ family: 'ACX', verdict: 'vuln' }, { family: 'REX', verdict: 'pass' }, { family: 'SDX', verdict: 'open' }] }],
  byCwe: [{ cwe: 'CWE-639', count: 1, findings: ['finding:F-1-idor'] }],
  cweChecklist: [
    { cwe: 'CWE-639', name: 'Authorization Bypass Through User-Controlled Key', status: 'assessed', verdict: 'vulnerable', count: 1 },
    { cwe: 'CWE-306', name: 'Missing Authentication for Critical Function', status: 'assessed', verdict: 'clean' },
    { cwe: 'CWE-770', name: 'Allocation of Resources Without Limits or Throttling', status: 'open' },
    { cwe: 'CWE-89', name: 'SQL Injection', status: 'na', reason: 'no automated detector implements this CWE yet' },
  ],
};
const PROJECT = { id: 'p_test123', name: 'demo-project', sourceRoot: '/tmp/demo-project' };

describe('renderMarkdown() — direct unit tests (no store)', () => {
  for (const style of ['h1', 'md']) {
    test(`${style}: contains every real finding's id/title/cwe, finding count matches findings.length`, () => {
      const out = renderMarkdown(PROJECT, FINDINGS, COVERAGE, style);
      for (const f of FINDINGS) {
        assert.ok(out.includes(f.id), `missing id ${f.id}`);
        assert.ok(out.includes(f.title), `missing title ${f.title}`);
        assert.ok(out.includes(f.cwe), `missing cwe ${f.cwe}`);
      }
      assert.ok(out.includes(`Findings (${FINDINGS.length})`));
      assert.ok(out.includes(`${FINDINGS.length} findings`));
    });

    test(`${style}: coverage numbers match the passed-in coverage object, not a recomputed value`, () => {
      const out = renderMarkdown(PROJECT, FINDINGS, COVERAGE, style);
      assert.ok(out.includes(`coverage ${COVERAGE.percent}%`));
      assert.ok(out.includes('CWE-639'));
      assert.ok(out.includes('CWE-770')); // open row present
      assert.ok(out.includes('CWE-89'));  // na row present, with its real reason
      assert.ok(out.includes('no automated detector implements this CWE yet'));
    });

    test(`${style}: a finding with no cvss produces no fabricated CVSS score/vector`, () => {
      const out = renderMarkdown(PROJECT, [noCvss], COVERAGE, style);
      assert.equal(out.includes('**CVSS vector:**'), false);
      assert.equal(/\(CVSS \d/.test(out), false); // "(CVSS <score>)" only ever appended when cvss.score is a real number
      assert.equal(/CVSS:3\.1\//.test(out), false); // no real CVSS vector string leaked in from elsewhere
    });

    test(`${style}: prints assessment_mode verbatim, never upgrades to runtime-confirmed`, () => {
      const out = renderMarkdown(PROJECT, FINDINGS, COVERAGE, style);
      assert.ok(out.includes('static_confirmed'));
      assert.equal(out.includes('runtime-confirmed'), false);
    });

    test(`${style}: no fabrication markers anywhere in the output`, () => {
      assertNoFabrication(renderMarkdown(PROJECT, FINDINGS, COVERAGE, style));
    });
  }

  test('h1 vs md differ only in the title line, not in content', () => {
    // Strip the title line (# …) AND the "Generated <timestamp> …" line — the timestamp is
    // regenerated per call, so comparing it would flake across a millisecond boundary.
    const body = (style) => renderMarkdown(PROJECT, FINDINGS, COVERAGE, style)
      .split('\n').filter((l) => !l.startsWith('# ') && !l.startsWith('Generated ')).join('\n');
    const h1 = body('h1'), md = body('md');
    // both bodies mention the same findings/coverage; only the format tag in the footer differs
    assert.equal(h1.replace('format: h1', 'format: X'), md.replace('format: md', 'format: X'));
  });
});

describe('reportJson() — direct unit tests (no store)', () => {
  test('round-trips through JSON.stringify/parse and matches passed-in data verbatim', () => {
    const obj = reportJson(PROJECT, FINDINGS, COVERAGE);
    const parsed = JSON.parse(JSON.stringify(obj));
    assert.equal(parsed.summary.counts.total, FINDINGS.length);
    assert.equal(parsed.summary.coverage.percent, COVERAGE.percent);
    assert.deepEqual(parsed.findings, FINDINGS); // no re-derivation, no dropped/renamed fields
    assert.deepEqual(parsed.cweChecklist, COVERAGE.cweChecklist);
    assert.equal(parsed.project.id, PROJECT.id);
  });

  test('no fabrication markers anywhere in the JSON output', () => {
    assertNoFabrication(JSON.stringify(reportJson(PROJECT, FINDINGS, COVERAGE)));
  });
});

// --- buildReport() integration: a real Store-backed project, real computeCoverage(). ---
describe('buildReport() — against a real store-backed project', () => {
  let tmpRoot, store, pid;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-report-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    const project = await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'REPORT' });
    pid = project.id;
    const snapshotId = 'snap-test';
    await writeNodes(store, pid, [
      { id: 'f:orders', type: 'FEATURE', name: 'orders', data: {}, claims: [] },
      { id: 'ep', type: 'ENDPOINT', name: 'GET /orders/:id', data: { method: 'GET', route: '/orders/:id' }, claims: [] },
    ], { snapshotId });
    await writeEdges(store, pid, [{ id: 'edge:e1', type: 'EXPOSES', src: 'f:orders', dst: 'ep' }], { snapshotId });
    await store.writeFinding(pid, withCvss);
    await store.writeFinding(pid, noCvss);
  });

  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  for (const format of ['h1', 'md', 'json']) {
    test(`format=${format}: content type is correct, findings count equals findings.length, coverage.percent matches computeCoverage()`, async () => {
      const coverage = await computeCoverage(store, pid);
      const { contentType, body } = await buildReport(store, pid, format);
      if (format === 'json') {
        assert.match(contentType, /application\/json/);
        const parsed = JSON.parse(body);
        assert.equal(parsed.findings.length, 2);
        assert.equal(parsed.summary.counts.total, 2);
        assert.equal(parsed.summary.coverage.percent, coverage.percent);
      } else {
        assert.match(contentType, /text\/markdown/);
        assert.ok(body.includes('Findings (2)'));
        assert.ok(body.includes(`coverage ${coverage.percent}%`));
      }
      assertNoFabrication(body);
    });
  }

  test('unknown format coerces to md', async () => {
    const { contentType, body } = await buildReport(store, pid, 'bogus');
    assert.match(contentType, /text\/markdown/);
    assert.ok(body.includes('Security Assessment Report'));
  });

  test('an unscanned/empty-findings project still returns a valid, honestly-empty report', async () => {
    const tmp2 = path.join(os.tmpdir(), 'sf-report-empty-' + crypto.randomBytes(4).toString('hex'));
    const store2 = new Store(tmp2);
    await fs.mkdir(path.join(tmp2, 'src'), { recursive: true });
    const project2 = await store2.openProject({ sourceRoot: path.join(tmp2, 'src'), name: 'EMPTY' });
    try {
      const { contentType, body } = await buildReport(store2, project2.id, 'md');
      assert.match(contentType, /text\/markdown/);
      assert.ok(body.includes('Findings (0)'));
      assert.equal(body.includes('coverage 0%'), true);
    } finally {
      await fs.rm(tmp2, { recursive: true, force: true });
    }
  });
});
