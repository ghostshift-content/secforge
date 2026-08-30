import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SCOPE_KINDS, RUN_METHODS } from '@secforge/schemas';
import { emit as busEmit } from '@secforge/orchestration';
import { handleApi, scopeInputError } from '../src/routes.js';

// --- pure validation logic (S3-6: reject explicit invalid scope, don't silently coerce) ---
describe('scopeInputError()', () => {
  test('absent fields default silently (no error)', () => {
    assert.equal(scopeInputError({}), null);
    assert.equal(scopeInputError(undefined), null);
    assert.equal(scopeInputError({ feature: 'x' }), null);
  });
  test('valid mode/method pass', () => {
    assert.equal(scopeInputError({ mode: 'all', method: 'pattern' }), null);
  });
  test('present-but-unknown mode → "mode"', () => {
    assert.equal(scopeInputError({ mode: 'NOT_A_MODE' }), 'mode');
  });
  test('present-but-unknown method → "method"', () => {
    assert.equal(scopeInputError({ method: 'NOT_A_METHOD' }), 'method');
  });
});

// --- the scan route returns 400 (not a silent FULL scan) on an explicit bad scope ---
function mockReq(method, body) {
  const r = Readable.from([body == null ? '' : JSON.stringify(body)]);
  r.method = method;
  return r;
}
function mockRes() {
  return {
    code: null, body: null, headers: null, text: null,
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    end(b) { this.text = b; try { this.body = b ? JSON.parse(b) : null; } catch { this.body = null; } },
  };
}
// SSE mock — captures every res.write() chunk instead of a single end() body.
function mockSseRes() {
  return {
    code: null, headers: null, ended: false, chunks: [],
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    write(chunk) { this.chunks.push(chunk); },
    end() { this.ended = true; },
  };
}
function sseEvents(res) {
  return res.chunks.map((c) => JSON.parse(String(c).replace(/^data: /, '').trim()));
}

describe('POST /api/sessions/:id/scan scope validation', () => {
  test('invalid scope.mode → 400 with allowed sets, no scan run', async () => {
    const res = mockRes();
    const url = new URL('http://x/api/sessions/s1/scan?project=p_test');
    const handled = await handleApi(mockReq('POST', { scope: { mode: 'NOT_A_MODE' } }), res, url);
    assert.equal(handled, true);
    assert.equal(res.code, 400);
    assert.match(res.body.error, /mode/);
    assert.deepEqual(res.body.allowed.mode, [...SCOPE_KINDS]);
    assert.deepEqual(res.body.allowed.method, [...RUN_METHODS]);
  });

  test('invalid scope.method → 400', async () => {
    const res = mockRes();
    const url = new URL('http://x/api/sessions/s1/scan?project=p_test');
    await handleApi(mockReq('POST', { scope: { method: 'NOT_A_METHOD' } }), res, url);
    assert.equal(res.code, 400);
    assert.match(res.body.error, /method/);
  });
});

