// @secforge/store — the durable project store. THE source of truth.
// Skeleton uses human-readable files + an append-only event log. The SQLite knowledge
// graph (index.sqlite via node:sqlite) lands in Phase 1; the layout below already reserves it.
// ponytail: files + JSONL now; add the sqlite graph when the map engine needs it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ID } from '@secforge/schemas';

// Data root (never the source tree). Override with SECFORGE_DATA.
export const DATA_ROOT = process.env.SECFORGE_DATA || path.join(os.homedir(), '.secforge', 'projects');

const projectId = (sourceRoot) =>
  'p_' + crypto.createHash('sha256').update(path.resolve(sourceRoot)).digest('hex').slice(0, 12);

async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file); // atomic
}

export class Store {
  constructor(root = DATA_ROOT) { this.root = root; }

  projectDir(id) { return path.join(this.root, id); }

  // Resolve or create a project for a source tree. Idempotent by source path.
  async openProject({ sourceRoot, name }) {
    if (!sourceRoot || typeof sourceRoot !== 'string') throw new Error('sourceRoot is required');
    const abs = path.resolve(sourceRoot);
    // Optional confinement for hardened / multi-user deployments: SECFORGE_ALLOW_ROOT limits
    // which trees may be opened+scanned, mitigating arbitrary-path reads via the HTTP API.
    const allow = process.env.SECFORGE_ALLOW_ROOT;
    if (allow) {
      const root = path.resolve(allow);
      if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('source path is outside SECFORGE_ALLOW_ROOT');
    }
    const id = projectId(abs);
    const dir = this.projectDir(id);
    const file = path.join(dir, 'project.json');
    let project = await readJSON(file);
    if (!project) {
      project = { id, name: name || path.basename(abs), sourceRoot: abs, createdAt: new Date().toISOString() };
      await writeJSON(file, project);
      await this.appendEvent(id, { type: 'project.created', project: id });
    }
    return project;
  }

  async listProjects() {
    try {
      const ids = await fs.readdir(this.root);
      const out = [];
      for (const id of ids) {
        const p = await readJSON(path.join(this.projectDir(id), 'project.json'));
        if (p) out.push(p);
      }
      return out;
    } catch { return []; }
  }

  // --- session run records (the durable session state) ---
  runFile(projectIdVal, sessionId) { return path.join(this.projectDir(projectIdVal), 'assess', 'runs', `${sessionId}.json`); }

  async writeRun(projectIdVal, run) { await writeJSON(this.runFile(projectIdVal, run.sessionId), run); return run; }
  async readRun(projectIdVal, sessionId) { return readJSON(this.runFile(projectIdVal, sessionId)); }

  async listRuns(projectIdVal) {
    const dir = path.join(this.projectDir(projectIdVal), 'assess', 'runs');
    try {
      const files = await fs.readdir(dir);
      return Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(dir, f))));
    } catch { return []; }
  }

  // --- append-only event log: nothing is ever silently dropped ---
  async appendEvent(projectIdVal, event) {
    const file = path.join(this.projectDir(projectIdVal), 'events.log');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  }

  // --- findings (per-finding folder; graph node id parallels it) ---
  async writeFinding(projectIdVal, finding) {
    const dir = path.join(this.projectDir(projectIdVal), 'assess', 'findings', finding.id.replace('finding:', ''));
    await writeJSON(path.join(dir, 'finding.json'), finding);
    await this.appendEvent(projectIdVal, { type: 'finding.written', finding: finding.id });
    return finding;
  }
  async listFindings(projectIdVal) {
    const dir = path.join(this.projectDir(projectIdVal), 'assess', 'findings');
    try {
      const names = await fs.readdir(dir);
      return Promise.all(names.map((n) => readJSON(path.join(dir, n, 'finding.json')))).then((a) => a.filter(Boolean));
    } catch { return []; }
  }
}

export { projectId, ID };
// Graph layer (nodes/edges/claims) — re-exported so consumers reach it via @secforge/store.
export { writeNodes, writeEdges, readGraph, neighbourhood } from './graph.js';
