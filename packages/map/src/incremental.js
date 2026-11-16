// @secforge/map/incremental — Phase C: diff-remap. On a code change, re-map only what's affected
// and reuse the expensive AI work + frozen I/O for features untouched by the diff. Pure diff/reuse
// helpers + one orchestrator; the only I/O here is reading prior-snapshot artifacts and forwarding
// already-frozen source bytes. Zero new deps. buildGraph/store/recon contracts are untouched — see
// docs (phase-c design): the payoff is skipping planClusters() for unaffected clusters, never a
// hand-rolled graph splice (buildGraph always runs once, in full, over the current inputs).
import fs from 'node:fs';
import path from 'node:path';
import { ID } from '@secforge/schemas';
import { planClusters, planLead, deriveOntology, makeEvidenceVerifier, validateOntology, buildGraph } from '@secforge/recon';
import { getAdapter } from '@secforge/adapters';
// Relative imports: @secforge/recon's and @secforge/store's package.json only open their root
// ("."), so a bare '@secforge/recon/ai-semantic' or '@secforge/store/graph' specifier is blocked
// by Node's package encapsulation — same reach-past-exports convention map/src/index.js already
// uses for @secforge/store's graph module. Neither ai-semantic export below is re-exported from
// recon/src/index.js; recon/store source is out of scope for this change, so we reach past them
// instead of adding an export there.
import { mergeReconPlans } from '../../recon/src/ai-semantic.js';
import { slug } from '../../recon/src/semantic-planner.js';
import { currentSnapshotId, readReconciliation } from '../../store/src/graph.js';

// Thrown when a feature the plan believed was safely reused turns out NOT to reconcile identically
// between the old and new snapshot (the provably-lossless self-check). The caller (mapProject) MUST
// catch this, discard the incremental attempt, and fall back to a full remap — never persisted,
// never silently ignored. This is the concrete, checkable form of "never silently drop a feature".
export class IncrementalMismatchError extends Error {
  constructor(featureId) {
    super(`incremental remap: reconciliation mismatch for reused feature ${featureId} — falling back to full remap`);
    this.name = 'IncrementalMismatchError';
    this.featureId = featureId;
  }
}

// ---------- the diff ----------
export function parseManifestJsonl(text) {
  const m = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    m.set(r.path, r.sha256);
  }
  return m;
}

// A same-content file moved to a new path is not rename-detected — one `added` + one `deleted`
// entry. Correct, just not maximally efficient (costs one avoidable dirty-cluster at most).
export function diffManifests(priorManifestMap, newManifest) {
  const added = [], changed = [], unchanged = [];
  const newPaths = new Set(newManifest.map((m) => m.path));
  for (const m of newManifest) {
    const priorSha = priorManifestMap.get(m.path);
    if (priorSha == null) added.push(m.path);
    else if (priorSha !== m.sha256) changed.push(m.path);
    else unchanged.push(m.path);
  }
  const deleted = [...priorManifestMap.keys()].filter((p) => !newPaths.has(p));
  return { added, changed, deleted, unchanged };
}

// ---------- file -> feature reverse index ----------
// Built from the reconciliation ledger — the exact {file, feature_id} artifact buildGraph already
// produces — never from CONTAINS edges (those never express FEATURE->FILE membership). A ledger
// with zero MAPPED_TO_FEATURE rows yields an empty index on purpose; the caller's eligibility guard
// (not this function) is what stops an empty index from silently reading as "nothing changed".
export function fileToFeatureIndex(priorReconRows) {
  const byFile = new Map();
  for (const r of priorReconRows) {
    if (r.status !== 'MAPPED_TO_FEATURE' || !r.feature_id || !r.file) continue;
    if (!byFile.has(r.file)) byFile.set(r.file, new Set());
    byFile.get(r.file).add(r.feature_id);
  }
  return byFile;
}

