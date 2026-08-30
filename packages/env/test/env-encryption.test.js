// docs/PHASE4-ENV-PROVIDER-DESIGN.md §4 — secrets-at-rest for env/target.json's authHeader
// and extraHeaders ONLY (AES-256-GCM, node:crypto, machine-local key). SECFORGE_ENV_KEY is set
// for every test here so encryption never touches the real ~/.secforge/keyring during CI/dev.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { registerTarget, getTarget } from '@secforge/env';

let tmpRoot, store, pid, prevKey;

before(async () => {
  prevKey = process.env.SECFORGE_ENV_KEY;
  process.env.SECFORGE_ENV_KEY = crypto.randomBytes(32).toString('base64');
  tmpRoot = path.join(os.tmpdir(), 'sf-env-enc-' + crypto.randomBytes(4).toString('hex'));
  store = new Store(tmpRoot);
  await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
  pid = (await store.openProject({ sourceRoot: path.join(tmpRoot, 'src'), name: 'ENC' })).id;
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (prevKey === undefined) delete process.env.SECFORGE_ENV_KEY; else process.env.SECFORGE_ENV_KEY = prevKey;
});

function targetFile() { return path.join(store.projectDir(pid), 'env', 'target.json'); }

describe('secrets-at-rest: authHeader/extraHeaders are encrypted, everything else stays plaintext', () => {
  test('raw target.json never contains the plaintext secret; envelope shape is present', async () => {
    await registerTarget(store, pid, {
      baseUrl: 'https://target.example.test',
      authHeader: 'Bearer super-secret-token-xyz',
      extraHeaders: { 'X-Api-Key': 'topsecret-api-key' },
      scope: ['target.example.test'],
      authorized: true,
    });
    const raw = await fs.readFile(targetFile(), 'utf8');
    assert.equal(raw.includes('super-secret-token-xyz'), false, 'authHeader plaintext must not be on disk');
    assert.equal(raw.includes('topsecret-api-key'), false, 'extraHeaders plaintext must not be on disk');

    const onDisk = JSON.parse(raw);
    assert.equal(onDisk.baseUrl, 'https://target.example.test'); // plaintext fields untouched
    assert.equal(onDisk.authorized, true);
    assert.deepEqual(onDisk.scope, ['target.example.test']);
    assert.equal(onDisk.authHeader, undefined, 'no plaintext authHeader key on disk');
    assert.equal(onDisk.extraHeaders, undefined, 'no plaintext extraHeaders key on disk');
    for (const env of [onDisk.authHeaderEnc, onDisk.extraHeadersEnc]) {
      assert.equal(env.v, 1);
      assert.equal(typeof env.iv, 'string'); assert.ok(env.iv.length > 0);
      assert.equal(typeof env.tag, 'string'); assert.ok(env.tag.length > 0);
      assert.equal(typeof env.ct, 'string'); assert.ok(env.ct.length > 0);
    }
  });

  test('getTarget() decrypts on read — round-trips to the original plaintext', async () => {
    const t = await getTarget(store, pid);
    assert.equal(t.authHeader, 'Bearer super-secret-token-xyz');
    assert.deepEqual(t.extraHeaders, { 'X-Api-Key': 'topsecret-api-key' });
    assert.equal(t.baseUrl, 'https://target.example.test');
    assert.equal(t.authorized, true);
  });

  test('null/empty secrets stay unencrypted-nothing (no envelope written)', async () => {
    const tmp2 = path.join(os.tmpdir(), 'sf-env-enc2-' + crypto.randomBytes(4).toString('hex'));
    const store2 = new Store(tmp2);
    await fs.mkdir(path.join(tmp2, 'src'), { recursive: true });
    const pid2 = (await store2.openProject({ sourceRoot: path.join(tmp2, 'src'), name: 'ENC2' })).id;
    await registerTarget(store2, pid2, { baseUrl: 'https://x.test' });
    const raw = JSON.parse(await fs.readFile(path.join(store2.projectDir(pid2), 'env', 'target.json'), 'utf8'));
    assert.equal(raw.authHeaderEnc, null);
    assert.equal(raw.extraHeadersEnc, null);
    const t = await getTarget(store2, pid2);
    assert.equal(t.authHeader, null);
    assert.deepEqual(t.extraHeaders, {});
    await fs.rm(tmp2, { recursive: true, force: true });
  });

  test('legacy plaintext target.json (pre-encryption format) still reads correctly', async () => {
    const tmp3 = path.join(os.tmpdir(), 'sf-env-legacy-' + crypto.randomBytes(4).toString('hex'));
    const store3 = new Store(tmp3);
    await fs.mkdir(path.join(tmp3, 'src'), { recursive: true });
    const pid3 = (await store3.openProject({ sourceRoot: path.join(tmp3, 'src'), name: 'LEGACY' })).id;
    const legacyFile = path.join(store3.projectDir(pid3), 'env', 'target.json');
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(legacyFile, JSON.stringify({
      baseUrl: 'https://legacy.test', authHeader: 'Bearer old-plaintext', extraHeaders: { X: 'y' },
      scope: [], authorized: false, updatedAt: new Date().toISOString(),
    }));
    const t = await getTarget(store3, pid3);
    assert.equal(t.authHeader, 'Bearer old-plaintext');
    assert.deepEqual(t.extraHeaders, { X: 'y' });
    assert.equal(t.baseUrl, 'https://legacy.test');
    await fs.rm(tmp3, { recursive: true, force: true });
  });

  test('a corrupt/tampered envelope never throws — decrypts to null, like a missing file', async () => {
    const raw = JSON.parse(await fs.readFile(targetFile(), 'utf8'));
    raw.authHeaderEnc.tag = Buffer.from('tampered-tag-not-valid!!').toString('base64').slice(0, 24);
    await fs.writeFile(targetFile(), JSON.stringify(raw, null, 2));
    const t = await getTarget(store, pid); // must not throw
    assert.equal(t.authHeader, null, 'tampered auth tag degrades to null, does not throw or crash the read path');
  });
});
