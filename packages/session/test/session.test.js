import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { SessionManager } from '@secforge/session';

let tmpRoot;

before(async () => {
  tmpRoot = path.join(os.tmpdir(), 'sf-test-' + crypto.randomBytes(4).toString('hex'));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('SessionManager.open', () => {
  test('creates a session on first open', async () => {
    const sm = new SessionManager(new Store(tmpRoot));
    const sourceRoot = path.join(tmpRoot, 'proj-1');
    const { project, session, resumed } = await sm.open({ sourceRoot, name: 'Proj1' });

    assert.equal(resumed, false);
    assert.equal(session.status, 'created');
    assert.ok(session.sessionId.startsWith('s_'));
    assert.equal(session.project, project.id);
  });

  test('resumes the same session on a second open, without duplicating the run', async () => {
    const sm = new SessionManager(new Store(tmpRoot));
    const sourceRoot = path.join(tmpRoot, 'proj-2');
    const first = await sm.open({ sourceRoot, name: 'Proj2' });
    const second = await sm.open({ sourceRoot, name: 'Proj2' });

    assert.equal(second.resumed, true);
    assert.equal(second.session.sessionId, first.session.sessionId);

    const runs = await sm.store.listRuns(first.project.id);
    assert.equal(runs.length, 1);
  });

  test('a fresh SessionManager on the same root rehydrates the session from disk', async () => {
    const sourceRoot = path.join(tmpRoot, 'proj-3');
    const sm1 = new SessionManager(new Store(tmpRoot));
    const opened = await sm1.open({ sourceRoot, name: 'Proj3' });
    await sm1.start(opened.project.id, opened.session.sessionId);

    // brand-new manager instance, same underlying data root
    const sm2 = new SessionManager(new Store(tmpRoot));
    const reopened = await sm2.open({ sourceRoot, name: 'Proj3' });

    assert.equal(reopened.resumed, true);
    assert.equal(reopened.session.sessionId, opened.session.sessionId);
    assert.equal(reopened.session.status, 'running');
  });
});

describe('SessionManager transitions', () => {
  test('start -> pause -> resume -> cancel persist across a fresh manager', async () => {
    const sourceRoot = path.join(tmpRoot, 'proj-4');
    const sm = new SessionManager(new Store(tmpRoot));
    const { project, session } = await sm.open({ sourceRoot, name: 'Proj4' });

    await sm.start(project.id, session.sessionId);
    let s = await sm.status(project.id, session.sessionId);
    assert.equal(s.status, 'running');

    await sm.pause(project.id, session.sessionId);
    s = await sm.status(project.id, session.sessionId);
    assert.equal(s.status, 'paused');

    await sm.resume(project.id, session.sessionId);
    s = await sm.status(project.id, session.sessionId);
    assert.equal(s.status, 'running');

    await sm.cancel(project.id, session.sessionId);
    s = await sm.status(project.id, session.sessionId);
    assert.equal(s.status, 'cancelled');

    // verify via a completely fresh manager instance too
    const sm2 = new SessionManager(new Store(tmpRoot));
    const s2 = await sm2.status(project.id, session.sessionId);
    assert.equal(s2.status, 'cancelled');
  });

  test('illegal transitions throw', async () => {
    const sourceRoot = path.join(tmpRoot, 'proj-5');
    const sm = new SessionManager(new Store(tmpRoot));
    const { project, session } = await sm.open({ sourceRoot, name: 'Proj5' });

    // created -> paused is illegal
    await assert.rejects(sm.pause(project.id, session.sessionId), /illegal session transition/);

    await sm.cancel(project.id, session.sessionId);
    // cancelled -> running is illegal
    await assert.rejects(sm.start(project.id, session.sessionId), /illegal session transition/);
  });
});

describe('SessionManager.configureRun', () => {
  test('persists scope onto the session', async () => {
    const sourceRoot = path.join(tmpRoot, 'proj-6');
    const sm = new SessionManager(new Store(tmpRoot));
    const { project, session } = await sm.open({ sourceRoot, name: 'Proj6' });

    const scope = { mode: 'feature', method: 'pattern', feature: 'feature:login' };
    await sm.configureRun(project.id, session.sessionId, scope);

    const sm2 = new SessionManager(new Store(tmpRoot));
    const s = await sm2.status(project.id, session.sessionId);
    assert.deepEqual(s.scope, scope);
  });
});
