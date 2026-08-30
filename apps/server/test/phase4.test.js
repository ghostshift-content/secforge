// docs/PHASE4-ENV-PROVIDER-DESIGN.md — effort passthrough, secrets-at-rest not leaked by
// GET /env, and validate-live only ever attempts a real (non-dry-run) check against an
// authorized target.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { handleApi, validEffort } from '../src/routes.js';

// This suite registers real secrets against the module-level Store() (default DATA_ROOT), which
// would otherwise make @secforge/env generate/write a real key under the real ~/.secforge/keyring
// the first time a secret is encrypted. A fixed SECFORGE_ENV_KEY (like env-encryption.test.js
// uses) skips that entirely — this suite must never touch the real keyring.
let prevEnvKey;
before(() => { prevEnvKey = process.env.SECFORGE_ENV_KEY; process.env.SECFORGE_ENV_KEY = crypto.randomBytes(32).toString('base64'); });
after(() => { if (prevEnvKey === undefined) delete process.env.SECFORGE_ENV_KEY; else process.env.SECFORGE_ENV_KEY = prevEnvKey; });

function mockReq(method, body) {
  const r = Readable.from([body == null ? '' : JSON.stringify(body)]);
  r.method = method;
  return r;
}
function mockRes() {
  return {
    code: null, body: null,
    writeHead(c) { this.code = c; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
}

describe('validEffort()', () => {
  test('accepts the four known levels', () => {
    for (const e of ['low', 'medium', 'high', 'max']) assert.equal(validEffort(e), e);
  });
  test('anything unknown, missing, or wrong-typed coerces to "medium"', () => {
    assert.equal(validEffort('bogus'), 'medium');
    assert.equal(validEffort(undefined), 'medium');
    assert.equal(validEffort(null), 'medium');
    assert.equal(validEffort(42), 'medium');
  });
});

async function openMappedProject(tag) {
  const tmp = path.join(os.tmpdir(), 'sf-p4-' + tag + '-' + crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(path.join(tmp, 'api'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'api', 'orders.js'), [
    "router.get('/orders/:id', (req, res) => res.json({}));",
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
async function cleanup(tmp, pid) {
  await handleApi(mockReq('DELETE', {}), mockRes(), new URL('http://x/api/projects/' + pid));
  await fsp.rm(tmp, { recursive: true, force: true });
}

describe('POST /api/sessions/:id/scan — effort passthrough', () => {
  test('an explicit effort is recorded on the run AND on every finding it produced', async () => {
    const { tmp, pid, sid } = await openMappedProject('effort-explicit');
    try {
      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules', effort: 'high' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(scanRes.code, 200, JSON.stringify(scanRes.body));
      assert.equal(scanRes.body.effort, 'high');
      assert.ok(scanRes.body.findings.length > 0);
      assert.ok(scanRes.body.findings.every((f) => f.engine.effort === 'high'));

      const statusRes = mockRes();
      await handleApi(mockReq('GET', {}), statusRes, new URL('http://x/api/sessions/' + sid + '?project=' + pid));
      assert.equal(statusRes.code, 200);
      assert.equal(statusRes.body.engine.effort, 'high', 'GET /sessions/:id reflects the recorded effort');
    } finally { await cleanup(tmp, pid); }
  });

  test('omitting effort still 200s and defaults to "medium" (backward compatible with the old body shape)', async () => {
    const { tmp, pid, sid } = await openMappedProject('effort-default');
    try {
      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      assert.equal(scanRes.code, 200, JSON.stringify(scanRes.body));
      assert.equal(scanRes.body.effort, 'medium');
      assert.ok(scanRes.body.findings.every((f) => f.engine.effort === 'medium'));
    } finally { await cleanup(tmp, pid); }
  });
});

describe('GET+POST /api/projects/:id/env — never leak the decrypted secret to the browser', () => {
  test('POST (register) response itself carries no plaintext secret — same redacted shape as GET', async () => {
    const { tmp, pid } = await openMappedProject('env-noleak-post');
    try {
      const regRes = mockRes();
      await handleApi(mockReq('POST', {
        baseUrl: 'https://target.example.test', authorized: true,
        authHeader: 'Bearer super-secret-value', extraHeaders: { 'X-Api-Key': 'also-secret' },
      }), regRes, new URL('http://x/api/projects/' + pid + '/env'));
      assert.equal(regRes.code, 200, JSON.stringify(regRes.body));
      const t = regRes.body;
      assert.equal(t.baseUrl, 'https://target.example.test');
      assert.equal(t.authorized, true);
      assert.equal(t.credentialsSet, true);
      assert.equal('authHeader' in t, false, 'POST response must never echo the raw authHeader back');
      assert.equal('extraHeaders' in t, false, 'POST response must never echo raw extraHeaders back');
      assert.equal(JSON.stringify(t).includes('super-secret-value'), false);
      assert.equal(JSON.stringify(t).includes('also-secret'), false);
    } finally { await cleanup(tmp, pid); }
  });

  test('after registering a secret, GET returns credentialsSet:true but no authHeader/extraHeaders keys', async () => {
    const { tmp, pid } = await openMappedProject('env-noleak');
    try {
      const regRes = mockRes();
      await handleApi(mockReq('POST', {
        baseUrl: 'https://target.example.test', authorized: true,
        authHeader: 'Bearer super-secret-value', extraHeaders: { 'X-Api-Key': 'also-secret' },
      }), regRes, new URL('http://x/api/projects/' + pid + '/env'));
      assert.equal(regRes.code, 200, JSON.stringify(regRes.body));

      const getRes = mockRes();
      await handleApi(mockReq('GET', {}), getRes, new URL('http://x/api/projects/' + pid + '/env'));
      assert.equal(getRes.code, 200);
      const t = getRes.body.target;
      assert.equal(t.baseUrl, 'https://target.example.test');
      assert.equal(t.authorized, true);
      assert.equal(t.credentialsSet, true);
      assert.equal('authHeader' in t, false, 'GET must never return the raw authHeader');
      assert.equal('extraHeaders' in t, false, 'GET must never return raw extraHeaders values');
      assert.equal(JSON.stringify(t).includes('super-secret-value'), false);
      assert.equal(JSON.stringify(t).includes('also-secret'), false);
    } finally { await cleanup(tmp, pid); }
  });

  test('no target registered → target is null, credentialsSet never fabricated as true', async () => {
    const { tmp, pid } = await openMappedProject('env-notarget');
    try {
      const getRes = mockRes();
      await handleApi(mockReq('GET', {}), getRes, new URL('http://x/api/projects/' + pid + '/env'));
      assert.equal(getRes.code, 200);
      assert.equal(getRes.body.target, null);
    } finally { await cleanup(tmp, pid); }
  });
});

describe('POST /api/findings/:id/validate — dryRun:false is only actually attempted against an authorized target', () => {
  test('unauthorized project + dryRun:false → refused before any network path, same as the static-only default', async () => {
    const { tmp, pid, sid } = await openMappedProject('validate-unauth');
    try {
      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      const fid = scanRes.body.findings[0].id;

      const valRes = mockRes();
      await handleApi(mockReq('POST', { dryRun: false }), valRes,
        new URL('http://x/api/findings/' + encodeURIComponent(fid) + '/validate?project=' + pid));
      assert.equal(valRes.code, 200);
      assert.equal(valRes.body.ran, false);
      assert.match(valRes.body.reason, /not authoriz/i);
    } finally { await cleanup(tmp, pid); }
  });

  test('authorized target + dryRun:false → past the authorization gate, refused by the SSRF guard instead (not "not authorized")', async () => {
    const { tmp, pid, sid } = await openMappedProject('validate-auth');
    try {
      await handleApi(mockReq('POST', { baseUrl: 'http://127.0.0.1:9', authorized: true }), mockRes(),
        new URL('http://x/api/projects/' + pid + '/env'));

      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      const fid = scanRes.body.findings[0].id;

      const valRes = mockRes();
      await handleApi(mockReq('POST', { dryRun: false }), valRes,
        new URL('http://x/api/findings/' + encodeURIComponent(fid) + '/validate?project=' + pid));
      assert.equal(valRes.code, 200);
      assert.doesNotMatch(valRes.body.reason || '', /not authoriz/i, 'authorized target must get past the auth short-circuit');
      assert.match(valRes.body.reason || '', /SSRF|blocked/i, 'the guarded GET honestly refuses loopback rather than fabricating a live result');
    } finally { await cleanup(tmp, pid); }
  });

  test('unauthorized project + dryRun:true (default) → static-only, unchanged existing behavior', async () => {
    const { tmp, pid, sid } = await openMappedProject('validate-dry-default');
    try {
      const scanRes = mockRes();
      await handleApi(mockReq('POST', { scope: { mode: 'all' }, engine: 'rules' }), scanRes,
        new URL('http://x/api/sessions/' + sid + '/scan?project=' + pid));
      const fid = scanRes.body.findings[0].id;

      const valRes = mockRes();
      await handleApi(mockReq('POST', {}), valRes,
        new URL('http://x/api/findings/' + encodeURIComponent(fid) + '/validate?project=' + pid));
      assert.equal(valRes.code, 200);
      assert.equal(valRes.body.ran, false);
      assert.match(valRes.body.reason, /not authoriz/i);
    } finally { await cleanup(tmp, pid); }
  });
});
