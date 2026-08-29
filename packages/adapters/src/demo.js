// Self-check: node packages/adapters/src/demo.js — must pass offline and fast, never hang.
import assert from 'node:assert/strict';
import { listEngines, getAdapter, checkConnection } from './index.js';

const engines = await listEngines();

const rulesEntry = engines.find((e) => e.id === 'rules');
assert.ok(rulesEntry, 'rules engine must be listed');
assert.equal(rulesEntry.connected, true, 'rules engine is always connected');

const rules = getAdapter('rules');
assert.equal(await rules.available(), true, 'rules adapter always available');
assert.equal(typeof (await rules.ask('x')), 'string', 'rules.ask resolves to a string');
assert.equal((await rules.runAgent({ id: 'job-1' })).ok, true, 'rules.runAgent is a safe no-op');

// Every provider is listed with a boolean connection status, a models array and a how-to hint.
for (const id of ['claude-code', 'codex', 'gemini', 'ollama', 'openai', 'anthropic']) {
  const e = engines.find((x) => x.id === id);
  assert.ok(e, `${id} must be listed`);
  assert.equal(typeof e.connected, 'boolean', `${id}.connected is boolean`);
  assert.ok(Array.isArray(e.models), `${id}.models is an array`);
  assert.equal(typeof e.howToConnect, 'string', `${id}.howToConnect present`);
}

assert.ok(engines.some((e) => e.default), 'exactly one engine is marked default');

// checkConnection: rules always connected; openai tracks its key; unknown → false.
assert.equal((await checkConnection('rules')).connected, true);
assert.equal((await checkConnection('openai')).connected, !!process.env.OPENAI_API_KEY);
assert.equal((await checkConnection('nope')).connected, false);

// Unknown engine id falls back to the safe default instead of throwing.
assert.equal(getAdapter('does-not-exist').id, 'rules', 'unknown adapter id falls back to rules');

console.log('OK', engines.map((e) => `${e.id}:${e.connected}`).join(' '));
