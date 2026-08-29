// node:assert self-check — run with `node packages/patterns/src/import-demo.js`.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importCustomFolder } from './index.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secforge-patterns-import-demo-'));

const validCard = `## CUSTOM-01 — Missing owner check on export
**Invariant/goal:** only the owner can export their own report.
**Attacker control:** the report id in the URL.
**Guard-to-sink differential:** the export route skips the ownership guard the view route enforces.
**Required proof:** request another user's report id and receive their data.
**Decisive rejection:** the route already checks \`report.ownerId === session.userId\`.
**Overlaps:** ACX-01.
`;

const invalidCard = `## CUSTOM-02 — Incomplete card
**Invariant/goal:** something.
**Attacker control:** something else.
`;

await fs.writeFile(path.join(dir, 'valid.md'), validCard);
await fs.writeFile(path.join(dir, 'invalid.md'), invalidCard);

const result = importCustomFolder(dir);
assert.equal(result.count, 2, 'should import both cards');
assert.equal(result.cards.length, 2);

const ok = result.cards.find((c) => c.id === 'CUSTOM-01');
const bad = result.cards.find((c) => c.id === 'CUSTOM-02');
assert.ok(ok, 'valid card should be present');
assert.ok(bad, 'invalid card should be present');
assert.equal(ok.ok, true, 'valid card should pass field validation');
assert.equal(ok.missing.length, 0);
assert.equal(bad.ok, false, 'invalid card should fail field validation');
assert.ok(bad.missing.length > 0, 'invalid card should list missing fields');

await fs.rm(dir, { recursive: true, force: true });
console.log('OK: importCustomFolder — 1 ok, 1 not-ok');
