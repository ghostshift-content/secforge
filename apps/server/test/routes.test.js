import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
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
