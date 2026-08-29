// @secforge/memory — self-contained recall over the store. Files are the source of truth;
// an optional embedded vector index (sqlite-vec) accelerates recall in a later phase.
// This skeleton does keyword recall over learned patterns + feedback so the Memory tab works.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '@secforge/store';

function memDir(store, projectId) { return path.join(store.projectDir(projectId), 'memory'); }

export async function record(store, projectId, entry) {
  const file = path.join(memDir(store, projectId), 'feedback.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// Keyword recall across this project's learned patterns + feedback. Cross-project recall
// (search every project) and vector ranking land with sqlite-vec later.
export async function recall(store, projectId, query) {
  const q = String(query || '').toLowerCase();
  const file = path.join(memDir(store, projectId), 'learned-patterns.md');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { /* none yet */ }
  const hits = text.split('\n').filter((line) => q && line.toLowerCase().includes(q));
  return { query, hits, note: 'keyword recall — vector index (sqlite-vec) added later' };
}

const LEARN_KINDS = Object.freeze(['pattern', 'guard', 'note']);

// Append a learned pattern/guard/note to this project's learned-patterns.md AND record a
// feedback entry, so it shows up in both recall() (keyword search) and the feedback log.
export async function learn(store, projectId, { name, kind, note, family }) {
  if (!name) throw new Error('learn(): name is required');
  if (!LEARN_KINDS.includes(kind)) throw new Error(`learn(): kind must be one of ${LEARN_KINDS.join(', ')}`);
  const file = path.join(memDir(store, projectId), 'learned-patterns.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const line = `- **${name}** [${kind}]${family ? ` (${family})` : ''}${note ? ` — ${note}` : ''}\n`;
  await fs.appendFile(file, line);
  await record(store, projectId, { type: 'learned', name, kind, note, family });
  return { name, kind, note: note || null, family: family || null };
}

// Keyword recall across EVERY project's learned-patterns.md — backs the Memory tab's
// "surfaced from another project". Returns [{project, hit}] for each matching line.
export async function crossProjectRecall(store, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const projects = await store.listProjects();
  const results = [];
  for (const project of projects) {
    const file = path.join(memDir(store, project.id), 'learned-patterns.md');
    let text = '';
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.toLowerCase().includes(q)) results.push({ project: project.id, hit: line });
    }
  }
  return results;
}

async function countLines(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

// { patterns, feedbackSignals, projects } counts for the Memory tab stat row.
export async function stats(store, projectId) {
  const patterns = await countLines(path.join(memDir(store, projectId), 'learned-patterns.md'));
  const feedbackSignals = await countLines(path.join(memDir(store, projectId), 'feedback.jsonl'));
  const projects = (await store.listProjects()).length;
  return { patterns, feedbackSignals, projects };
}

export { Store };
