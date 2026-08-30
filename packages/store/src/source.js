// @secforge/store/source — frozen-snapshot source I/O (Phase A §1). Mirrors graph.js owning the
// SQL I/O: this file owns the snapshot-directory source I/O. Frozen-only — never falls back to
// the live sourceRoot; a missing frozen file is an honest null, not a silent re-read of a tree
// that may have moved on.
import fs from 'node:fs';
import path from 'node:path';

export function snapshotSourceDir(store, projectId, snapshotId) {
  return path.join(store.projectDir(projectId), 'snapshots', snapshotId, 'source');
}

export function readFrozenSourceLines(store, projectId, snapshotId, relPath, startLine = 1, endLine = null) {
  let text;
  try {
    text = fs.readFileSync(path.join(snapshotSourceDir(store, projectId, snapshotId), relPath), 'utf8');
  } catch {
    return null; // no frozen copy (pre-Phase-A snapshot, or file skipped by the manifest caps) — honest gap
  }
  const lines = text.split(/\r?\n/);
  const s = Math.max(1, startLine | 0);
  const e = endLine == null ? s : Math.max(s, endLine | 0);
  return lines.slice(s - 1, e).join('\n');
}
