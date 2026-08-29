// @secforge/server routes — the API map the UI is wired to. Every UI action → a route → a package.
// See docs/WIRING.md. Handlers are real where the skeleton allows (sessions, store) and shaped
// stubs where a Phase engine lands later (map, assess). Nothing 500s.

import { SessionManager } from '@secforge/session';
import { Store, readGraph } from '@secforge/store';
import { runAssessment, computeCoverage } from '@secforge/assess';
import { FAMILIES, loadCanonicalCards, cweCatalog, importCustomFolder } from '@secforge/patterns';
import { mapProject } from '@secforge/map';
import { learn, recall, crossProjectRecall, stats } from '@secforge/memory';
import { registerTarget, getTarget, validateFinding } from '@secforge/env';
import { listEngines } from '@secforge/adapters';

const mgr = new SessionManager();
const store = new Store();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

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

    // /api/engines → available model engines (drives the UI model selector); returns a bare array
    if (parts[0] === 'engines' && method === 'GET') return json(res, 200, await listEngines()), true;

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
      if (method === 'POST') { const r = await mgr.open(body); return json(res, 201, r), true; }
    }

    // /api/projects/:id/(findings|coverage|graph|memory|env)
    if (parts[0] === 'projects' && parts.length === 3 && method === 'GET') {
      const pid = parts[1], sub = parts[2];
      if (sub === 'findings') return json(res, 200, { findings: await store.listFindings(pid) }), true;
      if (sub === 'coverage') return json(res, 200, await computeCoverage(store, pid)), true;
      if (sub === 'graph') return json(res, 200, await readGraph(store, pid)), true;
      if (sub === 'memory') {
        const q = url.searchParams.get('q') || '';
        return json(res, 200, { stats: await stats(store, pid), recall: q ? await recall(store, pid, q) : null, cross: q ? await crossProjectRecall(store, q) : [] }), true;
      }
      if (sub === 'env') return json(res, 200, { target: await getTarget(store, pid) }), true;
    }

    // POST /api/projects/:id/map → run the mapping engine over the project's source
    if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'map' && method === 'POST') {
      const pid = parts[1];
      const proj = (await store.listProjects()).find((p) => p.id === pid);
      if (!proj) return json(res, 404, { error: 'no such project' }), true;
      const result = await mapProject({ sourceRoot: proj.sourceRoot, store, projectId: pid });
      return json(res, 200, result), true;
    }

    // POST /api/projects/:id/(memory|env)
    if (parts[0] === 'projects' && parts.length === 3 && method === 'POST') {
      const pid = parts[1], sub = parts[2];
      if (sub === 'memory') return json(res, 200, await learn(store, pid, body)), true;
      if (sub === 'env') return json(res, 200, await registerTarget(store, pid, body)), true;
    }

    // /api/sessions/:id  (+ /pause /resume /cancel /scan)   ?project=<id>
    if (parts[0] === 'sessions' && parts[1]) {
      const sid = parts[1], action = parts[2];
      if (!project) return json(res, 400, { error: 'missing ?project=' }), true;
      if (method === 'GET' && !action) return json(res, 200, await mgr.status(project, sid)), true;
      if (method === 'POST' && action === 'pause') return json(res, 200, await mgr.pause(project, sid)), true;
      if (method === 'POST' && action === 'resume') return json(res, 200, await mgr.resume(project, sid)), true;
      if (method === 'POST' && action === 'cancel') return json(res, 200, await mgr.cancel(project, sid)), true;
      if (method === 'POST' && action === 'scan') {
        await mgr.configureRun(project, sid, body.scope || {});
        const result = await runAssessment({ store, projectId: project, scope: body.scope || {}, engine: body.engine });
        return json(res, 200, result), true;
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
    return json(res, 500, { error: e.message }), true;
  }
}

function coverageStub() {
  return {
    percent: 0,
    families: FAMILIES.map((f) => ({ family: f.name, prefix: f.prefix, cwe: f.cwe, state: 'not-run' })),
    note: 'coverage computed by the assess engine in Phase 2',
  };
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
