import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fanOut, runAll } from '@secforge/orchestrator';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runAll', () => {
  test('runs all jobs and collects results in completion order', async () => {
    const jobs = [1, 2, 3, 4, 5];
    const results = await runAll(jobs, async (job) => job * 10, { concurrency: 2 });

    assert.equal(results.length, jobs.length);
    const values = results.map((r) => r.result).sort((a, b) => a - b);
    assert.deepEqual(values, [10, 20, 30, 40, 50]);
  });

  test('respects the concurrency cap', async () => {
    const jobs = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    const concurrency = 3;

    await runAll(jobs, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active--;
      return true;
    }, { concurrency });

    assert.ok(maxActive <= concurrency, `maxActive=${maxActive} exceeded concurrency=${concurrency}`);
  });

  test('handles an empty job list, emitting done with []', async () => {
    const results = await runAll([], async () => 'never');
    assert.deepEqual(results, []);
  });

  test('captures a worker error into results without rejecting the run', async () => {
    const jobs = ['ok', 'boom', 'ok2'];
    const results = await runAll(jobs, async (job) => {
      if (job === 'boom') throw new Error('worker failed');
      return job;
    }, { concurrency: 2 });

    assert.equal(results.length, 3);
    const errored = results.find((r) => r.job === 'boom');
    assert.ok(errored);
    assert.ok(errored.error.includes('worker failed'));
    const ok = results.filter((r) => r.job !== 'boom');
    assert.ok(ok.every((r) => r.result === r.job));
  });
});

describe('fanOut', () => {
  // NOTE: fanOut() calls pump() synchronously before returning the emitter, so
  // 'job:start' for the initial (up to `concurrency`) jobs fires before a caller
  // can attach a listener — see the bug noted in the final report. We only assert
  // on events that are guaranteed to be observed asynchronously (job:done/done).
  test('emits job:done for every job and done with all results', async () => {
    const jobs = ['a', 'b', 'c'];
    const finished = [];

    await new Promise((resolve) => {
      const events = fanOut(jobs, async (job) => job.toUpperCase(), { concurrency: 2 });
      events.on('job:done', (job, result) => finished.push({ job, result }));
      events.on('done', resolve);
    });

    assert.equal(finished.length, 3);
    assert.deepEqual(finished.map((f) => f.result).sort(), ['A', 'B', 'C']);
  });
});
