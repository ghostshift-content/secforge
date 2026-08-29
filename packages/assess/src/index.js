// @secforge/assess — the assessment pipeline. Fans framer→hunters→triager→validator→reporter
// over the orchestrator, tracking coverage as a feature × pattern matrix (every cell a verdict).
// Phase 2 wraps the StaticCodeReview engine; this skeleton wires the flow end to end.

import { runAll } from '@secforge/orchestrator';
import { ROLES } from '@secforge/agents';
import { getAdapter } from '@secforge/adapters';
import { jobEnvelope, ID } from '@secforge/schemas';

// Build the fan-out jobs for a run scope (from the run screen).
export function planJobs(scope) {
  const features = scope.mode === 'all' ? ['<all>'] : (scope.features || [scope.feature]).filter(Boolean);
  const patterns = scope.method === 'prompt' ? ['<prompt>'] : (scope.patterns || []);
  const jobs = [];
  let n = 0;
  for (const feature of features) {
    for (const pattern of (patterns.length ? patterns : ['<applicable>'])) {
      jobs.push(jobEnvelope({ id: `j${++n}`, role: 'hunter', scope: scope.mode, method: scope.method, feature, patterns: [pattern], prompt: scope.prompt }));
    }
  }
  return jobs;
}

// Run an assessment. Returns candidates streamed through the pipeline stages.
export async function runAssessment({ scope, engine = 'claude-code', onEvent } = {}) {
  const adapter = getAdapter(engine);
  const jobs = planJobs(scope);
  onEvent?.({ stage: 'framer', status: 'done', jobs: jobs.length });

  const hunted = await runAll(jobs, async (job) => {
    onEvent?.({ stage: 'hunter', job: job.id, feature: job.feature });
    return adapter.runAgent(job);
  });

  // Triage → validate → report are enforced-separate stages (stubbed here).
  const candidates = hunted.flatMap((h) => h.result?.candidates || []);
  onEvent?.({ stage: 'triager', kept: candidates.length });
  onEvent?.({ stage: 'validator', queued: candidates.length });
  onEvent?.({ stage: 'reporter', promoted: 0 });

  return { jobs: jobs.length, candidates, note: 'assess pipeline stub — StaticCodeReview wrapped in Phase 2' };
}

export { ROLES, ID };
