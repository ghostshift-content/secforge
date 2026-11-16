// @secforge/recon/lead — the agentic mapping Lead. When the selected engine can EXPLORE (read-only
// Read/Glob/Grep over a directory, see @secforge/adapters `explore`), the Lead reads the FROZEN
// snapshot itself — bounded by a turn cap derived from effort — and returns a repository-specific
// ontology (features/actors/roles/permissions with file:line evidence) that evidence-validator.js
// then proves against that same snapshot. Engines without `explore` (ollama/openai/anthropic/fakes)
// fall back to the one-shot planClusters() path unchanged. Zero deps; the adapter is injected.
import { runAll } from '@secforge/orchestrator';
import fs from 'node:fs';
import path from 'node:path';
import { summarizeClusters, chunkClusters, mergeReconPlans, planClusters } from './ai-semantic.js';
import { makeEvidenceVerifier, validateOntology } from './evidence-validator.js';
import { METHODOLOGY } from './lead-methodology.js';

// Effort's real effect on the Lead: how many agent turns it may spend reading the snapshot.
export const LEAD_TURNS = Object.freeze({ low: 16, medium: 28, high: 40, max: 60 });
export const leadTurns = (effort) => LEAD_TURNS[effort] || LEAD_TURNS.medium;
// One Lead session gets the whole cluster summary while it fits; past this, bounded workstreams.
const HOLISTIC_SUMMARY_BYTES = Math.max(20_000, Number(process.env.SECFORGE_LEAD_SUMMARY_BYTES) || 180_000);
const WORKSTREAM_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.SECFORGE_LEAD_CONCURRENCY) || 3));

const evidenceItem = { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, symbol: { type: 'string' }, reason: { type: 'string' } }, required: ['file'] };
const strList = { type: 'array', items: { type: 'string' } };
// The structured-output contract the engine must satisfy (same shape as ai-semantic's RESPONSE_SHAPE).
export const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    features: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, slug: { type: 'string' }, domain: { type: 'string' }, purpose: { type: 'string' },
      include_paths: strList, include_terms: strList, include_symbols: strList, include_entries: strList, inventory_keys: strList,
      exclude_paths: strList, exclude_terms: strList, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      actors: strList, permissions: strList, evidence: { type: 'array', items: evidenceItem },
    }, required: ['name', 'slug', 'domain', 'purpose', 'evidence'] } },
    actors: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, kind: { type: 'string', enum: ['human', 'token', 'service', 'system', 'integration'] }, obtained_via: { type: 'string' },
      scopes: strList, hierarchical: { type: 'boolean' }, evidence: { type: 'array', items: evidenceItem },
    }, required: ['name', 'kind', 'evidence'] } },
    roles: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' }, scope: { type: 'string' }, obtained_via: { type: 'string' },
      hierarchical: { type: 'boolean' }, enables: strList, evidence: { type: 'array', items: evidenceItem },
    }, required: ['name', 'evidence'] } },
    permissions: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' }, resource: { type: 'string' }, operation: { type: 'string' },
      enabled_by_roles: strList, granted_to_actors: strList, evidence: { type: 'array', items: evidenceItem },
    }, required: ['name', 'evidence'] } },
    relationships: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, kind: { type: 'string' } }, required: ['from', 'to'] } },
    gaps: strList,
  },
  required: ['features', 'actors', 'roles', 'permissions', 'relationships', 'gaps'],
});

const inventoryCounts = (inventories) => Object.fromEntries(Object.keys(inventories || {}).map((k) => [k, (inventories[k] || []).length]));