// docs/PHASE1-ROLES-INVENTORY-DESIGN.md §2.3 — GET /api/projects/:id/inventory
describe('GET /api/projects/:id/inventory', () => {
  test('returns {rows, counts} matching what mapProject() persisted, for a real mapped project', async () => {
    const tmp = path.join(os.tmpdir(), 'sf-inv-route-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(path.join(tmp, 'app', 'models'), { recursive: true });
    await fsp.writeFile(path.join(tmp, 'app', 'models', 'user.rb'),
      "class User < ApplicationRecord\n  devise :database_authenticatable\nend\n");

    const openRes = mockRes();
    await handleApi(mockReq('POST', { sourceRoot: tmp }), openRes, new URL('http://x/api/projects'));
    assert.equal(openRes.code, 201, JSON.stringify(openRes.body));
    const pid = openRes.body.project.id;

    try {
      const mapRes = mockRes();
      await handleApi(mockReq('POST', {}), mapRes, new URL('http://x/api/projects/' + pid + '/map'));
      assert.equal(mapRes.code, 200, JSON.stringify(mapRes.body));

      const invRes = mockRes();
      await handleApi(mockReq('GET', {}), invRes, new URL('http://x/api/projects/' + pid + '/inventory'));
      assert.equal(invRes.code, 200);
      assert.ok(Array.isArray(invRes.body.rows) && invRes.body.rows.length > 0);
      assert.ok(invRes.body.rows.some((r) => r.kind === 'ACTOR' && r.detail.name === 'User'));

      const counts = {};
      for (const r of invRes.body.rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
      assert.deepEqual(invRes.body.counts, counts);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('an unmapped/unknown project → empty rows/counts, not an error', async () => {
    const res = mockRes();
    await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/no-such-project/inventory'));
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { rows: [], counts: {} });
  });
});

// docs/PHASE3-LEARNING-DESIGN.md — accept/reject feedback loop, mining, consolidation, honest stats.
describe('Phase 3 self-learning: feedback, mining, consolidation', () => {
  async function openMappedProject(tag) {
    const tmp = path.join(os.tmpdir(), 'sf-p3-' + tag + '-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(path.join(tmp, 'api'), { recursive: true });
    // An unauthenticated endpoint reachable + a data store → real ACX/SDX findings via mapProject.
    await fsp.writeFile(path.join(tmp, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));

    const openRes = mockRes();
    await handleApi(mockReq('POST', { sourceRoot: tmp }), openRes, new URL('http://x/api/projects'));
    assert.equal(openRes.code, 201, JSON.stringify(openRes.body));
    const pid = openRes.body.project.id;
    const sid = openRes.body.session.sessionId;

    const mapRes = mockRes();
    await handleApi(mockReq('POST', {}), mapRes, new URL('http://x/api/projects/' + pid + '/map'));
    assert.equal(mapRes.code, 200, JSON.stringify(mapRes.body));

    return { tmp, pid, sid };
  }

  async function runScan(pid, sid) {
    const scanRes = mockRes();
    await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
      new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
    assert.equal(scanRes.code, 200, JSON.stringify(scanRes.body));
    return scanRes.body;
  }

  test('a scan response carries additive mined[]/priorFeedbackFlagged fields; GET /memory now returns a real learned[] catalog', async () => {
    const { tmp, pid, sid } = await openMappedProject('mine');
    try {
      const scan = await runScan(pid, sid);
      assert.ok(Array.isArray(scan.mined));
      assert.equal(typeof scan.priorFeedbackFlagged, 'number');
      assert.ok(scan.findings.length > 0, 'the fixture produces at least one real finding');
      assert.ok(scan.mined.length > 0, 'this project has never been mined before — at least one rule gets a cited entry');

      const memRes = mockRes();
      await handleApi(mockReq('GET', {}), memRes, new URL('http://x/api/projects/' + pid + '/memory'));
      assert.equal(memRes.code, 200);
      assert.ok(Array.isArray(memRes.body.learned), 'GET /memory now returns a top-level learned[] catalog');
      assert.ok(memRes.body.learned.length > 0);
      assert.equal(memRes.body.learned.length, scan.mined.length);

      // Re-scanning the same, unchanged project must NOT mine the same rule twice.
      await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
      const scan2 = await runScan(pid, sid);
      assert.equal(scan2.mined.length, 0, 'dedup by rule marker — no duplicate mining on a re-scan');
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('POST /feedback validates verdict, records it, and the SAME rule::route shape re-surfaces as priorFeedback on the next scan (never hidden)', async () => {
    const { tmp, pid, sid } = await openMappedProject('feedback');
    try {
      const scan = await runScan(pid, sid);
      const fid = scan.findings[0].id;

      const badRes = mockRes();
      await handleApi(mockReq('POST', { findingId: fid, verdict: 'bogus' }), badRes, new URL('http://x/api/projects/' + pid + '/feedback'));
      assert.equal(badRes.code, 400);

      const okRes = mockRes();
      await handleApi(mockReq('POST', { findingId: fid, verdict: 'reject' }), okRes, new URL('http://x/api/projects/' + pid + '/feedback'));
      assert.equal(okRes.code, 200);
      assert.deepEqual(okRes.body, { ok: true, findingId: fid, verdict: 'reject' });

      // Honest counts: exactly one real reject, no fabricated percentage anywhere in the payload.
      const memRes = mockRes();
      await handleApi(mockReq('GET', {}), memRes, new URL('http://x/api/projects/' + pid + '/memory'));
      assert.equal(memRes.body.stats.rejected, 1);
      assert.equal(memRes.body.stats.accepted, 0);
      assert.equal(memRes.body.stats.feedbackSignals, 1);

      // Re-scan (unchanged source → same rule::route shape) → the finding is re-surfaced, not hidden.
      await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
      const scan2 = await runScan(pid, sid);
      assert.ok(scan2.findings.length > 0, 'the deterministic rule still fires — never silently suppressed');
      const flagged = scan2.findings.find((f) => f.priorFeedback);
      assert.ok(flagged, 'at least one re-scanned finding carries the prior verdict');
      assert.equal(flagged.priorFeedback.verdict, 'reject');

      // GET /findings independently (not just the scan response) also carries the badge.
      const findRes = mockRes();
      await handleApi(mockReq('GET', {}), findRes, new URL('http://x/api/projects/' + pid + '/findings'));
      assert.ok(findRes.body.findings.some((f) => f.priorFeedback && f.priorFeedback.verdict === 'reject'));
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  // Live-verification regressions (no re-map between scans — the exact repro): a second scan on
  // an UNCHANGED project must not 500 (bug 1), and a finding rejected before that second scan
  // must carry priorFeedback on GET /findings, not just in the scan response (bug 2).
  test('reject, then scan the SAME snapshot AGAIN with no re-map in between: no 500, and GET /findings carries priorFeedback', async () => {
    const { tmp, pid, sid } = await openMappedProject('rescan-no-remap');
    try {
      const scan1 = await runScan(pid, sid);
      const fid = scan1.findings[0].id;

      const fbRes = mockRes();
      await handleApi(mockReq('POST', { findingId: fid, verdict: 'reject' }), fbRes, new URL('http://x/api/projects/' + pid + '/feedback'));
      assert.equal(fbRes.code, 200);

      // NO /map call here — this is the exact live repro (map once, scan, scan again).
      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(scanRes.code, 200, 'bug 1: a second scan on the same snapshot must not 500 — ' + JSON.stringify(scanRes.body));
      assert.equal(scanRes.body.findings.length, scan1.findings.length, 'the same findings fire again, not duplicated');

      const findRes = mockRes();
      await handleApi(mockReq('GET', {}), findRes, new URL('http://x/api/projects/' + pid + '/findings'));
      assert.equal(findRes.code, 200);
      const persisted = findRes.body.findings.find((f) => f.id === fid);
      assert.ok(persisted, 'the rejected finding is still WRITTEN, never hidden');
      assert.equal(persisted.priorFeedback && persisted.priorFeedback.verdict, 'reject',
        'bug 2: GET /findings — what the UI actually reads — must carry the persisted priorFeedback badge');
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('POST /feedback 404s on an unknown finding id', async () => {
    const { tmp, pid } = await openMappedProject('nofind');
    try {
      const res = mockRes();
      await handleApi(mockReq('POST', { findingId: 'finding:does-not-exist', verdict: 'accept' }), res,
        new URL('http://x/api/projects/' + pid + '/feedback'));
      assert.equal(res.code, 404);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('POST /memory/consolidate collapses duplicate learned lines and returns real before/after counts', async () => {
    const { tmp, pid, sid } = await openMappedProject('consolidate');
    try {
      await runScan(pid, sid);
      await handleApi(mockReq('POST', { name: 'manual dup', kind: 'note' }), mockRes(), new URL('http://x/api/projects/' + pid + '/memory'));
      await handleApi(mockReq('POST', { name: 'manual dup', kind: 'note' }), mockRes(), new URL('http://x/api/projects/' + pid + '/memory'));

      const res = mockRes();
      await handleApi(mockReq('POST', {}), res, new URL('http://x/api/projects/' + pid + '/memory/consolidate'));
      assert.equal(res.code, 200);
      assert.equal(typeof res.body.learnedPatterns.before, 'number');
      assert.equal(typeof res.body.learnedPatterns.after, 'number');
      assert.ok(res.body.learnedPatterns.after < res.body.learnedPatterns.before, 'the two identical manual lines collapsed to one');
      assert.equal(typeof res.body.feedback.before, 'number');
      assert.equal(typeof res.body.feedback.after, 'number');
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

// docs/PHASE5-POLISH-DESIGN.md §2.2 — GET /api/projects/:id/report?format=h1|md|json
describe('GET /api/projects/:id/report', () => {
  async function openScannedProject(tag) {
    const tmp = path.join(os.tmpdir(), 'sf-p5-report-' + tag + '-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(path.join(tmp, 'api'), { recursive: true });
    await fsp.writeFile(path.join(tmp, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));

    const openRes = mockRes();
    await handleApi(mockReq('POST', { sourceRoot: tmp }), openRes, new URL('http://x/api/projects'));
    assert.equal(openRes.code, 201, JSON.stringify(openRes.body));
    const pid = openRes.body.project.id;
    const sid = openRes.body.session.sessionId;

    await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
    const scanRes = mockRes();
    await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
      new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
    assert.equal(scanRes.code, 200, JSON.stringify(scanRes.body));
    return { tmp, pid, findings: scanRes.body.findings };
  }

  test('format=h1 → 200, text/markdown, content-disposition attachment with the h1 filename, all real findings present', async () => {
    const { tmp, pid, findings } = await openScannedProject('h1');
    try {
      const res = mockRes();
      await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/' + pid + '/report?format=h1'));
      assert.equal(res.code, 200);
      assert.match(res.headers['content-type'], /^text\/markdown/);
      assert.equal(res.headers['content-disposition'], `attachment; filename="secforge-report-${pid}.md"`);
      for (const f of findings) assert.ok(res.text.includes(f.id));
      assert.ok(res.text.includes(`Findings (${findings.length})`));
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('format=json → 200, application/json, body parses and its counts equal findings.length/coverage.percent', async () => {
    const { tmp, pid, findings } = await openScannedProject('json');
    try {
      const res = mockRes();
      await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/' + pid + '/report?format=json'));
      assert.equal(res.code, 200);
      assert.match(res.headers['content-type'], /^application\/json/);
      assert.equal(res.headers['content-disposition'], `attachment; filename="secforge-report-${pid}.json"`);
      assert.equal(res.body.summary.counts.total, findings.length);
      assert.equal(res.body.findings.length, findings.length);

      const covRes = mockRes();
      await handleApi(mockReq('GET', {}), covRes, new URL('http://x/api/projects/' + pid + '/coverage'));
      assert.equal(res.body.summary.coverage.percent, covRes.body.percent);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('unknown/missing format coerces to md, not an error', async () => {
    const { tmp, pid } = await openScannedProject('bogus');
    try {
      const res = mockRes();
      await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/' + pid + '/report?format=bogus'));
      assert.equal(res.code, 200);
      assert.match(res.headers['content-type'], /^text\/markdown/);

      const noFormatRes = mockRes();
      await handleApi(mockReq('GET', {}), noFormatRes, new URL('http://x/api/projects/' + pid + '/report'));
      assert.equal(noFormatRes.code, 200);
      assert.match(noFormatRes.headers['content-type'], /^text\/markdown/);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('unknown project id → 404', async () => {
    const res = mockRes();
    await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/no-such-project/report?format=md'));
    assert.equal(res.code, 404);
  });

  test('an unscanned project → 200, a valid empty report, never a 500', async () => {
    const tmp = path.join(os.tmpdir(), 'sf-p5-report-unscanned-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(tmp, { recursive: true });
    const openRes = mockRes();
    await handleApi(mockReq('POST', { sourceRoot: tmp }), openRes, new URL('http://x/api/projects'));
    const pid = openRes.body.project.id;
    try {
      const res = mockRes();
      await handleApi(mockReq('GET', {}), res, new URL('http://x/api/projects/' + pid + '/report?format=md'));
      assert.equal(res.code, 200);
      assert.ok(res.text.includes('Findings (0)'));
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

// Phase D — map/scan routes delegate to @secforge/orchestration; GET .../stream forwards its
// live bus events instead of replaying a canned animation.
describe('Phase D: orchestration wiring', () => {
  async function openProject(tag) {
    const tmp = path.join(os.tmpdir(), 'sf-pd-' + tag + '-' + crypto.randomBytes(4).toString('hex'));
    await fsp.mkdir(path.join(tmp, 'api'), { recursive: true });
    await fsp.writeFile(path.join(tmp, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));
    const openRes = mockRes();
    await handleApi(mockReq('POST', { sourceRoot: tmp }), openRes, new URL('http://x/api/projects'));
    assert.equal(openRes.code, 201, JSON.stringify(openRes.body));
    return { tmp, pid: openRes.body.project.id, sid: openRes.body.session.sessionId };
  }

  test('POST /map delegates to runMapOrchestration: response is mapProject\'s own shape (no leftover "ok"), and session.phase reaches done', async () => {
    const { tmp, pid, sid } = await openProject('map');
    try {
      const mapRes = mockRes();
      await handleApi(mockReq('POST', {}), mapRes, new URL('http://x/api/projects/' + pid + '/map'));
      assert.equal(mapRes.code, 200, JSON.stringify(mapRes.body));
      assert.equal(mapRes.body.status, 'MAPPED');
      assert.ok(!('ok' in mapRes.body), 'the orchestrator\'s own {ok,...} wrapper must not leak into the HTTP response');

      const sessRes = mockRes();
      await handleApi(mockReq('GET', {}), sessRes, new URL('http://x/api/sessions/' + sid + '?project=' + pid));
      assert.equal(sessRes.code, 200);
      assert.equal(sessRes.body.phase?.name, 'map');
      assert.equal(sessRes.body.phase?.stage, 'done');
      assert.equal(sessRes.body.phase?.result?.features, mapRes.body.features.length);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('POST /scan (feature-scoped) delegates to runScanOrchestration: findings/mining/consolidate still run, and session.phase reaches done for that feature', async () => {
    const { tmp, pid, sid } = await openProject('scan');
    try {
      await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
      const graphRes = mockRes();
      await handleApi(mockReq('GET', {}), graphRes, new URL('http://x/api/projects/' + pid + '/graph'));
      const featureId = graphRes.body.nodes.find((n) => n.type === 'FEATURE').id;

      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'feature', feature: featureId }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(scanRes.code, 200, JSON.stringify(scanRes.body));
      assert.ok(scanRes.body.findings.length > 0, 'the fixture produces a real finding');
      assert.ok(Array.isArray(scanRes.body.mined), 'mining still ran (post-processing intact)');
      assert.equal(typeof scanRes.body.priorFeedbackFlagged, 'number', 'annotatePriorFeedback still ran');

      const sessRes = mockRes();
      await handleApi(mockReq('GET', {}), sessRes, new URL('http://x/api/sessions/' + sid + '?project=' + pid));
      assert.equal(sessRes.body.phase?.name, 'scan');
      assert.equal(sessRes.body.phase?.stage, 'done');
      assert.equal(sessRes.body.phase?.feature, featureId);
      assert.equal(sessRes.body.phase?.result?.findings, scanRes.body.findings.length);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('a paused session refuses a new POST /map or POST /scan with 409, before any lock/orchestration run', async () => {
    const { tmp, pid, sid } = await openProject('paused');
    try {
      await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
      // A session starts 'created'; only a scan drives it to 'running' (pause requires running->paused).
      const firstScan = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' } }), firstScan,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(firstScan.code, 200, JSON.stringify(firstScan.body));
      const pauseRes = mockRes();
      await handleApi(mockReq('POST', {}), pauseRes, new URL('http://x/api/sessions/' + sid + '/pause?project=' + pid));
      assert.equal(pauseRes.code, 200, JSON.stringify(pauseRes.body));

      const mapRes = mockRes();
      await handleApi(mockReq('POST', {}), mapRes, new URL('http://x/api/projects/' + pid + '/map'));
      assert.equal(mapRes.code, 409);
      assert.match(mapRes.body.error, /paused/);

      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' } }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(scanRes.code, 409);
      assert.match(scanRes.body.error, /paused/);
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  test('GET /sessions/:id/stream sends the current session.phase first, then forwards live bus events, and unsubscribes once done', async () => {
    const { tmp, pid, sid } = await openProject('stream');
    try {
      await handleApi(mockReq('POST', {}), mockRes(), new URL('http://x/api/projects/' + pid + '/map'));
      const sessRes = mockRes();
      await handleApi(mockReq('GET', {}), sessRes, new URL('http://x/api/sessions/' + sid + '?project=' + pid));
      const priorPhase = sessRes.body.phase;

      const stream = mockSseRes();
      const req = mockReq('GET', {});
      const handled = await handleApi(req, stream, new URL('http://x/api/sessions/' + sid + '/stream?project=' + pid));
      assert.equal(handled, true);
      assert.equal(stream.code, 200);

      let events = sseEvents(stream);
      assert.equal(events.length, 1, 'the current session.phase is sent immediately, once');
      assert.deepEqual(events[0], priorPhase);

      busEmit(sid, { stage: 'hunter', jobs: 1 });
      events = sseEvents(stream);
      assert.equal(events.length, 2, 'a live bus event is forwarded to the stream');
      assert.deepEqual(events[1], { stage: 'hunter', jobs: 1 });

      busEmit(sid, { stage: 'done', result: { findings: 0 } });
      events = sseEvents(stream);
      assert.equal(events.length, 3);
      assert.equal(stream.ended, true, 'a done/error event ends the response and unsubscribes');

      busEmit(sid, { stage: 'ignored-after-unsubscribe' });
      assert.equal(sseEvents(stream).length, 3, 'nothing is forwarded after the stream ended');
    } finally {
      await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
