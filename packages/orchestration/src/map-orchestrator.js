// @secforge/orchestration/map-orchestrator — sequences @secforge/map's mapProject() for one
// session, recording session.phase and emitting live bus events as it runs, and supplying the
// `onClusters` hook that fixes the flat "Core" lump (design doc §2): a generic/lumped cluster is
// handed to the adapter for a grounded, mechanically-verified partition into named sub-features.
// Fail-closed throughout — a bad/garbage/failed adapter response never fabricates a row or a
// feature, it only ever falls back to the ORIGINAL cluster unchanged.
import { mapProject } from '@secforge/map';
import { getAdapter } from '@secforge/adapters';
import { runAll } from '@secforge/orchestrator';
import * as bus from './bus.js';

const LUMP_ROW_THRESHOLD = 40; // design doc §2's own example threshold
const GENERIC_DOMAINS = new Set(['core']); // semantic-planner's own generic fallback domain

const localityOf = (file) => String(file || '').split('/').filter(Boolean).slice(0, 2).join('/') || 'root';

// A cluster is "lumped" once it's both big and spans many distinct file localities/nouns — the
// exact shape of the flat-Rails "Core" problem described in the design doc, never a small,
// already-coherent cluster.
export function isLumpedCluster(cluster, threshold = LUMP_ROW_THRESHOLD) {
  const rows = cluster?.rows || [];
  if (rows.length <= threshold) return false;
  const localities = new Set(rows.map(({ row }) => localityOf(row?.file)));
  return GENERIC_DOMAINS.has(cluster.domain) || localities.size >= 4;
}

const rowKey = (r) => `${r?.file || ''}::${r?.line ?? ''}::${r?.entry || ''}`;

function buildConsolidationPrompt(cluster) {
  const rows = (cluster.rows || []).map(({ kind, row }) => ({ kind, file: row?.file, line: row?.line ?? null, entry: String(row?.entry || '') }));
  return `You are splitting one overly-broad code cluster into coherent, named sub-features.

You cannot read files, run tools, or ask a follow-up question. You may ONLY reference rows from the
list below, copying their "file", "line" and "entry" fields back VERBATIM — never invent a row, a
file path, a line number, or an entry that isn't shown to you.

Cluster "${cluster.name}" (domain: ${cluster.domain}) currently lumps together ${rows.length} rows
spanning many distinct localities/nouns. Propose short, named sub-clusters that partition these rows
into coherent capabilities. Every row may be assigned to at most one sub-cluster; leave a row out
entirely if it doesn't fit any coherent group — never force it in.

Respond with ONLY a single JSON object (no prose, no markdown fences) of this exact shape:
{ "subclusters": [ { "name": "string", "slug": "string", "rows": [ { "file": "string", "line": 1, "entry": "string" } ] } ] }

ROWS (${rows.length}):
${JSON.stringify(rows)}`;
}

function stripFences(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1] : s;
}

function parseConsolidationResponse(text) {
  try {
    const parsed = JSON.parse(stripFences(text));
    return Array.isArray(parsed?.subclusters) ? parsed.subclusters : null;
  } catch { return null; }
}

const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Mechanically verify + apply one adapter proposal against `cluster`'s OWN rows. Returns
// { clusters, split } — `split:false` means "use the original cluster unchanged" (the fail-closed
// path for garbage/empty/all-invalid proposals); `split:true` means at least one grounded named
// sub-cluster was carved out (any leftover rows land in a fallback "(other)" cluster, never lost).
function applyProposal(cluster, proposed) {
  const byKey = new Map((cluster.rows || []).map((r) => [rowKey(r.row), r]));
  const claimed = new Set();
  const subclusters = [];

  for (const p of proposed) {
    const name = String(p?.name || '').trim();
    const slug = slugify(p?.slug) || slugify(name);
    if (!name || !slug || !Array.isArray(p.rows)) continue;
    const kept = [];
    for (const claim of p.rows) {
      const key = rowKey(claim);
      const original = byKey.get(key); // mechanical membership check — EXACT match or dropped
      if (!original || claimed.has(key)) continue;
      claimed.add(key);
      kept.push(original);
    }
    if (kept.length) {
      subclusters.push({ domain: cluster.domain, slug: `${cluster.slug}-${slug}`, name, rows: kept, confidence: 'low', planning_method: 'ai-consolidated' });
    }
  }
  if (!subclusters.length) return { clusters: [cluster], split: false };

  const leftover = (cluster.rows || []).filter((r) => !claimed.has(rowKey(r.row)));
  const clusters = leftover.length
    ? [...subclusters, { ...cluster, name: `${cluster.name} (other)`, rows: leftover, planning_method: 'ai-consolidated-leftover' }]
    : subclusters;
  return { clusters, split: true };
}

async function consolidateOne(cluster, adapter, { model, effort } = {}) {
  let text;
  try { text = await adapter.ask(buildConsolidationPrompt(cluster), { model, effort }); }
  catch { return { clusters: [cluster], split: false }; } // adapter threw -> original cluster preserved
  const proposed = parseConsolidationResponse(text);
  if (!proposed || !proposed.length) return { clusters: [cluster], split: false }; // garbage/empty -> original preserved
  return applyProposal(cluster, proposed);
}

