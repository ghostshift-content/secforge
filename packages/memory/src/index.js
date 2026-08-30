// @secforge/memory — self-contained recall over the store. Files are the source of truth;
// an optional embedded vector index (sqlite-vec) accelerates recall in a later phase.
// This skeleton does keyword recall over learned patterns + feedback so the Memory tab works.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store } from '@secforge/store';

function memDir(store, projectId) { return path.join(store.projectDir(projectId), 'memory'); }

// Per-project lock (module-level; a single Node process is all this self-contained tool ever
// runs) serialising writers of feedback.jsonl. consolidate() does a non-atomic read-modify-write
// on that file; without this, a concurrent record() (e.g. POST /feedback) landing between
// consolidate's read and its write gets silently clobbered when consolidate flushes its own
// (now-stale) snapshot. record() and consolidate() never call each other, so this never nests.
const locks = new Map();
function withLock(projectId, fn) {
  const tail = (locks.get(projectId) || Promise.resolve()).then(fn, fn);
  locks.set(projectId, tail.catch(() => {})); // keep the chain alive even if this task rejected
  return tail;
}

export async function record(store, projectId, entry) {
  return withLock(projectId, async () => {
    const file = path.join(memDir(store, projectId), 'feedback.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  });
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

async function readFeedbackEntries(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// { patterns, feedbackSignals, accepted, rejected, projects } counts for the Memory tab stat
// row. feedbackSignals/accepted/rejected count ONLY real 'finding.verdict' entries — feedback.jsonl
// also carries 'learned' mirror entries from learn(), which are not accept/reject verdicts and
// must never be counted as one (that was the pre-existing mislabeling this fixes).
export async function stats(store, projectId) {
  const patterns = await countLines(path.join(memDir(store, projectId), 'learned-patterns.md'));
  const entries = await readFeedbackEntries(path.join(memDir(store, projectId), 'feedback.jsonl'));
  let accepted = 0, rejected = 0;
  for (const e of entries) {
    if (e.type !== 'finding.verdict') continue;
    if (e.verdict === 'accept') accepted++;
    else if (e.verdict === 'reject') rejected++;
  }
  const projects = (await store.listProjects()).length;
  return { patterns, feedbackSignals: accepted + rejected, accepted, rejected, projects };
}

// The real accept/reject verdicts a caller may record against one finding. Validated here (not
// just at the route layer) so every producer of a verdict — route, script, test — gets the same
// guard; no silent coercion of an invalid verdict.
const VERDICTS = Object.freeze(['accept', 'reject']);

export async function recordVerdict(store, projectId, { findingId, rule, cwe, feature, route, verdict, note = null }) {
  if (!VERDICTS.includes(verdict)) throw new Error(`recordVerdict(): verdict must be one of ${VERDICTS.join(', ')}`);
  await record(store, projectId, { type: 'finding.verdict', findingId, rule, cwe, feature, route, verdict, note });
  return { findingId, verdict };
}

// Re-surface (never hide) any finding whose rule::route shape matches a prior accept/reject
// verdict for this project. Mutates each matching finding with an additive `priorFeedback`
// field and returns how many were flagged. Called after every scan.
export async function annotatePriorFeedback(store, projectId, findings) {
  const file = path.join(memDir(store, projectId), 'feedback.jsonl');
  const entries = await readFeedbackEntries(file);
  const latestByKey = new Map(); // "rule::route" -> latest finding.verdict entry
  for (const e of entries) {
    if (e.type !== 'finding.verdict') continue;
    const key = `${e.rule}::${e.route || ''}`;
    const prev = latestByKey.get(key);
    if (!prev || e.at >= prev.at) latestByKey.set(key, e); // ISO strings sort lexically = chronologically
  }
  let flagged = 0;
  for (const f of findings) {
    const prior = latestByKey.get(`${f.rule}::${f.route || ''}`);
    if (prior) { f.priorFeedback = { verdict: prior.verdict, at: prior.at, findingId: prior.findingId }; flagged++; }
  }
  return flagged;
}

// Deterministic, cited pattern mining: group this scan's validated findings by rule, and for
// each rule not already in this project's learned-patterns.md, append ONE real entry via the
// existing learn() writer — no new format, no NLP, no invented text. Dedup is an exact
// substring check on an embedded `rule=<id>` marker (monotonic growth, no duplicates).
export async function minePatterns(store, projectId, findings) {
  const file = path.join(memDir(store, projectId), 'learned-patterns.md');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { /* none yet */ }
  const firstByRule = new Map();
  for (const f of findings) {
    if (f.rule && !firstByRule.has(f.rule)) firstByRule.set(f.rule, f);
  }
  const added = [];
  for (const [rule, f] of firstByRule) {
    const marker = `rule=${rule}`;
    if (text.includes(marker)) continue; // already mined for this project
    const loc = f.evidence?.file ? `${f.evidence.file}${f.evidence.line ? ':' + f.evidence.line : ''}` : 'no evidence';
    const note = `mined from ${f.id}; ${loc}; ${marker}`;
    const entry = await learn(store, projectId, { name: f.title, kind: 'pattern', note, family: f.family });
    text += marker; // keep the in-memory guard in sync within this single call
    added.push(entry);
  }
  return added;
}

// Parse learned-patterns.md's existing `- **name** [kind] (family) — note` lines back into
// objects, so the Memory tab can render the real catalog. Degrades to [] if the file doesn't
// exist yet — same convention as the rest of this module.
const LEARNED_LINE_RE = /^- \*\*(.+)\*\* \[(\w+)\](?: \(([^)]*)\))?(?: — (.*))?$/;

export async function listLearned(store, projectId) {
  const file = path.join(memDir(store, projectId), 'learned-patterns.md');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(LEARNED_LINE_RE);
    if (!m) continue;
    out.push({ title: m[1], name: m[1], kind: m[2], family: m[3] || null, note: m[4] || null });
  }
  return out;
}

// On-demand consolidation (no scheduler, no age-based pruning): exact-duplicate-line collapse
// on learned-patterns.md, and latest-verdict-per-key collapse on feedback.jsonl's
// 'finding.verdict' entries only ('learned' mirror entries are left untouched).
export async function consolidate(store, projectId) {
  const dir = memDir(store, projectId);
  const lpFile = path.join(dir, 'learned-patterns.md');
  const fbFile = path.join(dir, 'feedback.jsonl');

  let lpBefore = 0, lpAfter = 0;
  try {
    const lines = (await fs.readFile(lpFile, 'utf8')).split('\n').filter(Boolean);
    lpBefore = lines.length;
    const deduped = [...new Set(lines)]; // exact-match only
    lpAfter = deduped.length;
    if (lpAfter !== lpBefore) await fs.writeFile(lpFile, deduped.join('\n') + '\n');
  } catch { /* nothing to consolidate */ }

  // Locked: this read-modify-write must not interleave with a concurrent record() append (a
  // POST /feedback arriving mid-consolidate would otherwise be overwritten by the stale snapshot
  // this reads below).
  let fbBefore = 0, fbAfter = 0;
  await withLock(projectId, async () => {
    try {
      const entries = await readFeedbackEntries(fbFile);
      fbBefore = entries.length;
      const latestByKey = new Map();
      const kept = [];
      for (const e of entries) {
        if (e.type !== 'finding.verdict') { kept.push(e); continue; }
        const key = `${e.rule}::${e.route || ''}`;
        latestByKey.set(key, e); // last write wins — entries are already in file order (chronological)
      }
      for (const e of latestByKey.values()) kept.push(e);
      fbAfter = kept.length;
      if (fbAfter !== fbBefore) {
        await fs.writeFile(fbFile, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch { /* nothing to consolidate */ }
  });

  return { learnedPatterns: { before: lpBefore, after: lpAfter }, feedback: { before: fbBefore, after: fbAfter } };
}

export { Store };