// A changed or deleted file marks its owning feature(s) dirty.
export function dirtyFeatureIds(byFile, touchedFiles) {
  const dirty = new Set();
  for (const f of touchedFiles) for (const fid of byFile.get(f) || []) dirty.add(fid);
  return dirty;
}

// ---------- frozen source forwarding ----------
// Same inode, zero extra disk, same filesystem; falls back to a real copy cross-device or wherever
// hardlinks aren't supported. Either way the new snapshot's source/ dir ends up byte-for-byte
// identical to what a full re-freeze would have produced — independently readable, with zero
// dependency on the prior snapshot surviving (deleting it later does not break this snapshot).
export function freezeForward(priorSourceDir, newSourceDir, rel) {
  const dest = path.join(newSourceDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(path.join(priorSourceDir, rel), dest); }
  catch { fs.copyFileSync(path.join(priorSourceDir, rel), dest); }
}

// ---------- AI-ontology persistence (new artifact: one ontology.json per snapshot) ----------
// Written unconditionally whenever an ontology was accepted, on every mapProject run (full or
// incremental), so the NEXT run of either kind always has something to reuse.
export function persistOntologyPlan(store, projectId, snapshotId, ontology) {
  const file = path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'ontology.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(ontology));
  fs.renameSync(file + '.tmp', file);
}

export function loadOntologyPlan(store, projectId, snapshotId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'ontology.json'), 'utf8'));
  } catch { return null; } // absent (rules-only prior run, pre-Phase-C snapshot, or corrupted) — honest null, not a guess
}

// ---------- provably-lossless self-check ----------
export function reconSignature(rows) {
  return new Set(rows.map((r) => `${r.file}:${r.line}:${r.kind}:${r.entry}:${r.status}`));
}

// Throws the instant one reused feature's reconciliation-row set differs between the old and new
// snapshot. A mismatch can only mean the dirty/reused classification missed something — a bug
// signal, not a normal outcome. Never returns a partial verdict; the caller falls back to full.
export function checkLosslessReuse(reusedFeatureIds, priorReconRows, newReconRows) {
  for (const fid of reusedFeatureIds) {
    const priorSig = reconSignature(priorReconRows.filter((r) => r.feature_id === fid));
    const newSig = reconSignature(newReconRows.filter((r) => r.feature_id === fid));
    if (priorSig.size !== newSig.size || [...priorSig].some((s) => !newSig.has(s))) throw new IncrementalMismatchError(fid);
  }
}

// ---------- AI-plan reuse ----------
// Mirrors recon/graph.js's private featureKey()/slug() normalization exactly, so an id computed
// here matches what buildGraph will actually assign to the SAME feature post-validateLeadPlan.
function ontologyFeatureId(f) {
  const domain = slug(f.domain || 'core');
  const featSlug = slug(f.slug || f.name);
  return ID.feature(domain && domain !== 'core' ? `${domain}-${featSlug}` : featSlug);
}

// An ontology entity is safe to reuse as-is iff none of its evidence files changed or were deleted.
const evidenceUnchangedOf = (touched) => (e) => (e?.evidence || []).every((ev) => !touched.has(ev.file));

// A FEATURE additionally needs the reconciliation-ledger check: its evidence citation might be a
// single justifying line while its actual membership spans many other files, so membership
// shrinkage from an unrelated deleted file must also invalidate reuse.
function reusableOntologySlice(priorOntology, touched, dirty) {
  if (!priorOntology) return null; // nothing to reuse — degrades to a full-AI derivation, no special case
  const evidenceUnchanged = evidenceUnchangedOf(touched);
  const featureReusable = (f) => evidenceUnchanged(f) && !dirty.has(ontologyFeatureId(f));
  return {
    features: (priorOntology.features || []).filter(featureReusable),
    actors: (priorOntology.actors || []).filter(evidenceUnchanged),
    roles: (priorOntology.roles || []).filter(evidenceUnchanged),
    permissions: (priorOntology.permissions || []).filter(evidenceUnchanged),
    relationships: priorOntology.relationships || [], // dangling ones pruned by validateOntology below
    gaps: [],
  };
}