// Build the `onClusters(rawClusters, {engine,model,effort}) -> clusters` hook mapProject() calls
// right after clustering (map/src/index.js). Non-lumped clusters pass through untouched; lumped
// ones are fanned out to the adapter via runAll (bounded concurrency). `stats.consolidated` is
// mutated in place so the caller can read the split count after mapProject resolves.
export function makeConsolidator(stats, { concurrency = 4 } = {}) {
  return async function onClusters(rawClusters, { engine, model, effort } = {}) {
    const adapter = getAdapter(engine);
    // An agentic engine's Lead reads the snapshot and merges/splits clusters itself (recon/lead.js);
    // a one-shot pre-split here would only spend a long call on work the Lead redoes with more context.
    if (adapter && adapter.agentic) return rawClusters;
    const lumped = (rawClusters || []).filter((c) => isLumpedCluster(c));
    if (!lumped.length || !adapter) return rawClusters;

    const results = await runAll(lumped, (cluster) => consolidateOne(cluster, adapter, { model, effort }), { concurrency });
    const outcomeByCluster = new Map(results.map((r) => [r.job, r.result])); // keyed by object identity, order-safe

    const out = [];
    for (const c of rawClusters) {
      const outcome = outcomeByCluster.get(c);
      if (!outcome || !outcome.split) { out.push(c); continue; }
      stats.consolidated += 1;
      out.push(...outcome.clusters);
    }
    return out;
  };
}

const now = () => new Date().toISOString();

/**
 * Run one map phase for a session: records session.phase as mapProject progresses and emits the
 * same events onto the session's live bus. Never throws — a failure is recorded as an honest
 * `phase.stage==='error'` and returned as `{ok:false, error}`; session.status is left untouched.
 */
export async function runMapOrchestration({ store, mgr, projectId, sessionId, sourceRoot, engine = 'rules', model = null, effort = 'medium', incremental = 'auto' } = {}) {
  await mgr.recordPhase(projectId, sessionId, { name: 'map', stage: 'profiling', pct: 0, feature: null, error: null, result: null, startedAt: now() });
  bus.emit(sessionId, { name: 'map', stage: 'profiling', pct: 0 });

  // recordPhase is read-modify-write; onProgress fires synchronously in phase order but must not
  // race its own writes (an earlier phase's write completing AFTER a later one would clobber it) —
  // chain every call so they land in issue order, and the final done/error write waits for all of them.
  let chain = Promise.resolve();
  const recordSequential = (patch) => { chain = chain.then(() => mgr.recordPhase(projectId, sessionId, patch)).catch(() => {}); return chain; };

  const stats = { consolidated: 0 };
  const onClusters = makeConsolidator(stats);
  // Lead events (mapProject's `lead` field on a 'semantic' progress tick) become a human label on the
  // phase record + the live stream, so the UI can show "Lead reading the snapshot" instead of a bare %.
  const leadLabel = (e) => {
    if (!e) return null;
    switch (e.kind) {
      case 'lead_started': return e.label || 'Lead reading the snapshot';
      case 'lead_workstreams': return e.label;
      case 'lead_workstream_done': return `Lead workstream ${e.done}/${e.total}${e.resumed ? ' (resumed)' : ''}`;
      case 'lead_planned': return `Lead derived ${e.features} feature(s)${e.turns != null ? ` in ${e.turns} turns` : ''}`;
      case 'lead_validated': return `evidence-validated: ${e.accepted?.features ?? 0} features · ${e.accepted?.roles ?? 0} roles · ${e.rejected} rejected`;
      case 'lead_failed': return `Lead failed: ${e.error}`;
      case 'lead_unparsed': return 'Lead reply was not a usable plan';
      default: return null;
    }
  };
  const onProgress = ({ phase, pct, lead }) => {
    const label = leadLabel(lead);
    recordSequential(label ? { stage: phase, pct, label } : { stage: phase, pct }); // best-effort, order-preserving; never blocks mapProject
    bus.emit(sessionId, label ? { name: 'map', stage: phase, pct, label } : { name: 'map', stage: phase, pct });
  };

  try {
    const result = await mapProject({ sourceRoot, store, projectId, engine, model, effort, incremental, onClusters, onProgress });
    if (result.status !== 'MAPPED') {
      await recordSequential({ stage: 'error', error: result.error || 'map failed' });
      bus.emit(sessionId, { name: 'map', stage: 'error', error: result.error });
      return { ok: false, error: result.error || 'map failed' };
    }
    const summary = {
      features: result.features.length, coverage: result.coverage, nodeCount: result.nodeCount,
      incremental: result.incremental, aiSemantic: result.aiSemantic, consolidated: stats.consolidated, lead: result.lead || null,
    };
    await recordSequential({ stage: 'done', pct: 100, result: summary });
    bus.emit(sessionId, { name: 'map', stage: 'done', pct: 100, result: summary });
    return { ok: true, ...result, consolidated: stats.consolidated };
  } catch (err) {
    const error = String(err?.message || err);
    await recordSequential({ stage: 'error', error });
    bus.emit(sessionId, { name: 'map', stage: 'error', error });
    return { ok: false, error };
  }
}
