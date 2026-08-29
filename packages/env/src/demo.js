// node:assert self-check — run with `node packages/env/src/demo.js`. Never hits the network.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@secforge/store';
import { registerTarget, getTarget, validateFinding } from './index.js';

// fail loudly if anything ever tries to make a real network call in this demo
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('demo must never call fetch'); };

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'secforge-env-demo-'));
const store = new Store(root);
const project = await store.openProject({ sourceRoot: path.join(root, 'proj') });

const finding = { id: 'finding:F-1-x', route: '/api/orders/1' };

// no target registered at all → not authorized
assert.equal((await getTarget(store, project.id)), null);
const noTarget = await validateFinding(store, project.id, finding);
assert.equal(noTarget.ran, false);
assert.equal(noTarget.reason, 'not authorized (static-only)');

// authorized:false → still refused, no network call
await registerTarget(store, project.id, { baseUrl: 'http://localhost:9', authorized: false });
const unauthorized = await validateFinding(store, project.id, finding);
assert.equal(unauthorized.ran, false);
assert.equal(unauthorized.reason, 'not authorized (static-only)');

// authorized:true + dryRun:true (default) → shaped result, still no network call
await registerTarget(store, project.id, { baseUrl: 'http://localhost:9', authorized: true });
const dry = await validateFinding(store, project.id, finding, { dryRun: true });
assert.equal(dry.ran, false);
assert.equal(dry.reason, 'dry-run');
assert.ok(dry.wouldGet.includes('/api/orders/1'));

const target = await getTarget(store, project.id);
assert.equal(target.authorized, true);
assert.equal(target.baseUrl, 'http://localhost:9');

globalThis.fetch = originalFetch;
await fs.rm(root, { recursive: true, force: true });
console.log('OK: env registerTarget/getTarget/validateFinding stayed static-only');