// Which deterministic clusters actually need a fresh LLM look this run — only ones touching an
// added/changed file's row. A brand-new file's rows land in a cluster keyed off their own
// path/route text, so a genuinely new cluster is automatically "dirty" too — no separate check.
const dirtyClustersOf = (currentClusters, addedOrChanged) =>
  (currentClusters || []).filter((c) => c.rows.some(({ row }) => addedOrChanged.has(row.file)));

const countOntology = (o) => (o ? o.features.length + o.actors.length + o.roles.length + o.permissions.length : 0);

/**
 * Orchestrate one incremental remap attempt. Assumes the caller has already cleared the
 * fail-closed eligibility guards (prior snapshot + usable reconciliation ledger exist, incremental
 * not disabled, clustering threshold stable) — this function only decides AI-ontology reuse.
 * @returns {Promise<{ontology: object|null, dirtyFeatureIds: Set<string>, reusedFeatureIds: string[], llmCalled: boolean, ontologyReusedCount: number}>}
 */
export async function planIncrementalRemap({
  store, projectId, priorSnapshotId, priorReconRows, diff, currentClusters,
  engine, adapter, model, effort, readSnapshotFile, ctx = {},
} = {}) {
  const byFile = fileToFeatureIndex(priorReconRows);
  const touched = new Set([...diff.changed, ...diff.deleted]);
  const dirty = dirtyFeatureIds(byFile, touched);

  const priorOntology = loadOntologyPlan(store, projectId, priorSnapshotId);
  const reusedRaw = reusableOntologySlice(priorOntology, touched, dirty);
  const ontologyReusedCount = countOntology(reusedRaw);

  const addedOrChanged = new Set([...diff.added, ...diff.changed]);
  const dirtyClusters = dirtyClustersOf(currentClusters, addedOrChanged);

  let ontology = null, llmCalled = false, lead = null;
  // Store-is-truth: a prior, evidence-validated AI ontology is REUSED on a rules-only re-map when no
  // feature is dirty (an unchanged tree, or a change outside every mapped feature) — reopening a
  // project with the default engine must never silently downgrade an AI map to directory clusters.
  // Any dirty feature under 'rules' falls through to a full deterministic map (nothing to re-plan it with).
  if ((!engine || engine === 'rules') && reusedRaw && !dirtyClusters.length && countOntology(reusedRaw) > 0) {
    const verifier = makeEvidenceVerifier({ readSource: readSnapshotFile });
    const { ontology: validated, accepted } = validateOntology(reusedRaw, verifier);
    if (accepted.features > 0) ontology = validated;
  } else if (engine && engine !== 'rules') {
    let freshRaw = null;
    if (dirtyClusters.length) {
      llmCalled = true;
      // Same engine choice as a full map: the agentic Lead reads the frozen snapshot when the adapter
      // can explore, else the one-shot planner — but only over the DIRTY clusters either way.
      if (adapter && typeof adapter.explore === 'function' && ctx.cwd) {
        const r = await planLead(dirtyClusters, adapter, { cwd: ctx.cwd, profile: ctx.profile, inventories: ctx.inventories, model, effort, onEvent: ctx.onEvent, checkpointDir: ctx.checkpointDir });
        freshRaw = r ? r.plan : null; lead = r ? { engine, model: model || adapter.model || null, ...r.meta } : { engine, ok: false };
      } else {
        freshRaw = await planClusters(dirtyClusters, adapter, { model, effort });
      }
    }
    const merged = mergeReconPlans([reusedRaw, freshRaw].filter(Boolean));
    if (merged.features.length || merged.actors.length || merged.roles.length || merged.permissions.length) {
      const verifier = makeEvidenceVerifier({ readSource: readSnapshotFile });
      const { ontology: validated, accepted } = validateOntology(merged, verifier);
      // accepted.features === 0 -> fail closed silently, same rule as a full map (mapper-design.md
      // §CRITICAL rule 2): deterministic clusters still become FEATURE nodes on their own.
      if (accepted.features > 0) ontology = validated;
    }
  }

  const priorFeatureIds = new Set(priorReconRows.map((r) => r.feature_id).filter(Boolean));
  // The lossless self-check (checkLosslessReuse) may only cover features the plan actually reproduces:
  // when an ontology is reused, that is its own feature ids; a prior ledger written by a DIFFERENT
  // planner (e.g. a rules-only run over the same snapshot id) must not be mistaken for "reused".
  const planIds = ontology ? new Set((ontology.features || []).map(ontologyFeatureId)) : null;
  const reusedFeatureIds = [...priorFeatureIds].filter((fid) => !dirty.has(fid) && (!planIds || planIds.has(fid)));

  return { ontology, dirtyFeatureIds: dirty, reusedFeatureIds, llmCalled, ontologyReusedCount, lead };
}

