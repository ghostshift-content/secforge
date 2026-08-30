import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { registerTarget, getTarget } from '@secforge/env';

let tmpRoot, store, pid;

before(async () => {
  tmpRoot = path.join(os.tmpdir(), 'sf-env-' + crypto.randomBytes(4).toString('hex'));
  store = new Store(tmpRoot);
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  pid = (await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'ENV' })).id;
});

after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('registerTarget URL scheme allowlist (P1-2)', () => {
  test('rejects javascript:, file:, and non-URLs; nothing is persisted', async () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'notaurl']) {
      await assert.rejects(registerTarget(store, pid, { baseUrl: bad }), /http/);
    }
    assert.equal(await getTarget(store, pid), null); // no bad target persisted
  });

  test('accepts http and https and persists them', async () => {
    const t = await registerTarget(store, pid, { baseUrl: 'https://target.example.test', scope: ['target.example.test'] });
    assert.equal(t.baseUrl, 'https://target.example.test');
    assert.equal(t.authorized, false); // static-only by default
    const back = await getTarget(store, pid);
    assert.equal(back.baseUrl, 'https://target.example.test');
  });
});
