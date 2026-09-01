// @secforge/server routes — the API map the UI is wired to. Every UI action → a route → a package.
// See docs/WIRING.md. Handlers are real where the skeleton allows (sessions, store) and shaped
// stubs where a Phase engine lands later (map, assess). Nothing 500s.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { SessionManager } from '@secforge/session';
import { Store, readGraph, readReconciliation, reconciliationCounts } from '@secforge/store';
import { buildFeedForward, answer } from '@secforge/retrieval';
import { runAssessment, computeCoverage, buildReport, renderFeatureMap } from '@secforge/assess';
import { runMapOrchestration, runScanOrchestration, subscribe as subscribePhase } from '@secforge/orchestration';
import { FAMILIES, loadCanonicalCards, cweCatalog, importCustomFolder } from '@secforge/patterns';
import { mapProject } from '@secforge/map';
import { learn, recall, crossProjectRecall, stats, listLearned, recordVerdict, annotatePriorFeedback, minePatterns, consolidate } from '@secforge/memory';
import { registerTarget, getTarget, validateFinding } from '@secforge/env';
import { listEngines, checkConnection, EFFORT_BUDGETS } from '@secforge/adapters';
import { SCOPE_KINDS, RUN_METHODS } from '@secforge/schemas';

const mgr = new SessionManager();
const store = new Store();

// One writing scan per project at a time (P0-2e). The SSE stream is read-only, so it never
// contends; this only serialises the authoritative POST /scan writers.
const activeScans = new Set();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// PHASE4 §4: the browser must never receive a decrypted authHeader/extraHeaders — not on a read
// (GET) and not echoed back from a write (POST) either, so response logs/proxies/browser history
// never carry the secret. Both routes below return exactly this shape.
function redactTarget(t) {
  if (!t) return null;
  return {
    baseUrl: t.baseUrl, scope: t.scope, authorized: t.authorized, updatedAt: t.updatedAt,
    credentialsSet: !!(t.authHeader || (t.extraHeaders && Object.keys(t.extraHeaders).length)),
  };
}

// Only ever run/record a KNOWN engine id (a string). Unknown/non-string → 'rules'.
async function validEngineId(id) {
  if (typeof id !== 'string') return 'rules';
  try { return (await listEngines()).some((e) => e.id === id) ? id : 'rules'; } catch { return 'rules'; }
}
// PHASE4 §2.2: only ever run/record a KNOWN effort level; anything else (missing, typo'd,
// tampered) silently coerces to the documented default rather than erroring the whole scan.
export function validEffort(e) { return Object.prototype.hasOwnProperty.call(EFFORT_BUDGETS, e) ? e : 'medium'; }
// Validate the run scope against the schema's frozen sets; coerce anything invalid to safe defaults.
// Also normalise scope.patterns to family prefixes: a family stays, a CWE id maps to the families
// that carry it, an unknown token (e.g. a custom-set name) is dropped. If nothing resolves, drop
// the field so the scan runs all applicable rules rather than silently matching nothing (C9).
// S3-6: reject an EXPLICIT invalid scope.mode/scope.method instead of silently coercing it.
// Absent fields are fine (they default in normaliseScope); a present-but-unknown value is a 400.
export function scopeInputError(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.mode != null && !SCOPE_KINDS.includes(s.mode)) return 'mode';
  if (s.method != null && !RUN_METHODS.includes(s.method)) return 'method';
  return null;
}

function normaliseScope(s) {
  const scope = (s && typeof s === 'object') ? { ...s } : {};
  scope.mode = SCOPE_KINDS.includes(scope.mode) ? scope.mode : 'all';
  scope.method = RUN_METHODS.includes(scope.method) ? scope.method : 'pattern';
  if (Array.isArray(scope.patterns) && scope.patterns.length) {
    const prefixes = new Set(FAMILIES.map((f) => f.prefix));
    const cweToFam = {};
    for (const f of FAMILIES) for (const c of (f.cwe || [])) (cweToFam[c] = cweToFam[c] || []).push(f.prefix);
    const fams = new Set();
    for (const raw of scope.patterns) {
      const tok = String(raw).split(' · ')[0].trim();
      if (prefixes.has(tok)) fams.add(tok);
      else if (cweToFam[tok]) cweToFam[tok].forEach((p) => fams.add(p));
    }
    if (fams.size) scope.patterns = [...fams]; else delete scope.patterns;
  }
  return scope;
}

