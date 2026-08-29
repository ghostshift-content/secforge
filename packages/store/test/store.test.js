import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';

let tmpRoot;
let store;

before(async () => {
  tmpRoot = path.join(os.tmpdir(), 'sf-test-' + crypto.randomBytes(4).toString('hex'));
  store = new Store(tmpRoot);
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('Store.openProject', () => {
  test('is idempotent by sourceRoot', async () => {
    const sourceRoot = path.join(tmpRoot, 'src-a');
    const first = await store.openProject({ sourceRoot, name: 'A' });
    const second = await store.openProject({ sourceRoot, name: 'A' });
    assert.equal(first.id, second.id);

    const projects = await store.listProjects();
    const matches = projects.filter((p) => p.id === first.id);
    assert.equal(matches.length, 1);
  });
});

describe('runs', () => {
  test('writeRun then readRun round-trips, listRuns returns it', async () => {
    const sourceRoot = path.join(tmpRoot, 'src-b');
    const project = await store.openProject({ sourceRoot, name: 'B' });
    const run = { sessionId: 's_abc123', status: 'created', project: project.id };
    await store.writeRun(project.id, run);

    const read = await store.readRun(project.id, run.sessionId);
    assert.deepEqual(read, run);

    const list = await store.listRuns(project.id);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], run);

    const file = store.runFile(project.id, run.sessionId);
    await assert.doesNotReject(fs.access(file));
  });
});

describe('events', () => {
  test('appendEvent appends a line to events.log', async () => {
    const sourceRoot = path.join(tmpRoot, 'src-c');
    const project = await store.openProject({ sourceRoot, name: 'C' });
    await store.appendEvent(project.id, { type: 'test.event' });
    await store.appendEvent(project.id, { type: 'test.event2' });

    const file = path.join(store.projectDir(project.id), 'events.log');
    const content = await fs.readFile(file, 'utf8');
    const lines = content.trim().split('\n');
    // openProject itself appends a project.created event, so expect >= 3
    assert.ok(lines.length >= 3);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed.some((e) => e.type === 'test.event'));
    assert.ok(parsed.some((e) => e.type === 'test.event2'));
  });
});

describe('findings', () => {
  test('writeFinding + listFindings round-trips', async () => {
    const sourceRoot = path.join(tmpRoot, 'src-d');
    const project = await store.openProject({ sourceRoot, name: 'D' });
    const finding = { id: 'finding:F-1-idor', title: 'IDOR on /foo' };
    await store.writeFinding(project.id, finding);

    const list = await store.listFindings(project.id);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], finding);

    const file = path.join(store.projectDir(project.id), 'assess', 'findings', 'F-1-idor', 'finding.json');
    await assert.doesNotReject(fs.access(file));
  });
});
