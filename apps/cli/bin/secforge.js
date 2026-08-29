#!/usr/bin/env node
// secforge — CLI entry. open | ls | status | resume | pause | cancel | doctor | serve
import path from 'node:path';
import process from 'node:process';
import { SessionManager } from '@secforge/session';
import { Store, DATA_ROOT } from '@secforge/store';

const mgr = new SessionManager();
const [cmd, ...args] = process.argv.slice(2);

function out(o) { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); }

const commands = {
  async open(p) {
    if (!p) throw new Error('usage: secforge open <source-path>');
    const { project, session, resumed } = await mgr.open({ sourceRoot: path.resolve(p) });
    out(`${resumed ? 'Resumed' : 'Opened'} ${project.name} (${project.id})`);
    out(`  session ${session.sessionId} · status ${session.status}`);
    out(`  store   ${new Store().projectDir(project.id)}`);
  },
  async ls() {
    const projects = await new Store().listProjects();
    if (!projects.length) return out('no projects yet — `secforge open <path>`');
    for (const p of projects) out(`${p.id}  ${p.name}  (${p.sourceRoot})`);
  },
  async status(pid, sid) {
    if (!pid || !sid) throw new Error('usage: secforge status <projectId> <sessionId>');
    out(await mgr.status(pid, sid));
  },
  async resume(pid, sid) { out(await mgr.resume(pid, sid)); },
  async pause(pid, sid) { out(await mgr.pause(pid, sid)); },
  async cancel(pid, sid) { out(await mgr.cancel(pid, sid)); },
  async doctor() {
    out('SecForge doctor');
    out(`  node        ${process.version} (need >=22)  ${parseInt(process.versions.node) >= 22 ? 'OK' : 'FAIL'}`);
    out(`  data root   ${DATA_ROOT}`);
    try { await new Store().listProjects(); out('  store       reachable  OK'); }
    catch (e) { out(`  store       ERROR ${e.message}`); }
  },
  async serve() { await import('@secforge/server'); },
};

(async () => {
  try {
    const fn = commands[cmd];
    if (!fn) { out(`SecForge CLI\n  commands: ${Object.keys(commands).join(', ')}`); process.exit(cmd ? 1 : 0); }
    await fn(...args);
  } catch (e) { console.error('error:', e.message); process.exit(1); }
})();