// ---------- shared with map/src/index.js's full-map path ----------
// The always-available fallback ontology derivation: ask the LLM (if any) about every current
// cluster, evidence-validate the response. Used both for an actual full map and whenever the
// incremental path is ineligible or self-check-mismatched — i.e. exactly today's pre-Phase-C
// behavior. `readSnapshotFile` is a (rel) => text reader bound to the run's frozen source.
// `ctx` ({cwd, profile, inventories, onEvent, checkpointDir}) enables the agentic Lead (recon/lead.js)
// when the engine's adapter can explore; without it (or for a one-shot adapter) this is the
// pre-existing planClusters() path. Either way the same evidence validation gates the result.
export async function deriveFreshOntology(engine, clusters, model, effort, readSnapshotFile, ctx = {}) {
  if (!engine || engine === 'rules') return { ontology: null, llmCalled: false, lead: null };
  const adapter = getAdapter(engine);
  return deriveOntology({ engine, adapter, clusters, inventories: ctx.inventories, profile: ctx.profile, model, effort, cwd: ctx.cwd, readSnapshotFile, onEvent: ctx.onEvent, checkpointDir: ctx.checkpointDir });
}

// Additive field on snapshot.json (guard #2: has the deterministicSemanticPlan clustering MODE —
// module-cohesion vs local-cohesion — flipped between snapshots?). Best-effort; a read/parse
// failure just means the field never gets set, which the next run's guard treats as "unknown -> not
// safe to reuse" (fail closed), never as a false "unchanged".
export function persistFeatureRowCount(store, projectId, snapshotId, count) {
  const file = path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'snapshot.json');
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  snap.feature_row_count = count;
  fs.writeFileSync(file + '.tmp', JSON.stringify(snap, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// ---------- §7 fail-closed eligibility (guards #1/#3/#4) ----------
// Guard #2 needs the CURRENT inventory row count, which isn't known yet at this point in
// map/src/index.js's pipeline — checked separately, right after inventory extraction. Returns the
// prior-snapshot artifacts an eligible attempt needs, or a `reason` explaining why incremental
// mode is skipped this run.
export async function checkIncrementalEligibility(store, projectId, incremental) {
  if (incremental === false) return { attempt: false, reason: 'explicit-false' };
  const priorSnapshotId = await currentSnapshotId(store, projectId).catch(() => null);
  if (!priorSnapshotId) return { attempt: false, reason: 'no-prior-snapshot' };
  const priorDir = path.join(store.projectDir(projectId), 'snapshots', priorSnapshotId);
  const priorSourceDir = path.join(priorDir, 'source');
  let priorManifestMap;
  try { priorManifestMap = parseManifestJsonl(fs.readFileSync(path.join(priorDir, 'source-manifest.jsonl'), 'utf8')); }
  catch { return { attempt: false, reason: 'no-prior-snapshot' }; }
  if (!fs.existsSync(priorSourceDir)) return { attempt: false, reason: 'no-prior-snapshot' };
  let priorInvNonEmpty = false;
  try { priorInvNonEmpty = fs.readFileSync(path.join(priorDir, 'inventory.jsonl'), 'utf8').split('\n').filter(Boolean).length > 0; }
  catch { /* unreadable prior inventory -> treat as empty, same as "not present" */ }
  const priorReconRows = await readReconciliation(store, projectId, priorSnapshotId).catch(() => []);
  if (priorInvNonEmpty && priorReconRows.length === 0) return { attempt: false, reason: 'no-reconciliation-ledger' };
  return { attempt: true, reason: null, priorSnapshotId, priorDir, priorSourceDir, priorManifestMap, priorReconRows };
}

// ---------- top-level orchestration (map/src/index.js's one call site) ----------
// Guard #2 (has the clustering MODE flipped?) is decided here, once `featureRowCount` is known;
// then either the incremental reuse plan or a full fresh derivation feeds ONE buildGraph() call —
// exactly the same call for both paths (design §3.3) — and the lossless self-check gates whether
// that result is trusted or discarded for a same-run full fallback (design §3.4). Never persists
// anything itself — map/src/index.js still owns writing the graph/snapshot once this returns.
export async function remapGraph({
  store, projectId, snapshotId, manifest, eligibility, featureRowCount,
  clusters, inventories, legacyRows, project, engine, model, effort, readSnapshotFile, ctx = {},
} = {}) {
  let attemptIncremental = eligibility.attempt;
  let remapReason = eligibility.reason;
  const diff = attemptIncremental ? diffManifests(eligibility.priorManifestMap, manifest) : null;

  if (attemptIncremental) {
    let priorFeatureRowCount = null;
    try { priorFeatureRowCount = JSON.parse(fs.readFileSync(path.join(eligibility.priorDir, 'snapshot.json'), 'utf8')).feature_row_count; } catch { /* unreadable */ }
    if (priorFeatureRowCount == null || (priorFeatureRowCount >= 80) !== (featureRowCount >= 80)) {
      attemptIncremental = false;
      remapReason = 'threshold-crossed';
    }
  }

  let ontology, llmCalled, lead = null, ontologyReusedCount = 0, reusedFeatureIds = [];
  if (attemptIncremental) {
    ({ ontology, llmCalled, ontologyReusedCount, reusedFeatureIds, lead } = await planIncrementalRemap({
      store, projectId, priorSnapshotId: eligibility.priorSnapshotId, priorReconRows: eligibility.priorReconRows,
      diff, currentClusters: clusters, engine, adapter: engine && engine !== 'rules' ? getAdapter(engine) : null,
      model, effort, readSnapshotFile, ctx,
    }));
  } else {
    ({ ontology, llmCalled, lead } = await deriveFreshOntology(engine, clusters, model, effort, readSnapshotFile, ctx));
  }

  let graph = buildGraph({ inventories, clusters, ontology, legacyRows, project, snapshotId });

  let incrementalUsed = attemptIncremental;
  if (attemptIncremental) {
    try {
      checkLosslessReuse(reusedFeatureIds, eligibility.priorReconRows, graph.reconciliation);
    } catch (err) {
      if (!(err instanceof IncrementalMismatchError)) throw err;
      incrementalUsed = false; remapReason = 'mismatch-fallback'; reusedFeatureIds = [];
      ({ ontology, llmCalled, lead } = await deriveFreshOntology(engine, clusters, model, effort, readSnapshotFile, ctx));
      graph = buildGraph({ inventories, clusters, ontology, legacyRows, project, snapshotId });
    }
  }

  return { graph, ontology, incrementalUsed, remapReason, reusedFeatureIds, llmCalled, ontologyReusedCount, diff, lead };
}
