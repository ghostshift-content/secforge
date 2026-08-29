// @secforge/adapters — engine backends behind one interface. The only external "engine".
// Every backend normalises to the same job/result envelope so the pipeline is provider-agnostic.
// Node stdlib + global fetch only. No SDKs — every provider is called over its plain HTTP API.

/**
 * @typedef {Object} EngineAdapter
 * @property {string} id
 * @property {string} label
 * @property {string} provider
 * @property {string|null} model
 * @property {()=>Promise<boolean>} available  can this backend run right now?
 * @property {(job:object)=>Promise<{ok:boolean, text?:string, candidates?:Array, error?:string}>} runAgent
 * @property {(prompt:string)=>Promise<string>} ask
 */

async function fetchTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const errMsg = (err) => String((err && err.message) || err);

// Wraps a bare `askRaw` (may throw) into the always-safe `ask` + `runAgent` pair every adapter needs.
function makeAdapter({ id, label, provider, model, available, askRaw, listModels }) {
  return {
    id,
    label,
    provider,
    model,
    available,
    listModels: listModels || (async () => [model].filter(Boolean)),
    async ask(prompt) {
      try {
        return await askRaw(prompt);
      } catch (err) {
        return JSON.stringify({ ok: false, error: errMsg(err) });
      }
    },
    async runAgent(job = {}) {
      try {
        if (!(await available())) return { ok: false, error: `${id} not available` };
        const prompt = job.prompt || `Role: ${job.role || 'agent'}\nTask: ${JSON.stringify(job)}`;
        const text = await askRaw(prompt);
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: errMsg(err) };
      }
    },
  };
}

// --- rules: the always-on, zero-config default. Real work happens in the deterministic assess engine. ---
const rules = {
  id: 'rules',
  label: 'Rules engine (no LLM)',
  provider: 'rules',
  model: null,
  async available() { return true; },
  async listModels() { return []; },
  async ask() {
    return JSON.stringify({ ok: true, note: 'rules engine has no LLM — the deterministic assess engine does the real work' });
  },
  async runAgent(job = {}) {
    return { ok: true, text: '', candidates: [], note: 'rules engine: no-op, deterministic assess engine performs the real work', job: job.id ?? null };
  },
};

// --- ollama: local models over the Ollama HTTP API. ---
const ollamaBase = () => process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

async function ollamaProbe() {
  try {
    const res = await fetchTimeout(`${ollamaBase()}/api/tags`, {}, 800);
    if (!res.ok) return { available: false, models: [] };
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

async function ollamaAskRaw(prompt) {
  const { models } = await ollamaProbe();
  const model = process.env.OLLAMA_MODEL || models[0];
  if (!model) throw new Error('no ollama model available (is Ollama running with a model pulled?)');
  const res = await fetchTimeout(`${ollamaBase()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  }, 15000);
  if (!res.ok) throw new Error(`ollama generate failed: ${res.status}`);
  const data = await res.json();
  return data.response || '';
}

const ollama = makeAdapter({
  id: 'ollama',
  label: 'Ollama (local)',
  provider: 'ollama',
  model: process.env.OLLAMA_MODEL || null,
  available: async () => (await ollamaProbe()).available,
  listModels: async () => (await ollamaProbe()).models,
  askRaw: ollamaAskRaw,
});

// --- openai: OpenAI-compatible chat completions (also serves Kimi/others via OPENAI_BASE_URL). ---
async function openaiAskRaw(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetchTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
  }, 15000);
  if (!res.ok) throw new Error(`openai chat completion failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const openai = makeAdapter({
  id: 'openai',
  label: 'OpenAI-compatible',
  provider: 'openai',
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  available: async () => !!process.env.OPENAI_API_KEY,
  askRaw: openaiAskRaw,
});

// --- anthropic: Messages API called directly over fetch (no Agent SDK dependency). ---
async function anthropicAskRaw(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  const res = await fetchTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  }, 15000);
  if (!res.ok) throw new Error(`anthropic messages failed: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

const anthropic = makeAdapter({
  id: 'anthropic',
  label: 'Anthropic',
  provider: 'anthropic',
  model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
  available: async () => !!process.env.ANTHROPIC_API_KEY,
  askRaw: anthropicAskRaw,
});

const REGISTRY = new Map([
  ['rules', rules],
  ['ollama', ollama],
  ['openai', openai],
  ['anthropic', anthropic],
]);

// Register a backend (or override a built-in one).
export function register(adapter) { REGISTRY.set(adapter.id, adapter); return adapter; }

// Unknown ids fall back to 'rules' — selection must always work with zero config.
export function getAdapter(id = 'rules') {
  return REGISTRY.get(id) || REGISTRY.get('rules');
}

export function listAdapters() { return [...REGISTRY.keys()]; }

// Backs the UI model selector: fast (one short-timeout ollama probe), never throws, never hangs.
export async function listEngines() {
  const ollamaState = await ollamaProbe();
  const entries = [
    { id: 'rules', label: rules.label, provider: rules.provider, model: rules.model, models: [], available: true },
    {
      id: 'ollama',
      label: ollama.label,
      provider: ollama.provider,
      model: process.env.OLLAMA_MODEL || ollamaState.models[0] || null,
      models: ollamaState.models,
      available: ollamaState.available,
    },
    { id: 'openai', label: openai.label, provider: openai.provider, model: openai.model, models: [openai.model], available: !!process.env.OPENAI_API_KEY },
    { id: 'anthropic', label: anthropic.label, provider: anthropic.provider, model: anthropic.model, models: [anthropic.model], available: !!process.env.ANTHROPIC_API_KEY },
  ];
  const firstAvailable = entries.find((e) => e.id !== 'rules' && e.available);
  const defaultId = firstAvailable ? firstAvailable.id : 'rules';
  return entries.map((e) => ({ ...e, default: e.id === defaultId }));
}
