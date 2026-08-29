// @secforge/adapters — engine backends behind one interface. The only external "engine".
// Every backend normalises to the same job/result envelope so the pipeline is provider-agnostic.
// Node stdlib + global fetch only. No SDKs — every provider is called over its plain HTTP API.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

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
    analysis: 'llm', // wraps a real askRaw that calls a working backend
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
  analysis: 'rules-only',
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
  }, 60000);
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

// --- provider connection detection: has the user logged in / configured this SDK? ---
function onPath(bin) { try { return spawnSync('which', [bin], { timeout: 1500 }).status === 0; } catch { return false; } }
function homeHas(...p) { try { return existsSync(join(homedir(), ...p)); } catch { return false; } }

// `analysis` reports what a CONNECTED provider actually does to results, separate from `connected`
// (signed-in / reachable). 'llm' = askRaw genuinely calls a working backend; 'rules-only' = ask() is
// a no-op in this build, so results are byte-identical to the deterministic rules engine.
const CONNECTORS = {
  'claude-code': {
    label: 'Claude Code', models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    analysis: 'rules-only',
    howToConnect: 'run: claude  (and log in)',
    check() {
      if (process.env.ANTHROPIC_API_KEY) return { connected: true, detail: 'ANTHROPIC_API_KEY set' };
      if (homeHas('.claude', '.credentials.json') || homeHas('.claude', 'credentials.json')) return { connected: true, detail: 'Claude Code login found' };
      if (onPath('claude')) return { connected: true, detail: 'claude CLI on PATH' };
      return { connected: false, detail: 'not logged in — run: claude' };
    },
  },
  codex: {
    label: 'Codex (OpenAI)', models: ['gpt-5-codex', 'gpt-5', 'o4-mini', 'codex-mini-latest'],
    analysis: 'rules-only',
    howToConnect: 'run: codex login',
    check() {
      if (homeHas('.codex', 'auth.json')) return { connected: true, detail: 'found ~/.codex/auth.json' };
      if (onPath('codex')) return { connected: true, detail: 'codex CLI on PATH' };
      if (process.env.OPENAI_API_KEY) return { connected: true, detail: 'OPENAI_API_KEY set' };
      return { connected: false, detail: 'not logged in — run: codex login' };
    },
  },
  gemini: {
    label: 'Gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    analysis: 'rules-only',
    howToConnect: 'run: gemini  (and log in)',
    check() {
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return { connected: true, detail: 'Gemini/Google API key set' };
      if (homeHas('.gemini')) return { connected: true, detail: '~/.gemini found' };
      if (onPath('gemini')) return { connected: true, detail: 'gemini CLI on PATH' };
      return { connected: false, detail: 'not logged in — run: gemini' };
    },
  },
  ollama: {
    label: 'Ollama (local)', models: [], analysis: 'llm', howToConnect: 'start Ollama: ollama serve',
    async check() { const s = await ollamaProbe(); return { connected: s.available, detail: s.available ? `running · ${s.models.length} models` : 'not running — start: ollama serve', models: s.models }; },
  },
  openai: {
    label: 'OpenAI API (key)', models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], analysis: 'llm', howToConnect: 'set OPENAI_API_KEY',
    check() { return process.env.OPENAI_API_KEY ? { connected: true, detail: 'OPENAI_API_KEY set' } : { connected: false, detail: 'set OPENAI_API_KEY' }; },
  },
  anthropic: {
    label: 'Anthropic API (key)', models: ['claude-opus-4-8', 'claude-sonnet-5'], analysis: 'llm', howToConnect: 'set ANTHROPIC_API_KEY',
    check() { return process.env.ANTHROPIC_API_KEY ? { connected: true, detail: 'ANTHROPIC_API_KEY set' } : { connected: false, detail: 'set ANTHROPIC_API_KEY' }; },
  },
};

// Per-provider connection status (used by the UI to enable/disable and label each option).
export async function checkConnection(id) {
  if (id === 'rules') return { id, connected: true, analysis: 'rules-only', detail: 'always available — deterministic, no AI' };
  const c = CONNECTORS[id];
  if (!c) return { id, connected: false, analysis: 'rules-only', detail: 'unknown provider' };
  try { const r = await c.check(); return { id, connected: !!r.connected, analysis: c.analysis, detail: r.detail || '' }; }
  catch { return { id, connected: false, analysis: c.analysis, detail: 'connection check failed' }; }
}

// A CLI-SDK adapter (claude-code / codex / gemini): connection is real; non-interactive analysis
// is not wired in this build, so ask() is a safe no-op and the deterministic engine runs.
// ask()/runAgent() return a structured { ok:false, unwired:true } so callers can detect the no-op
// rather than mistake a canned string for a real answer (analysis:'rules-only' says so up front).
function cliAdapter(id) {
  const c = CONNECTORS[id];
  const noop = () => ({ ok: false, unwired: true, analysis: 'rules-only', error: `${id}: connected, but non-interactive model calls are not wired in this build` });
  return {
    id, label: c.label, provider: id, model: c.models[0] || null, analysis: c.analysis,
    async available() { return (await checkConnection(id)).connected; },
    async listModels() { return c.models; },
    async ask() { return noop(); },
    async runAgent() { return noop(); },
  };
}

const REGISTRY = new Map([
  ['rules', rules],
  ['claude-code', cliAdapter('claude-code')],
  ['codex', cliAdapter('codex')],
  ['gemini', cliAdapter('gemini')],
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

// Backs the UI provider picker: every provider with its live connection status + models.
// Fast (bounded probes), never throws, never hangs. Default is the deterministic 'rules' engine
// unless SECFORGE_DEFAULT_ENGINE names a CONNECTED provider — nothing is force-selected.
export async function listEngines() {
  const order = ['claude-code', 'codex', 'gemini', 'ollama', 'openai', 'anthropic'];
  const out = [{ id: 'rules', label: 'No AI — rules only (fast, deterministic)', provider: 'rules', connected: true, analysis: 'rules-only', howToConnect: '', models: [], model: null }];
  for (const id of order) {
    const c = CONNECTORS[id];
    let r;
    try { r = await c.check(); } catch { r = { connected: false, detail: '' }; }
    const models = (r.models && r.models.length) ? r.models : c.models;
    out.push({ id, label: c.label, provider: id, connected: !!r.connected, analysis: c.analysis, howToConnect: c.howToConnect, models, model: models[0] || null });
  }
  const pref = process.env.SECFORGE_DEFAULT_ENGINE;
  const defaultId = (pref && out.some((e) => e.id === pref && e.connected)) ? pref : 'rules';
  return out.map((e) => ({ ...e, default: e.id === defaultId }));
}
