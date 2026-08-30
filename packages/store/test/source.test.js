import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { snapshotSourceDir, readFrozenSourceLines } from '../src/source.js';

let tmpRoot;
let store;

tmpRoot = path.join(os.tmpdir(), 'sf-source-test-' + crypto.randomBytes(4).toString('hex'));
store = new Store(tmpRoot);

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function freshProject(name) {
  const sourceRoot = path.join(tmpRoot, name);
  await fs.mkdir(sourceRoot, { recursive: true });
  return store.openProject({ sourceRoot, name });
}

describe('snapshotSourceDir / readFrozenSourceLines', () => {
  test('reads the exact line range from a frozen file', async () => {
    const { id: pid } = await freshProject('src-p1');
    const sid = 'snap-1';
    const dir = snapshotSourceDir(store, pid, sid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'app.rb'), 'one\ntwo\nthree\nfour\n');

    assert.equal(await readFrozenSourceLines(store, pid, sid, 'app.rb', 2, 3), 'two\nthree');
    assert.equal(await readFrozenSourceLines(store, pid, sid, 'app.rb', 1), 'one');
  });

  test('a file not in the frozen tree returns null, never a fabricated string', async () => {
    const { id: pid } = await freshProject('src-p2');
    const sid = 'snap-1';
    await fs.mkdir(snapshotSourceDir(store, pid, sid), { recursive: true });
    assert.equal(await readFrozenSourceLines(store, pid, sid, 'nope.rb', 1, 2), null);
  });
});