// Returns true if the request was an API request (handled here).
export async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const method = req.method;
  const body = await readBody(req);
  const project = url.searchParams.get('project');

  try {
    // /api/health
    if (parts[0] === 'health') return json(res, 200, { ok: true, service: 'secforge', ts: Date.now() }), true;

    // /api/engines → providers with connection status;  /api/engines/:id/connection → live check
    if (parts[0] === 'engines' && method === 'GET') {
      if (parts[1] && parts[2] === 'connection') return json(res, 200, await checkConnection(parts[1])), true;
      return json(res, 200, await listEngines()), true;
    }

    // /api/patterns → family registry (pattern picker);  /api/patterns/cards → 281 canonical cards
    if (parts[0] === 'patterns' && method === 'GET') {
      if (parts[1] === 'cards') return json(res, 200, { cards: loadCanonicalCards() }), true;
      return json(res, 200, { families: FAMILIES }), true;
    }
    // /api/cwe → CWE catalog (the "By CWE" view)
    if (parts[0] === 'cwe' && method === 'GET') return json(res, 200, { cwe: cweCatalog() }), true;
    // POST /api/patterns/import  { dir } → validate + import a custom pattern folder
    if (parts[0] === 'patterns' && parts[1] === 'import' && method === 'POST') return json(res, 200, importCustomFolder(body.dir || '')), true;

    // /api/projects
    if (parts[0] === 'projects' && parts.length === 1) {
      if (method === 'GET') return json(res, 200, { projects: await store.listProjects() }), true;
      if (method === 'POST') {
        try { return json(res, 201, await mgr.open(body)), true; }        // P1-1: bad path → 400, not a persisted junk project
        catch (e) { return json(res, 400, { error: e.message }), true; }
      }
    }

    // DELETE /api/projects/:id → forget a project (S2-7)
    if (parts[0] === 'projects' && parts.length === 2 && method === 'DELETE') {
      return json(res, 200, await store.deleteProject(parts[1])), true;
    }

    // /api/projects/:id/(findings|coverage|graph|memory|env)
    if (parts[0] === 'projects' && parts.length === 3 && method === 'GET') {
      const pid = parts[1], sub = parts[2];
      if (sub === 'findings') return json(res, 200, { findings: await store.listFindings(pid) }), true;
      if (sub === 'coverage') return json(res, 200, await computeCoverage(store, pid)), true;
      if (sub === 'graph') return json(res, 200, await readGraph(store, pid)), true;
      if (sub === 'memory') {
        const q = url.searchParams.get('q') || '';
        return json(res, 200, {
          stats: await stats(store, pid),
          learned: await listLearned(store, pid),
          recall: q ? await recall(store, pid, q) : null,
          cross: q ? await crossProjectRecall(store, q) : [],
        }), true;
      }
      // PHASE4 §4: never send the decrypted authHeader/extraHeaders to the browser on a read —
      // only what the UI needs to render state (baseUrl/scope/authorized) plus a boolean.
      if (sub === 'env') return json(res, 200, { target: redactTarget(await getTarget(store, pid)) }), true;
      // Phase A: coverage PROVEN (not estimated) — the reconciliation ledger's counts + every row
      // that did NOT land in a feature or shared infra, listed by name (an honest gap surface).
      if (sub === 'reconciliation') {
        const rows = await readReconciliation(store, pid);
        return json(res, 200, {
          counts: await reconciliationCounts(store, pid),
          gaps: rows.filter((r) => r.status !== 'MAPPED_TO_FEATURE' && r.status !== 'SHARED_INFRASTRUCTURE'),
        }), true;
      }
      // Phase A: model-free, fully-cited answer over the feature-context store. coverageGap:true
      // when nothing matches — never a guessed answer.
      if (sub === 'answer') return json(res, 200, await answer(store, pid, url.searchParams.get('q') || '')), true;
      // GET /api/projects/:id/inventory → the full heuristic inventory.jsonl from the current
      // snapshot, grouped by kind. Same graph/current.json → snapshot resolution as
      // packages/assess/src/decorate.js's loadManifest() — not a new pointer mechanism.
      if (sub === 'inventory') {
        let rows = [];
        try {
          const pointer = JSON.parse(await fsp.readFile(path.join(store.projectDir(pid), 'graph', 'current.json'), 'utf8'));
          const text = await fsp.readFile(path.join(store.projectDir(pid), 'snapshots', pointer.snapshotId, 'inventory.jsonl'), 'utf8');
          rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        } catch { /* not mapped yet — empty, not an error */ }
        const counts = {};
        for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
        return json(res, 200, { rows, counts }), true;
      }
    }

    // GET /api/projects/:id/features/:fid/context → the full per-feature dossier a future scan
    // consumes: endpoints/auth/data stores/roles + cited code excerpts + depth, wrapped with the
    // grounding preamble. ok:false (coverage gap) is a shaped 200 body, matching this file's
    // convention (findings/inventory degrade to empty rather than 404).
    if (parts[0] === 'projects' && parts.length === 5 && parts[2] === 'features' && parts[4] === 'context' && method === 'GET') {
      const fid = decodeURIComponent(parts[3]);
      return json(res, 200, await buildFeedForward(store, parts[1], fid)), true;
    }

    // GET /api/projects/:id/features/:fid/map → the rendered per-feature security map (markdown),
    // built from the same dossier /context already returns, plus the graph's trust-boundary/
    // shared-implementation edges. Additive sibling of /context — same coverage-gap convention.
    if (parts[0] === 'projects' && parts.length === 5 && parts[2] === 'features' && parts[4] === 'map' && method === 'GET') {
      const pid = parts[1], fid = decodeURIComponent(parts[3]);
      const [ctx, graph] = await Promise.all([buildFeedForward(store, pid, fid), readGraph(store, pid)]);
      const body = ctx.ok ? renderFeatureMap(ctx, graph) : `# Coverage gap\n\n${ctx.reason}\n`;
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(body);
      return true;
    }

    // GET /api/projects/:id/features-map → an index of every feature's map (markdown), read-only.
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'features-map' && method === 'GET') {
      const pid = parts[1];
      const graph = await readGraph(store, pid);
      const features = graph.nodes.filter((n) => n.type === 'FEATURE');
      const body = ['# Feature maps', '', ...features.map((f) => `- [${f.name}](./${encodeURIComponent(f.id)}/map)`)].join('\n');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(body);
      return true;
    }

    // GET /api/projects/:id/report?format=h1|md|json → whole-assessment report, read-only.
    // Additive, arranges ALREADY-persisted findings + coverage — see PHASE5-POLISH-DESIGN.md §2.2.
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'report' && method === 'GET') {
      const pid = parts[1];
      const proj = (await store.listProjects()).find((p) => p.id === pid);
      if (!proj) return json(res, 404, { error: 'no such project' }), true;
      const { contentType, body } = await buildReport(store, pid, url.searchParams.get('format'));
      const ext = contentType.includes('json') ? 'json' : 'md';
      res.writeHead(200, { 'content-type': contentType, 'content-disposition': `attachment; filename="secforge-report-${pid}.${ext}"` });
      res.end(body);
      return true;
    }

    // POST /api/projects/:id/map → run the mapping engine over the project's source. Mirrors
    // /scan's engine handling: a known-but-unreachable/non-LLM provider silently falls back to
    // 'rules' rather than being recorded as if it ran. Delegates the RUN to
    // runMapOrchestration (Phase D) so GET .../stream can forward live map-stage progress; a
    // project with no resolvable session runs mapProject() directly (no phase to record onto).
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'map' && method === 'POST') {
      const pid = parts[1];
      const proj = (await store.listProjects()).find((p) => p.id === pid);
      if (!proj) return json(res, 404, { error: 'no such project' }), true;

      let sid = url.searchParams.get('session') || null;
      if (!sid) {
        const active = (await store.listRuns(pid)).find((r) => r && ['created', 'running', 'paused'].includes(r.status));
        sid = active ? active.sessionId : null;
      }
      if (sid) {
        const cur = await mgr.status(pid, sid);
        if (cur && cur.status === 'paused') return json(res, 409, { error: 'session is paused — resume first' }), true;
      }

      const requested = await validEngineId(body.engine);
      let engine = 'rules';
      if (requested !== 'rules') {
        const conn = await checkConnection(requested);
        if (conn.connected && conn.analysis === 'llm') engine = requested;
      }
      const model = (engine === requested && typeof body.model === 'string') ? body.model : null;
      const effort = validEffort(body.effort);
      const incremental = typeof body.incremental === 'string' ? body.incremental : 'auto';

      const outcome = sid
        ? await runMapOrchestration({ store, mgr, projectId: pid, sessionId: sid, sourceRoot: proj.sourceRoot, engine, model, effort, incremental })
        : { ok: true, ...(await mapProject({ sourceRoot: proj.sourceRoot, store, projectId: pid, engine, model, effort })) };

      if (!outcome.ok) return json(res, 400, { status: 'ERROR', error: outcome.error }), true;
      const { ok, ...result } = outcome;
      return json(res, result.status === 'ERROR' ? 400 : 200, result), true;
    }

    // POST /api/projects/:id/memory/consolidate → on-demand dedup pass (no scheduler)
    if (parts[0] === 'projects' && parts.length === 4 && parts[2] === 'memory' && parts[3] === 'consolidate' && method === 'POST') {
      return json(res, 200, await consolidate(store, parts[1])), true;
    }

    // POST /api/projects/:id/feedback → record an accept/reject verdict on one finding
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'feedback' && method === 'POST') {
      const pid = parts[1];
      if (body.verdict !== 'accept' && body.verdict !== 'reject') {
        return json(res, 400, { error: "verdict must be 'accept' or 'reject'" }), true;
      }
      const finding = (await store.listFindings(pid)).find((f) => f.id === body.findingId);
      if (!finding) return json(res, 404, { error: 'no such finding' }), true;
      await recordVerdict(store, pid, {
        findingId: finding.id, rule: finding.rule, cwe: finding.cwe,
        feature: finding.feature, route: finding.route, verdict: body.verdict, note: body.note || null,
      });
      await store.writeFinding(pid, { ...finding, feedback: { verdict: body.verdict, at: new Date().toISOString() } });
      return json(res, 200, { ok: true, findingId: finding.id, verdict: body.verdict }), true;
    }

    // POST /api/projects/:id/(memory|env)
    if (parts[0] === 'projects' && parts.length === 3 && method === 'POST') {
      const pid = parts[1], sub = parts[2];
      if (sub === 'memory') return json(res, 200, await learn(store, pid, body)), true;
      if (sub === 'env') {
        // Redacted the same fields as GET's target (§4) — the client just sent this value, but
        // the response must not echo it back over the wire (response logs/proxies/browser
        // history). Stays a flat object (unlike GET's {target:...}) — index.html's
        // registerEnvTarget()/applyEnvTarget() already consume the POST response unwrapped.
        try { return json(res, 200, redactTarget(await registerTarget(store, pid, body))), true; } // P1-2: bad URL → 400
        catch (e) { return json(res, 400, { error: e.message }), true; }
      }
    }

    // /api/sessions/:id  (+ /pause /resume /cancel /scan)   ?project=<id>
    if (parts[0] === 'sessions' && parts[1]) {
      const sid = parts[1], action = parts[2];
      if (!project) return json(res, 400, { error: 'missing ?project=' }), true;
      // GET /api/sessions/:id/stream → SSE live progress of the REAL, persisting run (Phase D).
      // POST /map and POST /scan are still the only writers; this route only forwards what they
      // already emit onto the session's orchestration bus. First event is the session's current
      // phase (from mgr.status) so a client that connects mid-run, or reconnects after a reload,
      // sees where things stand immediately — session.phase on the record is the resumable source
      // of truth, the stream is just a live convenience on top of it.
      if (method === 'GET' && action === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
        let unsubscribe = null;
        const finish = () => {
          if (unsubscribe) { unsubscribe(); unsubscribe = null; }
          try { res.end(); } catch { /* already closed */ }
        };
        try {
          const cur = await mgr.status(project, sid);
          if (cur && cur.phase) send(cur.phase);
          unsubscribe = subscribePhase(sid, (evt) => {
            send(evt);
            if (evt && (evt.stage === 'done' || evt.stage === 'error')) finish();
          });
        } catch (err) {
          send({ stage: 'error', error: String((err && err.message) || err) });
          finish();
          return true;
        }
        req.on('close', finish);
        return true;
      }
      if (method === 'GET' && !action) return json(res, 200, await mgr.status(project, sid)), true;
      if (method === 'POST' && action === 'pause') return json(res, 200, await mgr.pause(project, sid)), true;
      if (method === 'POST' && action === 'resume') {
        const cur = await mgr.status(project, sid);
        if (!cur || cur.status !== 'paused') return json(res, 400, { error: 'can only resume a paused session' }), true;
        return json(res, 200, await mgr.resume(project, sid)), true;
      }
      if (method === 'POST' && action === 'cancel') return json(res, 200, await mgr.cancel(project, sid)), true;
      if (method === 'POST' && action === 'scan') {
        const bad = scopeInputError(body.scope);                            // S3-6: don't silently coerce an explicit bad scope
        if (bad) return json(res, 400, { error: `invalid scope.${bad}`, allowed: { mode: [...SCOPE_KINDS], method: [...RUN_METHODS] } }), true;
        const preStatus = await mgr.status(project, sid);
        if (preStatus && preStatus.status === 'paused') return json(res, 409, { error: 'session is paused — resume first' }), true; // refuse BEFORE the lock
        if (activeScans.has(project)) return json(res, 409, { error: 'a scan is already running for this project' }), true; // P0-2e
        activeScans.add(project);
        try {
          const requested = await validEngineId(body.engine);               // N1/N2: known adapter id only, coerced to a string
          // AI-2: a KNOWN-but-unreachable provider (or one whose analysis isn't wired) must not run
          // as itself and have the record claim it did. Fall back to rules and record the TRUTH.
          let engine = 'rules', reason = null;
          if (requested !== 'rules') {
            const conn = await checkConnection(requested);
            if (conn.connected && conn.analysis === 'llm') engine = requested;
            else reason = conn.connected ? 'analysis not wired' : 'not connected';
          }
          const model = (engine === requested && typeof body.model === 'string') ? body.model : null;
          const effort = validEffort(body.effort);                          // PHASE4 §2.2/§5: optional, defaults to 'medium'
          const scope = normaliseScope(body.scope);                         // input validation vs SCOPE_KINDS/RUN_METHODS
          const cur = await mgr.status(project, sid);
          if (cur && cur.status === 'created') await mgr.start(project, sid); // N3: drive the FSM so status is real + pause works
          await mgr.configureRun(project, sid, scope);
          await mgr.recordEngine(project, sid, { provider: engine, model, requested, reason, effort }); // N4 + AI-2: never record an engine that didn't run
          await store.clearFindings(project);                               // N5: a re-scan replaces findings; no stale results survive
          // Phase D: a single-feature scan delegates to runScanOrchestration, which records
          // session.phase + emits live bus events for GET .../stream, then internally runs
          // runAssessment (never reimplemented). A whole-project/multi-feature scan has no single
          // featureId to ground buildFeedForward's pre-flight on, so it keeps calling
          // runAssessment directly — unchanged behavior, no live phase for that run shape.
          const featureId = scope.mode === 'feature' && scope.feature ? scope.feature : null;
          const outcome = featureId
            ? await runScanOrchestration({ store, mgr, projectId: project, sessionId: sid, featureId, scope, engine, model, effort })
            : { ok: true, ...(await runAssessment({ store, projectId: project, scope, engine, model, effort })) };
          if (!outcome.ok) return json(res, outcome.gap ? 404 : 502, { error: outcome.error }), true;
          const { ok, ...result } = outcome;
          // Phase 3: re-surface (never hide) any finding matching a prior accept/reject verdict,
          // then mine this scan's validated findings into the learned-patterns catalog. Both are
          // additive to the existing scan response shape.
          const priorFeedbackFlagged = await annotatePriorFeedback(store, project, result.findings);
          const flaggedFindings = result.findings.filter((f) => f.priorFeedback);
          for (const f of flaggedFindings) await store.writeFinding(project, f); // persist the badge so GET /findings shows it too
          const mined = await minePatterns(store, project, result.findings);
          // Phase 5 §1c: "scheduled consolidation" without a scheduler — tidy learned-patterns.md/
          // feedback.jsonl right after the thing that dirties them. Never fails the scan.
          await consolidate(store, project).catch(() => {});
          return json(res, 200, { ...result, modelUsed: model, effort, requested, reason, mined, priorFeedbackFlagged }), true; // AI-5: report what actually ran
        } finally {
          activeScans.delete(project);
        }
      }
    }

    // POST /api/findings/:id/validate?project=<pid> → guarded dynamic validation (static-only by default)
    if (parts[0] === 'findings' && parts[1] && parts[2] === 'validate' && method === 'POST') {
      if (!project) return json(res, 400, { error: 'missing ?project=' }), true;
      const fid = decodeURIComponent(parts[1]);
      const finding = (await store.listFindings(project)).find((f) => f.id === fid || f.id.endsWith(fid));
      if (!finding) return json(res, 404, { error: 'no such finding' }), true;
      return json(res, 200, await validateFinding(store, project, finding, { dryRun: body.dryRun !== false })), true;
    }

    return json(res, 404, { error: 'no such route', path: url.pathname }), true;
  } catch (e) {
    // If a response (e.g. an SSE stream) already started, a second writeHead would throw again
    // inside the catch and escape uncaught. Just close it. P0-2a.
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return true; }
    return json(res, 500, { error: e.message }), true;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve({});
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
