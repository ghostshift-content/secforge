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

export { Store };
