// Phase 3 self-learning: accept/reject loop + pattern mining + consolidation.
// docs/PHASE3-LEARNING-DESIGN.md — every number here is a real count of something on disk;
// no percentage/confidence/precision is ever computed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { runAssessment } from '@secforge/assess';
import {
  record, learn, recordVerdict, annotatePriorFeedback, minePatterns, consolidate, stats, listLearned,
} from '@secforge/memory';

// --- tiny in-memory graph builders (mirror packages/assess/test/assess.test.js) ---
const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route }, claims: [{ file: 'orders.js', line: 42 }] });
const authNode = (id, kind) => ({ id, type: 'AUTH_CHECK', name: kind, data: { kind }, claims: [] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

describe('@secforge/memory — Phase 3 self-learning', () => {
  let tmpRoot, store, pid;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-memory-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    const project = await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'MEM' });
    pid = project.id;
    // A real graph that trips ACX-idor-no-owner-check (authenticated, no ownership check).
    await writeNodes(store, pid, [
      feature('f:orders', 'orders'),
      endpoint('ep', 'GET', '/orders/:id'),
      authNode('ac:authn', 'authentication'),
    ], { snapshotId: 'snap' });
    await writeEdges(store, pid, [
      edge('EXPOSES', 'f:orders', 'ep'),
      edge('AUTHENTICATED_BY', 'ep', 'ac:authn'),
    ], { snapshotId: 'snap' });
  });

  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('fixture: runAssessment produces a real IDOR finding to drive the learning tests below', async () => {
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].rule, 'ACX-idor-no-owner-check');
    assert.equal(result.findings[0].route, '/orders/:id');
  });

  describe('accept/reject feedback loop', () => {
    test('recordVerdict rejects a verdict that is not accept/reject', async () => {
      await assert.rejects(() => recordVerdict(store, pid, { findingId: 'x', verdict: 'maybe' }));
    });

    test('a reject verdict re-surfaces on the next scan as priorFeedback — flagged, never hidden', async () => {
      const [f] = await store.listFindings(pid);
      await recordVerdict(store, pid, { findingId: f.id, rule: f.rule, cwe: f.cwe, feature: f.feature, route: f.route, verdict: 'reject' });

      // Simulate the next scan re-producing the same rule::route shape as a fresh finding object.
      const rescanned = [{ ...f, id: 'finding:F-9-rescan' }];
      const flagged = await annotatePriorFeedback(store, pid, rescanned);
      assert.equal(flagged, 1);
      assert.equal(rescanned[0].priorFeedback.verdict, 'reject');
      assert.ok(rescanned[0].priorFeedback.at, 'carries a timestamp');
      assert.equal(rescanned[0].priorFeedback.findingId, f.id, 'cites the finding the verdict was recorded against');
      // The deterministic finding itself is untouched/unsuppressed — only annotated.
      assert.equal(rescanned[0].rule, f.rule);

      // A different route is a different shape — must NOT be flagged.
      const differentRoute = [{ ...f, id: 'finding:F-10-other', route: '/other/:id' }];
      const flagged2 = await annotatePriorFeedback(store, pid, differentRoute);
      assert.equal(flagged2, 0);
      assert.equal(differentRoute[0].priorFeedback, undefined);
    });
  });

  describe('minePatterns()', () => {
    test('appends one real, cited entry per rule and never duplicates on a second run', async () => {
      const findings = await store.listFindings(pid);
      const added = await minePatterns(store, pid, findings);
      assert.equal(added.length, 1);
      assert.match(added[0].note, /rule=ACX-idor-no-owner-check/);
      assert.match(added[0].note, /orders\.js:42/, 'citation is the finding\'s own file:line');
      assert.match(added[0].name, /reads an object by id without an ownership\/authorization check/, 'name is the finding\'s own factual title, never invented text');
    });

    test('the mined entry is a real cited line in the catalog, and mining again does not duplicate it', async () => {
      const learned = await listLearned(store, pid);
      const mineLines = learned.filter((l) => (l.note || '').includes('rule=ACX-idor-no-owner-check'));
      assert.equal(mineLines.length, 1, 'exactly one mined line for this rule');

      // A second scan yields a NEW finding for the SAME rule (different file/line) — must be skipped.
      const findings = await store.listFindings(pid);
      const again = await minePatterns(store, pid, [{ ...findings[0], id: 'finding:F-9-idor2', evidence: { file: 'other.js', line: 5 } }]);
      assert.equal(again.length, 0, 'dedup by rule marker — no second citation');
      const learnedAfter = await listLearned(store, pid);
      assert.equal(learnedAfter.length, learned.length, 'catalog did not grow');
    });
  });

  describe('consolidate()', () => {
    test('collapses exact-duplicate learned-patterns.md lines and keeps only the latest verdict per rule::route key', async () => {
      const dir = path.join(store.projectDir(pid), 'memory');
      const lpFile = path.join(dir, 'learned-patterns.md');
      await fs.appendFile(lpFile, '- **dup** [note] — same line\n- **dup** [note] — same line\n');

      const fbFile = path.join(dir, 'feedback.jsonl');
      const base = { rule: 'ACX-consolidate-test', route: 'GET /x', findingId: 'finding:F-x' };
      await fs.appendFile(fbFile, [
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'finding.verdict', ...base, verdict: 'reject' }),
        JSON.stringify({ at: '2026-01-02T00:00:00.000Z', type: 'finding.verdict', ...base, verdict: 'accept' }),
        JSON.stringify({ at: '2026-01-03T00:00:00.000Z', type: 'finding.verdict', ...base, verdict: 'reject' }),
      ].join('\n') + '\n');

      const lpBefore = (await fs.readFile(lpFile, 'utf8')).split('\n').filter(Boolean).length;
      const fbBefore = (await fs.readFile(fbFile, 'utf8')).split('\n').filter(Boolean).length;

      const result = await consolidate(store, pid);
      assert.equal(result.learnedPatterns.before, lpBefore);
      assert.equal(result.learnedPatterns.after, lpBefore - 1, 'exactly one exact-duplicate line collapsed');

      const fbEntries = (await fs.readFile(fbFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const forKey = fbEntries.filter((e) => e.type === 'finding.verdict' && e.rule === base.rule && e.route === base.route);
      assert.equal(forKey.length, 1, 'only the newest verdict for this key survives');
      assert.equal(forKey[0].verdict, 'reject');
      assert.equal(forKey[0].at, '2026-01-03T00:00:00.000Z');
      assert.ok(fbBefore > result.feedback.after, 'superseded verdicts were actually collapsed');

      // Idempotent: running it again is a no-op.
      const second = await consolidate(store, pid);
      assert.equal(second.learnedPatterns.before, second.learnedPatterns.after);
      assert.equal(second.feedback.before, second.feedback.after);
    });
  });

  describe('stats() — honest counts only', () => {
    test('feedbackSignals/accepted/rejected count ONLY real finding.verdict entries, never learn()\'s "learned" mirror or an ad-hoc record() shape', async () => {
      const tmp2 = path.join(os.tmpdir(), 'sf-memory-stats-' + crypto.randomBytes(4).toString('hex'));
      const store2 = new Store(tmp2);
      await fs.mkdir(path.join(tmp2, 'src'), { recursive: true });
      const project2 = await store2.openProject({ sourceRoot: path.join(tmp2, 'src'), name: 'STATS' });
      const pid2 = project2.id;

      await learn(store2, pid2, { name: 'x', kind: 'note', note: 'n' });               // 'learned' mirror entry
      await record(store2, pid2, { type: 'feedback', verdict: 'confirmed' });          // ad-hoc, NOT finding.verdict
      await recordVerdict(store2, pid2, { findingId: 'finding:F-1', rule: 'R', route: 'GET /x', verdict: 'accept' });
      await recordVerdict(store2, pid2, { findingId: 'finding:F-2', rule: 'R2', route: 'GET /y', verdict: 'reject' });

      const s = await stats(store2, pid2);
      assert.equal(s.accepted, 1);
      assert.equal(s.rejected, 1);
      assert.equal(s.feedbackSignals, 2, 'not every feedback.jsonl line (4 total) — only the 2 real verdicts');
      assert.equal(typeof s.patterns, 'number');
      assert.equal(typeof s.projects, 'number');

      await fs.rm(tmp2, { recursive: true, force: true });
    });
  });

  // Reviewer should-fix: consolidate()'s read-modify-write on feedback.jsonl is not atomic — a
  // concurrent record() (a real POST /feedback) landing between consolidate's read and its
  // write-back must not be silently overwritten by consolidate's now-stale snapshot.
  describe('consolidate() vs a concurrent record() — the concurrent verdict must never be dropped', () => {
    test('a verdict recorded mid-consolidate survives', async () => {
      const tmp3 = path.join(os.tmpdir(), 'sf-memory-race-' + crypto.randomBytes(4).toString('hex'));
      const store3 = new Store(tmp3);
      await fs.mkdir(path.join(tmp3, 'src'), { recursive: true });
      const project3 = await store3.openProject({ sourceRoot: path.join(tmp3, 'src'), name: 'RACE' });
      const pid3 = project3.id;

      // Seed feedback.jsonl with two verdicts for the SAME key so consolidate has real work to do.
      await recordVerdict(store3, pid3, { findingId: 'finding:F-1', rule: 'R', route: 'GET /x', verdict: 'reject' });
      await recordVerdict(store3, pid3, { findingId: 'finding:F-1', rule: 'R', route: 'GET /x', verdict: 'accept' });

      // Inject a real delay into consolidate's read of feedback.jsonl, giving a concurrent
      // record() a real window to land between consolidate's read and its write-back — without
      // this, the race is timing-dependent and the test would be flaky either way.
      const realReadFile = fs.readFile.bind(fs);
      fs.readFile = async (file, ...rest) => {
        const content = await realReadFile(file, ...rest);
        if (String(file).endsWith('feedback.jsonl')) await new Promise((r) => setTimeout(r, 60));
        return content;
      };
      try {
        const consolidatePromise = consolidate(store3, pid3);
        await new Promise((r) => setTimeout(r, 15)); // let consolidate's (now-delayed) read be issued first
        const concurrentVerdict = recordVerdict(store3, pid3, { findingId: 'finding:F-2', rule: 'R2', route: 'GET /y', verdict: 'reject' });
        await Promise.all([consolidatePromise, concurrentVerdict]);
      } finally {
        fs.readFile = realReadFile;
      }

      const raw = await fs.readFile(path.join(store3.projectDir(pid3), 'memory', 'feedback.jsonl'), 'utf8');
      const entries = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(entries.some((e) => e.findingId === 'finding:F-2'),
        'the concurrent verdict recorded mid-consolidate must survive, not be silently dropped by the stale overwrite');

      await fs.rm(tmp3, { recursive: true, force: true });
    });
  });
});
