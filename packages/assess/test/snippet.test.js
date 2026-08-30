// Phase B — buildSnippet() is frozen-first: a finding's evidence excerpt is read from the
// immutable per-snapshot source copy (packages/store/src/source.js), so it can never drift from
// what the scan actually saw, however much the live tree changes afterward. See assess.test.js's
// "buildSnippet() — sha match vs stale-on-edit" block for the pre-Phase-A live-read fallback path.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Store } from '@secforge/store';
import { mapProject } from '@secforge/map';
import { runAssessment, buildSnippet, loadManifest, readCurrentSnapshotId } from '@secforge/assess';

describe('buildSnippet() — frozen-first, live-fallback (Phase B)', () => {
  let tmpRoot, store, pid, sourceRoot;

  before(async () => {
    tmpRoot = path.join(os.tmpdir(), 'sf-frozen-' + crypto.randomBytes(4).toString('hex'));
    store = new Store(tmpRoot);
    sourceRoot = path.join(tmpRoot, 'proj');
    await fs.mkdir(path.join(sourceRoot, 'api'), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({}));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));
    const project = await store.openProject({ sourceRoot, name: 'FROZEN' });
    pid = project.id;
    await mapProject({ sourceRoot, store, projectId: pid });
  });

  after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

  test('a finding\'s snippet excerpt comes from FROZEN source and survives a live edit made after the scan', async () => {
    const result = await runAssessment({ store, projectId: pid, scope: {}, engine: 'rules' });
    const sdx = result.findings.find((f) => f.rule === 'SDX-unauth-datastore-reachable');
    assert.ok(sdx, 'an SDX finding was produced');
    assert.ok(sdx.snippet, 'snippet present');
    assert.equal(sdx.snippet.frozen, true, 'served from the frozen snapshot, not a live re-read');
    assert.equal(sdx.snippet.stale, false, 'a frozen snippet can never go stale relative to itself');
    const before = sdx.snippet.lines;
    assert.ok(before.some((l) => l.includes("/orders/:id")));

    // Edit the LIVE source file on disk — the frozen snapshot must not see this.
    await fs.writeFile(path.join(sourceRoot, 'api', 'orders.js'), [
      "router.get('/orders/:id', (req, res) => res.json({ CHANGED: true }));",
      "const Order = mongoose.model('Order', schema);",
      '',
    ].join('\n'));

    // Re-decorate the SAME evidence against the SAME snapshot: byte-identical excerpt.
    const snapshotId = await readCurrentSnapshotId(store, pid);
    const manifest = await loadManifest(store, pid);
    const after = buildSnippet(store, pid, snapshotId, sdx.evidence, { sourceRoot, manifest });
    assert.deepEqual(after.lines, before, 'frozen excerpt is byte-identical after the live edit');
    assert.equal(after.frozen, true);
    assert.ok(!after.lines.some((l) => l.includes('CHANGED')), 'never reflects the live edit');
  });
});
