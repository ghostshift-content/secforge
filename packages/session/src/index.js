// @secforge/session — the Session Manager. One scan = one session, bound to one project.
// The session is a shell over durable state: every transition is persisted, so killing and
// reopening rehydrates identically. One active session per project (locked decision).

import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { assertTransition, ID } from '@secforge/schemas';

const newSessionId = () => 's_' + crypto.randomBytes(4).toString('hex');

export class SessionManager {
  constructor(store = new Store()) { this.store = store; }

  // Open a project and start (or resume) its single active session.
  async open({ sourceRoot, name, engine } = {}) {
    const project = await this.store.openProject({ sourceRoot, name });
    const active = (await this.store.listRuns(project.id)).find((r) => r && ['created', 'running', 'paused'].includes(r.status));
    if (active) return { project, session: active, resumed: true };

    const session = {
      sessionId: newSessionId(),
      project: project.id,
      projectName: project.name,
      revision: null,
      engine: engine || { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'high' },
      scope: null,
      status: 'created',
      jobs: [],
      coverage: { matrixCells: 0, verified: 0 },
      createdAt: new Date().toISOString(),
      checkpointedAt: new Date().toISOString(),
    };
    await this._persist(project.id, session, 'session.created');
    return { project, session, resumed: false };
  }

  async status(projectId, sessionId) { return this.store.readRun(projectId, sessionId); }

  async transition(projectId, sessionId, to) {
    const s = await this.store.readRun(projectId, sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    assertTransition(s.status, to);
    s.status = to;
    await this._persist(projectId, s, `session.${to}`);
    return s;
  }

  start(projectId, sessionId) { return this.transition(projectId, sessionId, 'running'); }
  pause(projectId, sessionId) { return this.transition(projectId, sessionId, 'paused'); }
  resume(projectId, sessionId) { return this.transition(projectId, sessionId, 'running'); }
  cancel(projectId, sessionId) { return this.transition(projectId, sessionId, 'cancelled'); }
  complete(projectId, sessionId) { return this.transition(projectId, sessionId, 'completed'); }

  // Attach a scan's scope/method to the active session (the run screen's config).
  async configureRun(projectId, sessionId, scope) {
    const s = await this.store.readRun(projectId, sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    s.scope = scope; // { mode, method, feature|features|all, patterns, prompt }
    await this._persist(projectId, s, 'run.configured');
    return s;
  }

  // Record the engine actually used for the run (provider + model) — the reproducibility field.
  async recordEngine(projectId, sessionId, engine) {
    const s = await this.store.readRun(projectId, sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    s.engine = engine;
    await this._persist(projectId, s, 'run.engine');
    return s;
  }

  // Record the orchestrator's current phase/stage/progress onto the session (Phase D).
  // Shallow-merges `patch` into session.phase — never clobbers unrelated phase keys.
  async recordPhase(projectId, sessionId, patch) {
    const s = await this.store.readRun(projectId, sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    s.phase = { ...(s.phase || {}), ...patch, updatedAt: new Date().toISOString() };
    await this._persist(projectId, s, 'session.phase');
    return s;
  }

  async _persist(projectId, session, eventType) {
    session.checkpointedAt = new Date().toISOString();
    await this.store.writeRun(projectId, session);
    await this.store.appendEvent(projectId, { type: eventType, session: session.sessionId, status: session.status });
  }
}

export { ID };