export function buildLeadPrompt({ profile, inventories, summarized, workstream = null }) {
  const scope = workstream
    ? `You are mapping ONLY the bounded workstream below (${workstream.index + 1} of ${workstream.total}); another session covers the rest. Do not wander outside its paths.`
    : 'You are the Lead for the whole repository.';
  return `You are SecForge's mapping Lead: a read-only code-reconnaissance agent working inside a FROZEN
snapshot of one repository (your current directory). You may ONLY use Read, Glob and Grep. Never write,
run, install, or fetch anything. ${scope}

Repository profile: ${JSON.stringify({ languages: profile?.languages || [], frameworks: profile?.frameworks || [], files: profile?.files || 0, entry_points: (profile?.entry_points || []).slice(0, 20) })}
Inventory counts (deterministic extraction, whole repository): ${JSON.stringify(inventoryCounts(inventories))}

CANDIDATE TECHNICAL CLUSTERS (${summarized.length}) — deterministic directory/noun groupings of inventory rows.
They are STRUCTURE, not meaning. Open their sample files, decide what capability each really is, merge or
split as the source dictates, and ground every entity you keep. Each sample is {kind, file, line, entry};
those file:line pairs are real and citable, and so is anything else you open yourself.
${JSON.stringify(summarized)}

${METHODOLOGY}

Return ONLY the JSON object required by the output schema: features (with selectors and evidence),
actors, roles, permissions, relationships, gaps. Recon only — no findings.`;
}

// Coerce whatever the engine returned (structured_output, or prose-wrapped JSON) into a plan object.
function normalizePlan(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const arr = (k) => (Array.isArray(obj[k]) ? obj[k] : []);
  if (!['features', 'actors', 'roles', 'permissions'].some((k) => Array.isArray(obj[k]))) return null;
  return { features: arr('features'), actors: arr('actors'), roles: arr('roles'), permissions: arr('permissions'), relationships: arr('relationships'), gaps: arr('gaps') };
}
function parseLoose(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return normalizePlan(JSON.parse(body.slice(start, end + 1))); } catch { return null; }
}

async function exploreOnce(adapter, { prompt, cwd, model, effort, onEvent, label }) {
  const started = Date.now();
  onEvent?.({ kind: 'lead_started', label });
  const r = await adapter.explore({ prompt, cwd, model, maxTurns: leadTurns(effort), schema: PLAN_SCHEMA });
  if (!r || !r.ok) { onEvent?.({ kind: 'lead_failed', label, error: r?.error || 'no response' }); return { plan: null, meta: { ok: false, error: r?.error || 'no response' } }; }
  const plan = normalizePlan(r.structured) || parseLoose(r.text);
  onEvent?.({ kind: plan ? 'lead_planned' : 'lead_unparsed', label, features: plan?.features?.length || 0, turns: r.turns, ms: Date.now() - started });
  return { plan, meta: { ok: !!plan, sessionId: r.sessionId || null, turns: r.turns ?? null, cost: r.cost ?? null, ms: Date.now() - started } };
}

// Checkpoints: one JSON per workstream under checkpointDir so a re-run after an interrupted/partial
// Lead reuses every finished chunk instead of paying for it again. Best-effort I/O, never throws.
function readCheckpoint(dir, i) { if (!dir) return null; try { return normalizePlan(JSON.parse(fs.readFileSync(path.join(dir, `lead-${i}.json`), 'utf8'))); } catch { return null; } }
function writeCheckpoint(dir, i, plan) { if (!dir || !plan) return; try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `lead-${i}.json`), JSON.stringify(plan)); } catch { /* best effort */ } }

/**
 * planLead(clusters, adapter, ctx) → { plan, meta } | null. Agentic path only; the caller decides
 * whether the adapter can explore. ctx: { cwd (frozen source dir), profile, inventories, model,
 * effort, onEvent, checkpointDir }. Fails closed (null) on any unusable response; never throws.
 */
