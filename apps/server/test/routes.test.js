import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SCOPE_KINDS, RUN_METHODS } from '@secforge/schemas';
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
    code: null, body: null,
    writeHead(c) { this.code = c; },
    end(b) { this.body = b ? JSON.parse(b) : null; },
  };
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
