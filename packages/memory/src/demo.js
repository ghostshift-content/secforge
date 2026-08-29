// node:assert self-check — run with `node packages/memory/src/demo.js`.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, record, recall, learn, crossProjectRecall, stats } from './index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secforge-memory-demo-'));
const store = new Store(root);

const projectA = await store.openProject({ sourceRoot: path.join(root, 'proj-a') });
const projectB = await store.openProject({ sourceRoot: path.join(root, 'proj-b') });

// learn() then recall() finds it
await learn(store, projectA.id, { name: 'IDOR on /orders/:id', kind: 'pattern', note: 'missing owner check', family: 'ACX' });
const hit = await recall(store, projectA.id, 'idor');
assert.equal(hit.hits.length, 1, 'recall should find the learned pattern by keyword');
assert.ok(hit.hits[0].includes('IDOR on /orders/:id'));

// record() plain feedback also lands in feedback.jsonl (counted by stats)
await record(store, projectA.id, { type: 'feedback', verdict: 'confirmed' });

// crossProjectRecall finds hits across projects
await learn(store, projectB.id, { name: 'SSRF via webhook url', kind: 'pattern', note: 'no allowlist', family: 'SX' });
const cross = await crossProjectRecall(store, 'ssrf');
assert.equal(cross.length, 1, 'crossProjectRecall should find the hit in project B');
assert.equal(cross[0].project, projectB.id);

// stats() counts correctly
const statsA = await stats(store, projectA.id);
assert.equal(statsA.patterns, 1, 'projectA should have 1 learned-pattern line');
assert.equal(statsA.feedbackSignals, 2, 'projectA should have 2 feedback lines (learn + record)');
assert.equal(statsA.projects, 2, 'store has 2 projects total');

// bad kind rejected
await assert.rejects(() => learn(store, projectA.id, { name: 'x', kind: 'bogus' }));

await fs.rm(root, { recursive: true, force: true });
console.log('OK: memory learn/recall/crossProjectRecall/stats');
