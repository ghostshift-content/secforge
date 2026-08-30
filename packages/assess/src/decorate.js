// @secforge/assess/decorate — enrich a persisted finding record with UI-facing fields.
// decorateFinding() is PURE (cwe_name, cvss, derived severity, description, remediation + a
// precomputed snippet). Snippet building is the only I/O and lives here separately so the pure
// decorator stays trivially testable. No LLM, no network: every string is built from facts already
// on the finding plus real source read from disk.

import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cweName } from '@secforge/patterns';
import { readFrozenSourceLines } from '@secforge/store';
import { RULE_CVSS, severityFromScore } from './rules.js';

// "<METHOD> <route> (<file>:<line>)" from whatever facts are present.
function locOf(f) {
  const mr = [f.method, f.route].filter(Boolean).join(' ');
  const fl = f.evidence?.file ? `${f.evidence.file}${f.evidence.line ? ':' + f.evidence.line : ''}` : null;
  return fl ? (mr ? `${mr} (${fl})` : fl) : (mr || 'This endpoint');
}

// Factual, per-rule description — built ONLY from facts on the finding. No invented code.
function describeFinding(f, name) {
  const loc = locOf(f);
  const cwe = [f.cwe, name].filter(Boolean).join(' ');
  const tail = cwe ? ` (${cwe})` : '';
  switch (f.rule) {
    case 'ACX-idor-no-owner-check':
      return `${loc} reads an object by id for an authenticated caller, but no ownership/authorization check gates it, so any authenticated user can read another user's object.${tail}`;
    case 'ACX-missing-authentication':
      return `${loc} is reachable with no authentication and no authorization, so any unauthenticated caller can invoke it.${tail}`;
    case 'REX-no-rate-limit':
      return `${loc} is state-changing but carries no rate-limit or throttle signal, so a caller can invoke it without any volume limit.${tail}`;
    case 'SDX-unauth-datastore-reachable':
      return `${loc} is unauthenticated and its feature reaches a data store, exposing potentially sensitive data to an unauthorized actor.${tail}`;
    default:
      return `${loc}: ${f.title || 'finding'}.${tail}`;
  }
}

// Per-rule remediation advice (guidance, not a diff) including the honest graph clearing condition.
function remediationFor(rule) {
  switch (rule) {
    case 'ACX-idor-no-owner-check':
      return 'Bind the resolved object to the caller before returning it (row-level policy or a scoped lookup that enforces ownership). This finding clears when an AUTHORIZED_BY (owner/policy) edge is detected on this endpoint in the graph.';
    case 'ACX-missing-authentication':
      return 'Require authentication (and appropriate authorization) on this endpoint before it runs. This finding clears when an AUTHENTICATED_BY edge is detected on this endpoint in the graph.';
    case 'REX-no-rate-limit':
      return 'Apply a rate limit / throttle to this state-changing endpoint (per-IP and/or per-account). This finding clears when a rate-limit/throttle guard (GUARDED_BY) is detected on this endpoint in the graph.';
    case 'SDX-unauth-datastore-reachable':
      return 'Require authentication on endpoints that reach this data store, or isolate the store behind an authorized service. This finding clears when the reaching endpoint gains an AUTHENTICATED_BY or AUTHORIZED_BY edge in the graph.';
    default:
      return 'Review this endpoint against the referenced pattern card and add the missing guard.';
  }
}

/**
 * Pure enrichment: finding + precomputed snippet -> finding with the UI's exact field names.
 * severity is DERIVED from cvss.score (replacing any hardcoded value); cwe_name is null if unknown.
 */
export function decorateFinding(finding, { snippet = null } = {}) {
  const meta = RULE_CVSS[finding.rule] || null;
  const cvss = meta ? { vector: meta.vector, score: meta.score } : null;
  const name = cweName(finding.cwe);
  return {
    ...finding,
    cwe_name: name,
    cvss,
    severity: cvss ? severityFromScore(cvss.score) : finding.severity,
    description: describeFinding(finding, name),
    remediation: remediationFor(finding.rule),
    snippet,
  };
}

// --- snippet I/O (frozen-first: Phase B §3; live-read is now only the pre-Phase-A fallback) ---

// Read the current snapshot id from graph/current.json (the same pointer file
// writeCurrentPointerFile mirrors and routes.js's inventory handler independently re-reads).
// null on any failure (no project yet, no snapshot taken).
export async function readCurrentSnapshotId(store, projectId) {
  try {
    const p = JSON.parse(await fs.readFile(path.join(store.projectDir(projectId), 'graph', 'current.json'), 'utf8'));
    return p.snapshotId || null;
  } catch { return null; }
}

// Load the current snapshot's source-manifest as a Map<relPath, sha256>. Empty map on any failure.
export async function loadManifest(store, projectId) {
  const snapshotId = await readCurrentSnapshotId(store, projectId);
  if (!snapshotId) return new Map();
  try {
    const text = await fs.readFile(path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'source-manifest.jsonl'), 'utf8');
    const m = new Map();
    for (const line of text.split('\n')) { if (!line) continue; const r = JSON.parse(line); m.set(r.path, r.sha256); }
    return m;
  } catch { return new Map(); }
}

export async function readSourceRoot(store, projectId) {
  try { return JSON.parse(await fs.readFile(path.join(store.projectDir(projectId), 'project.json'), 'utf8')).sourceRoot || null; }
  catch { return null; }
}

/**
 * Snippet around evidence.line, FROZEN-first (Phase B §3): reads the immutable per-snapshot source
 * copy so a finding's evidence excerpt can never drift from what the scan actually saw, however
 * much the live tree changes afterward. Falls back to a live re-read + sha256-vs-manifest staleness
 * check ONLY when no frozen copy exists (a pre-Phase-A snapshot, or snapshotId is unknown) — an
 * honest degrade, never a silent skip. `frozen` says which path served the result.
 * @returns {{file,startLine,endLine,lines:string[],sha256?,stale,frozen}|null}
 */
export function buildSnippet(store, projectId, snapshotId, evidence, { sourceRoot = null, manifest = null, window = 2 } = {}) {
  const rel = evidence?.file;
  const line = evidence?.line;
  if (!rel || !line) return null;
  const startLine = Math.max(1, line - window);
  const endLine = line + window;

  if (snapshotId) {
    const text = readFrozenSourceLines(store, projectId, snapshotId, rel, startLine, endLine);
    if (text != null) return { file: rel, startLine, endLine, lines: text.split('\n'), stale: false, frozen: true };
  }

  // Fallback: this snapshot predates Phase A (no frozen source dir) — same live-read +
  // sha256-vs-manifest staleness check as before Phase B. Honest degrade, not a silent skip.
  if (!sourceRoot) return null;
  const manifestSha = manifest?.get?.(rel);
  if (!manifestSha) return null; // no manifest entry
  let buf;
  try { buf = readFileSync(path.join(sourceRoot, rel)); } catch { return null; }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const all = buf.toString('utf8').split(/\r?\n/);
  const s = Math.max(1, line - window);
  const e = Math.min(all.length, line + window);
  return { file: rel, startLine: s, endLine: e, lines: all.slice(s - 1, e), sha256, stale: sha256 !== manifestSha, frozen: false };
}