export async function planLead(clusters, adapter, { cwd, profile, inventories, model, effort, onEvent, checkpointDir } = {}) {
  if (!adapter || typeof adapter.explore !== 'function' || !cwd) return null;
  const summarized = summarizeClusters(clusters, { samplesPerCluster: 6 });
  if (!summarized.length) return null;
  const bytes = Buffer.byteLength(JSON.stringify(summarized));
  if (bytes <= HOLISTIC_SUMMARY_BYTES) {
    const { plan, meta } = await exploreOnce(adapter, { prompt: buildLeadPrompt({ profile, inventories, summarized }), cwd, model, effort, onEvent, label: 'Lead reading the snapshot' });
    return plan ? { plan, meta: { ...meta, workstreams: 1 } } : null;
  }
  const bins = chunkClusters(summarized, { maxBytes: Math.floor(HOLISTIC_SUMMARY_BYTES / 2) });
  onEvent?.({ kind: 'lead_workstreams', total: bins.length, label: `Large repository: ${bins.length} bounded workstreams, ${WORKSTREAM_CONCURRENCY} at a time` });
  let done = 0, sessions = [], turns = 0, cost = 0;
  const jobs = await runAll(bins.map((b, i) => ({ bin: b, i })), async ({ bin, i }) => {
    const cached = readCheckpoint(checkpointDir, i);
    if (cached) { done++; onEvent?.({ kind: 'lead_workstream_done', index: i, total: bins.length, resumed: true, done }); return cached; }
    const { plan, meta } = await exploreOnce(adapter, { prompt: buildLeadPrompt({ profile, inventories, summarized: bin.clusters, workstream: { index: i, total: bins.length } }), cwd, model, effort, onEvent, label: `workstream ${i + 1}/${bins.length}` });
    done++; if (meta.sessionId) sessions.push(meta.sessionId); turns += meta.turns || 0; cost += meta.cost || 0;
    onEvent?.({ kind: 'lead_workstream_done', index: i, total: bins.length, ok: !!plan, done });
    writeCheckpoint(checkpointDir, i, plan);
    return plan;
  }, { concurrency: WORKSTREAM_CONCURRENCY });
  const plans = jobs.map((j) => j.result).filter(Boolean);
  if (!plans.length) return null;
  const failed = bins.length - plans.length;
  const plan = mergeReconPlans(plans, failed > 0 ? [`${failed} workstream(s) produced no usable plan and were dropped`] : []);
  return { plan, meta: { ok: true, workstreams: bins.length, failedWorkstreams: failed, sessionId: sessions[0] || null, sessions, turns, cost } };
}

/**
 * deriveOntology — the one entry point the mapper calls for ANY engine. Picks the agentic Lead when
 * the adapter can explore and a frozen cwd is given, else the one-shot planClusters(); then runs the
 * SAME evidence validation on either result. Returns { ontology|null, llmCalled, lead:meta|null }.
 * accepted.features === 0 → ontology null (fail closed; deterministic clusters still become FEATUREs).
 */
export async function deriveOntology({ engine, adapter, clusters, inventories, profile, model, effort, cwd, readSnapshotFile, onEvent, checkpointDir } = {}) {
  if (!engine || engine === 'rules' || !adapter) return { ontology: null, llmCalled: false, lead: null };
  let raw = null, lead = null;
  if (typeof adapter.explore === 'function' && cwd) {
    const r = await planLead(clusters, adapter, { cwd, profile, inventories, model, effort, onEvent, checkpointDir });
    if (r) { raw = r.plan; lead = { engine, model: model || adapter.model || null, ...r.meta }; }
    else lead = { engine, model: model || adapter.model || null, ok: false };
  } else {
    raw = await planClusters(clusters, adapter, { model, effort });
  }
  if (!raw) return { ontology: null, llmCalled: true, lead };
  const verifier = makeEvidenceVerifier({ readSource: readSnapshotFile });
  const { ontology: validated, accepted, rejected } = validateOntology(raw, verifier);
  onEvent?.({ kind: 'lead_validated', accepted, rejected: rejected.length });
  if (lead) lead = { ...lead, accepted, rejected: rejected.length };
  return { ontology: accepted.features > 0 ? validated : null, llmCalled: true, lead };
}
