// @secforge/assess/grounding — Phase B's "no dodgy findings" gate. An LLM-proposed candidate must
// name a file:line that is a REAL member of the fed-forward citation pool for the feature whose
// bundle produced it, checked BEFORE the candidate is even added to the LLM-assist candidate list
// (before TRIAGE, before reproveLlmCandidate's deterministic corroboration in rules.js). This
// COMPOSES with, never replaces, the existing executor→verifier gate: gate 1 (here) proves the
// location is real and was shown to the model; gate 2 (reproveLlmCandidate) proves the claim
// itself is real. Both must hold for a finding to be promoted.
import { makeEvidenceVerifier } from '@secforge/recon';
import { readFrozenSourceLines } from '@secforge/store';

// "file:line" -> citation, scoped to ONE feature's fed-forward bundle. Build fresh per feature —
// never merge across features, so a citation can only ground a candidate for the SAME feature
// whose bundle it came from.
export function citationIndex(bundle) {
  const m = new Map();
  for (const c of bundle.citations || []) if (c.file && c.line) m.set(`${c.file}:${c.line}`, c);
  return m;
}

// Find the citation a raw LLM output line actually names: the strict trailing `file:line` field
// first (exact key match), else any known citation string appearing anywhere in the line (covers
// prose/lenient output and minor formatting drift around the trailing field). Returns the
// citation object, or null — null means "drop this candidate", never a guess.
export function citationFromLine(line, citationIdx) {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length >= 6 && citationIdx.has(parts[5])) return citationIdx.get(parts[5]);
  for (const [key, c] of citationIdx) if (line.includes(key)) return c;
  return null;
}

// One verifier per run, bound to the pinned snapshot, its own file-read cache reused across every
// candidate checked this run. readFrozenSourceLines(..., 1, BIG) reads the whole frozen file (no
// dedicated "read whole file" API in @secforge/store — this is the documented, adequate ceiling;
// bump it if a real source file ever exceeds it).
const WHOLE_FILE_LINE_CEILING = 10_000_000;
export function makeSnapshotVerifier(store, projectId, snapshotId) {
  return makeEvidenceVerifier({
    readSource: (rel) => readFrozenSourceLines(store, projectId, snapshotId, rel, 1, WHOLE_FILE_LINE_CEILING) || '',
  });
}

// Defense-in-depth, NON-blocking: independently re-check a grounded citation against the frozen
// snapshot itself (file exists, line in range). Recorded for audit on the candidate; membership in
// citationIndex (above) is what actually gates promotion — this cannot RESURRECT a dropped
// candidate, only annotate a kept one. Meaningful only when a frozen source copy exists at all
// (pre-Phase-A snapshots have none); on those it will legitimately read false and is harmless
// because the candidate already carries a real citation from the graph's own claims.
export function frozenVerify(citation, verifier) {
  return verifier.verify({ file: citation.file, line: citation.line });
}
