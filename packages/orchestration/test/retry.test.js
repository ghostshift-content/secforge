import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';

describe('withRetry', () => {
  test('returns the result on first success, never retries', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; }, { retries: 1, delayMs: 1 });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  test('retries once on a transient failure then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'recovered';
    }, { retries: 1, delayMs: 1 });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2);
  });

  test('a deterministic failure exhausts retries and rethrows — never masked as success', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error('always fails'); }, { retries: 1, delayMs: 1 }),
      /always fails/,
    );
    assert.equal(calls, 2); // 1 initial + 1 retry, then give up
  });
});
