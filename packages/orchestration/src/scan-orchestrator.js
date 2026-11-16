// @secforge/orchestration/scan-orchestrator — sequences one feature-scoped scan for a session:
// pulls the feature's grounded context up front (fail fast + honest on a coverage gap), then
// delegates the actual framer->hunter->triager->validator->reporter run to @secforge/assess's
// existing runAssessment — never reimplemented here. Records session.phase and emits live bus
// events as it goes; a downstream failure degrades to a recorded error, never a session crash.
import { runAssessment } from '@secforge/assess';
import { buildFeedForward } from '@secforge/retrieval';
import { withRetry } from './retry.js';
import * as bus from './bus.js';

const now = () => new Date().toISOString();

// Map runAssessment's own onEvent shapes (assess/src/index.js) onto session.phase.{stage,pct}.
// No new stage vocabulary — this IS AGENT_ROLES (schemas/src/index.js), so the existing UI stage
// strip keeps working once wired to a live stream. Returns null for an event with no stage change
// of its own (e.g. the internal 'grounding' event) — the raw event still reaches the bus untouched.
function makeRoleProgress() {
  let totalJobs = 0;
  let hunterSeen = 0;
  return function roleProgress(evt) {
    switch (evt.stage) {
      case 'framer':
        totalJobs = evt.jobs || 0;
        return { stage: 'framer', pct: 10 };
      case 'hunter': {
        hunterSeen += 1;
        const pct = totalJobs > 0 ? Math.min(70, 20 + Math.round((hunterSeen / totalJobs) * 50)) : 20;
        return { stage: 'hunter', pct };
      }
      case 'triager': return { stage: 'triager', pct: 80 };
      case 'validator': return { stage: 'validator', pct: 90 };
      case 'reporter': return { stage: 'reporter', pct: 100 };
      default: return null;
    }
  };
}

/**
 * Run one scan phase for a session, scoped to a single feature. Never throws — a coverage gap or
 * a downstream runAssessment failure is recorded as an honest `phase.stage==='error'` and returned
 * as `{ok:false, error}`; session.status is left untouched (never escalated into a crash).
 */
export async function runScanOrchestration({ store, mgr, projectId, sessionId, featureId, scope, engine = 'rules', model = null, effort = 'medium' } = {}) {
  await mgr.recordPhase(projectId, sessionId, { name: 'scan', stage: 'context', pct: 5, feature: featureId, error: null, result: null, startedAt: now() });
  bus.emit(sessionId, { stage: 'context', feature: featureId });

  // Pull the feature's grounded context up front, honestly: a coverage gap means never starting
  // a hunt with nothing to ground it. Discarded afterward — runAssessment's own llmAssist already
  // re-derives the identical per-feature buildFeedForward call internally.
  const bundle = await buildFeedForward(store, projectId, featureId);
  if (!bundle.ok) {
    const error = bundle.reason || 'coverage gap: feature not found';
    await mgr.recordPhase(projectId, sessionId, { stage: 'error', error });
    bus.emit(sessionId, { stage: 'error', error });
    return { ok: false, gap: true, error };
  }
  await mgr.recordPhase(projectId, sessionId, {
    result: { willScan: { endpoints: bundle.endpoints?.length || 0, services: bundle.services?.length || 0, citations: bundle.citations?.length || 0 } },
  });

  // recordPhase is read-modify-write; onEvent fires synchronously in role order but must not race
  // its own writes (an earlier stage's write completing AFTER a later one would clobber it) — chain
  // every call so they land in issue order, and the final done/error write waits for all of them.
  let chain = Promise.resolve();
  const recordSequential = (patch) => { chain = chain.then(() => mgr.recordPhase(projectId, sessionId, patch)).catch(() => {}); return chain; };

  const roleProgress = makeRoleProgress();
  const scanScope = { mode: 'feature', method: scope?.method || 'pattern', feature: featureId, patterns: scope?.patterns, prompt: scope?.prompt }; // prompt rides along so a feature-scoped "test X" still focuses the LLM pass
  try {
    const result = await withRetry(() => runAssessment({
      store, projectId, scope: scanScope, engine, model, effort,
      onEvent: (evt) => {
        const patch = roleProgress(evt);
        if (patch) recordSequential(patch); // best-effort, order-preserving; never blocks the scan
        bus.emit(sessionId, evt);
      },
    }), { retries: 1 });

    const summary = { findings: result.findings.length, coverage: result.coverage, featuresSkipped: result.featuresSkipped };
    await recordSequential({ stage: 'done', pct: 100, result: summary });
    bus.emit(sessionId, { stage: 'done', result: summary });
    return { ok: true, ...result };
  } catch (err) {
    const error = String(err?.message || err);
    await recordSequential({ stage: 'error', error });
    bus.emit(sessionId, { stage: 'error', error });
    return { ok: false, error };
  }
}
