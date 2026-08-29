// @secforge/orchestrator — SecForge's own fan-out scheduler.
// Runs jobs over engine subagents with bounded concurrency and streams progress events.
// No external orchestration runtime.

import { EventEmitter } from 'node:events';

export const DEFAULT_CONCURRENCY = 5;

// Run `jobs` through `worker(job) -> Promise<result>` with a concurrency cap.
// Emits 'job:start' | 'job:done' | 'job:error' | 'done' on the returned emitter.
export function fanOut(jobs, worker, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const events = new EventEmitter();
  const results = [];
  let i = 0, active = 0, done = 0;

  const pump = () => {
    while (active < concurrency && i < jobs.length) {
      const job = jobs[i++];
      active++;
      events.emit('job:start', job);
      Promise.resolve()
        .then(() => worker(job))
        .then((r) => { results.push({ job, result: r }); events.emit('job:done', job, r); })
        .catch((err) => { results.push({ job, error: String(err) }); events.emit('job:error', job, err); })
        .finally(() => { active--; done++; if (done === jobs.length) events.emit('done', results); else pump(); });
    }
  };

  if (jobs.length === 0) queueMicrotask(() => events.emit('done', results));
  else pump();
  return events;
}

// Promise form for callers that just want the collected results.
export function runAll(jobs, worker, opts) {
  return new Promise((resolve) => fanOut(jobs, worker, opts).once('done', resolve));
}
