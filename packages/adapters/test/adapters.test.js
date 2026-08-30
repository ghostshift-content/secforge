// docs/PHASE4-ENV-PROVIDER-DESIGN.md §2 — effort passthrough + the makeAdapter().ask() drive-by
// fix that makes model AND effort actually reach openai/anthropic/ollama (previously the second
// arg to ask(prompt) was silently dropped).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';

const { EFFORT_BUDGETS, effortBudget, getAdapter, register, makeAdapter } = await import('../src/index.js');

describe('EFFORT_BUDGETS', () => {
  test('all four levels map to strictly increasing token budgets', () => {
    assert.deepEqual(Object.keys(EFFORT_BUDGETS), ['low', 'medium', 'high', 'max']);
    assert.ok(EFFORT_BUDGETS.low < EFFORT_BUDGETS.medium);
    assert.ok(EFFORT_BUDGETS.medium < EFFORT_BUDGETS.high);
    assert.ok(EFFORT_BUDGETS.high < EFFORT_BUDGETS.max);
  });
  test('effortBudget() falls back to medium for an unknown/missing level, never throws', () => {
    assert.equal(effortBudget('medium'), EFFORT_BUDGETS.medium);
    assert.equal(effortBudget('not-a-level'), EFFORT_BUDGETS.medium);
    assert.equal(effortBudget(undefined), EFFORT_BUDGETS.medium);
  });
});

describe('makeAdapter().ask(prompt, opts) forwards opts to askRaw — the §2.3 drive-by fix', () => {
  test('a fake adapter built via makeAdapter() + register() receives {model, effort} in askRaw, not just prompt', async () => {
    let seenPrompt = null, seenOpts = null;
    register(makeAdapter({
      id: 'fake-forward-check', label: 'fake', provider: 'fake-forward-check', model: null,
      available: async () => true,
      askRaw: async (prompt, opts = {}) => { seenPrompt = prompt; seenOpts = opts; return 'ok'; },
    }));
    const adapter = getAdapter('fake-forward-check');
    const out = await adapter.ask('hello world', { model: 'super-model-9', effort: 'max' });
    assert.equal(out, 'ok');
    assert.equal(seenPrompt, 'hello world');
    assert.deepEqual(seenOpts, { model: 'super-model-9', effort: 'max' });
  });

  test('ask() with no opts still calls askRaw safely (opts defaults to {})', async () => {
    let seenOpts = 'unset';
    register(makeAdapter({
      id: 'fake-no-opts', label: 'fake', provider: 'fake-no-opts', model: null,
      available: async () => true,
      askRaw: async (prompt, opts = {}) => { seenOpts = opts; return 'ok'; },
    }));
    await getAdapter('fake-no-opts').ask('hi');
    assert.deepEqual(seenOpts, {});
  });
});

// --- stubbed-fetch assertions: the real openai/anthropic/ollama askRaw honour opts.model/effort ---
describe('openai/anthropic/ollama askRaw: model + effort actually reach the outgoing request', () => {
  let originalFetch;
  let capturedUrl, capturedBody;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }], content: [{ text: 'x' }], response: 'x' }) };
    };
  });
  after(() => { globalThis.fetch = originalFetch; });

  test('openai: chosen model + effort-scaled max_tokens reach the request body', async () => {
    const openai = getAdapter('openai');
    await openai.ask('prompt', { model: 'gpt-picked', effort: 'high' });
    assert.equal(capturedBody.model, 'gpt-picked');
    assert.equal(capturedBody.max_tokens, EFFORT_BUDGETS.high);
  });

  test('openai: omitted effort defaults to EFFORT_BUDGETS.medium', async () => {
    const openai = getAdapter('openai');
    await openai.ask('prompt', { model: 'gpt-picked' });
    assert.equal(capturedBody.max_tokens, EFFORT_BUDGETS.medium);
  });

  test('anthropic: chosen model + effort-scaled max_tokens reach the request body', async () => {
    const anthropic = getAdapter('anthropic');
    await anthropic.ask('prompt', { model: 'claude-picked', effort: 'low' });
    assert.equal(capturedBody.model, 'claude-picked');
    assert.equal(capturedBody.max_tokens, EFFORT_BUDGETS.low);
  });

  test('ollama: chosen model + effort-scaled num_predict reach the request body', async () => {
    // ollamaAskRaw probes /api/tags first; stub answers both calls generically.
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama-default' }] }) };
      capturedUrl = url; capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ response: 'x' }) };
    };
    const ollama = getAdapter('ollama');
    await ollama.ask('prompt', { model: 'llama-picked', effort: 'max' });
    assert.equal(capturedBody.model, 'llama-picked');
    assert.equal(capturedBody.options.num_predict, EFFORT_BUDGETS.max);
  });

  test('an invalid/unknown effort string never throws — falls back to medium budget', async () => {
    globalThis.fetch = async (url, opts) => { capturedBody = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; };
    const openai = getAdapter('openai');
    const out = await openai.ask('prompt', { model: 'gpt-picked', effort: 'bogus-level' });
    assert.equal(typeof out, 'string');
    assert.equal(capturedBody.max_tokens, EFFORT_BUDGETS.medium);
  });
});
