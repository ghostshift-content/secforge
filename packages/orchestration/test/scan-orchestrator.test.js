import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store, writeNodes, writeEdges } from '@secforge/store';
import { SessionManager } from '@secforge/session';
import { runScanOrchestration, subscribe } from '../src/index.js';

const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [{ file: 'a.js', line: 1 }] });
const endpoint = (id, method, route, extra = {}) => ({ id, type: 'ENDPOINT', name: `${method} ${route}`, data: { method, route, ...extra }, claims: [{ file: 'a.js', line: 2 }] });
const authNode = (id, kind) => ({ id, type: 'AUTH_CHECK', name: kind, data: { kind }, claims: [] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

let tmpRoot;
before(async () => { tmpRoot = path.join(os.tmpdir(), 'sf-orch-scan-' + crypto.randomBytes(4).toString('hex')); await fs.mkdir(tmpRoot, { recursive: true }); });
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

// One project with an UNAUTHENTICATED endpoint under 'f:pub' (→ ACX-missing-authentication, the
// simplest rule to trigger deterministically with no LLM engine at all) and a real snapshot dir
// so decorate.js's snippet lookup degrades cleanly instead of throwing.
async function pubFeatureProject(name, { StoreCls = Store } = {}) {
  const root = path.join(tmpRoot, name);
  const src = path.join(root, 'src');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'a.js'), "router.get('/public', (req,res)=>res.json({}));\n");
  const store = new StoreCls(root);
  const project = await store.openProject({ sourceRoot: src, name });
  const pid = project.id;
  const snapshotId = 'snap-' + name;
  await writeNodes(store, pid, [feature('f:pub', 'pub'), endpoint('ep', 'GET', '/public')], { snapshotId });
  await writeEdges(store, pid, [edge('EXPOSES', 'f:pub', 'ep')], { snapshotId });
  const mgr = new SessionManager(store);
  const { session } = await mgr.open({ sourceRoot: src, name });
  await mgr.start(pid, session.sessionId);
  return { store, mgr, projectId: pid, sessionId: session.sessionId };
}

describe('runScanOrchestration()', () => {
  test('a coverage-gap feature returns an honest gap; runAssessment is never invoked', async () => {
    const { store, mgr, projectId, sessionId } = await pubFeatureProject('gap');
    const seen = [];
    const unsub = subscribe(sessionId, (evt) => seen.push(evt));

    const result = await runScanOrchestration({ store, mgr, projectId, sessionId, featureId: 'f:does-not-exist', engine: 'rules' });
    unsub();

    assert.equal(result.ok, false);
    assert.equal(result.gap, true);
    assert.match(result.error, /coverage gap/);
    // no hunter/triager/validator/reporter events ever fired — proof runAssessment wasn't run.
    assert.ok(!seen.some((e) => ['framer', 'hunter', 'triager', 'validator', 'reporter'].includes(e.stage)));

    const final = await mgr.status(projectId, sessionId);
    assert.equal(final.phase.stage, 'error');
    assert.equal(final.status, 'running');
  });

  test('a normal feature delegates to runAssessment: phases recorded in role order, findings returned', async () => {
    const { store, mgr, projectId, sessionId } = await pubFeatureProject('normal');
    const seenStages = [];
    const unsub = subscribe(sessionId, (evt) => { if (evt.stage) seenStages.push(evt.stage); });

    const result = await runScanOrchestration({ store, mgr, projectId, sessionId, featureId: 'f:pub', engine: 'rules' });
    unsub();

    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].rule, 'ACX-missing-authentication');

    // role order matches AGENT_ROLES, byte-compatible with the existing UI stage strip.
    const order = ['context', 'framer', 'hunter', 'triager', 'validator', 'reporter', 'done'];
    let idx = -1;
    for (const stage of order) {
      const at = seenStages.indexOf(stage);
      assert.ok(at > idx, `expected '${stage}' after the previous stage (seen: ${seenStages.join(',')})`);
      idx = at;
    }

    const final = await mgr.status(projectId, sessionId);
    assert.equal(final.phase.stage, 'done');
    assert.equal(final.phase.pct, 100);
    assert.equal(final.phase.result.findings, 1);
    assert.equal(final.phase.feature, 'f:pub');
    assert.equal(final.status, 'running');
  });

  test('a forced runAssessment failure degrades to a recorded error + shaped result, session never crashes', async () => {
    class BrokenStore extends Store {
      async writeFinding() { throw new Error('simulated disk failure'); } // report() calls this per candidate, unguarded
    }
    const { store, mgr, projectId, sessionId } = await pubFeatureProject('broken', { StoreCls: BrokenStore });

    const result = await runScanOrchestration({ store, mgr, projectId, sessionId, featureId: 'f:pub', engine: 'rules' });

    assert.equal(result.ok, false);
    assert.match(result.error, /simulated disk failure/);
    const final = await mgr.status(projectId, sessionId);
    assert.equal(final.phase.stage, 'error');
    assert.match(final.phase.error, /simulated disk failure/);
    assert.equal(final.status, 'running'); // never a crashed process, never silently 'completed'
  });
});
