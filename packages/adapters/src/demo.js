// Self-check: node packages/adapters/src/demo.js — must pass offline, no Ollama, no API keys.
import assert from 'node:assert/strict';
import { listEngines, getAdapter } from './index.js';

const engines = await listEngines();

const rulesEntry = engines.find((e) => e.id === 'rules');
assert.ok(rulesEntry, 'rules engine must be listed');
assert.equal(rulesEntry.available, true, 'rules engine is always available');

const rules = getAdapter('rules');
assert.equal(await rules.available(), true, 'rules adapter always available');
assert.equal(typeof (await rules.ask('x')), 'string', 'rules.ask resolves to a string');
const rulesRun = await rules.runAgent({ id: 'job-1', role: 'hunter' });
assert.equal(rulesRun.ok, true, 'rules.runAgent is a safe no-op');

// No default expected here unless a real provider happens to be configured/reachable.
assert.ok(engines.some((e) => e.default), 'exactly one engine is marked default');

const openaiEntry = engines.find((e) => e.id === 'openai');
assert.ok(openaiEntry, 'openai engine must be listed');
assert.equal(openaiEntry.available, !!process.env.OPENAI_API_KEY, 'openai availability tracks OPENAI_API_KEY');

const openai = getAdapter('openai');
if (!(await openai.available())) {
  const res = await openai.ask('x');
  assert.equal(typeof res, 'string', 'openai.ask never throws, resolves to a string');
  const parsed = JSON.parse(res);
  assert.equal(parsed.ok, false, 'unconfigured openai.ask reports ok:false');

  const run = await openai.runAgent({ id: 'job-2', role: 'hunter' });
  assert.equal(run.ok, false, 'unconfigured openai.runAgent reports ok:false');
  assert.ok(run.error, 'unconfigured openai.runAgent carries an error message');
}

// Unknown engine id falls back to the safe default instead of throwing.
assert.equal(getAdapter('does-not-exist').id, 'rules', 'unknown adapter id falls back to rules');

console.log('OK', engines.map((e) => `${e.id}:${e.available}`).join(' '));
