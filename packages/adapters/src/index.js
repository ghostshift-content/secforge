// @secforge/adapters — engine backends behind one interface. The only external "engine".
// Every backend normalises to the same job/result envelope so the pipeline is provider-agnostic.
// Node stdlib + global fetch only. No SDKs — every provider is called over its plain HTTP API.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

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

// Effort is a recorded, best-effort knob (docs/PHASE4-ENV-PROVIDER-DESIGN.md §2). Its one real,
// verifiable effect in this codebase is the per-call token budget for the HTTP-based LLM
// adapters below. It is INERT (recorded only, changes nothing) for the deterministic rules
// engine, for the still-unwired gemini CLI adapter, and for the CLI adapters that ARE wired
// (codex/claude-code) — their askRaw takes only prompt+model, no token-budget knob — never
// claim otherwise.
export const EFFORT_BUDGETS = { low: 512, medium: 1024, high: 2048, max: 4096 };
export function effortBudget(effort) { return EFFORT_BUDGETS[effort] || EFFORT_BUDGETS.medium; }

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
    // Root-cause fix (PHASE4 §2.3): opts was silently dropped here, so a chosen model/effort
    // never reached openai/anthropic/ollama. Forwarding opts is what makes both real.
    async ask(prompt, opts = {}) {
      try {
        return await askRaw(prompt, opts);
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

async function ollamaAskRaw(prompt, opts = {}) {
  const { models } = await ollamaProbe();
  const model = opts.model || process.env.OLLAMA_MODEL || models[0];
  if (!model) throw new Error('no ollama model available (is Ollama running with a model pulled?)');
  const res = await fetchTimeout(`${ollamaBase()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: effortBudget(opts.effort) } }),
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
async function openaiAskRaw(prompt, opts = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const res = await fetchTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: effortBudget(opts.effort) }),
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
async function anthropicAskRaw(prompt, opts = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
  const res = await fetchTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: effortBudget(opts.effort), messages: [{ role: 'user', content: prompt }] }),
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

// --- codex: real backend over the Codex CLI (`codex exec`), read-only + non-interactive. ---
// The user's configured model lives in ~/.codex/config.toml; we surface it first so their real
// model (e.g. gpt-daybreak-blue-latest) is selectable, then a known set.
const CODEX_KNOWN_MODELS = ['gpt-5-codex', 'gpt-5', 'o4-mini', 'codex-mini-latest'];
function codexConfigModel() {
  try {
    const txt = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    const m = txt.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}
function codexModels() {
  const list = [];
  const cfg = codexConfigModel();
  if (cfg) list.push(cfg);
  for (const k of CODEX_KNOWN_MODELS) if (!list.includes(k)) list.push(k);
  return list;
}
// One non-interactive, read-only Codex run. Never lets Codex touch the tree (sandbox read-only);
// captures only the model's final message. Bounded by its own timeout; throws on failure.
function codexAskRaw(prompt, model) {
  return new Promise((resolve, reject) => {
    const out = join(tmpdir(), `secforge-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', out];
    if (model) args.push('-m', model);
    args.push(String(prompt));
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); try { unlinkSync(out); } catch { /* best effort */ } fn(arg); };
    const cp = spawn('codex', args, { cwd: tmpdir(), stdio: 'ignore' });
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* ignore */ } finish(reject, new Error('codex exec timed out')); }, 180000);
    cp.on('error', (e) => finish(reject, e));
    cp.on('exit', (code) => {
      if (done) return;
      let text = '';
      try { text = readFileSync(out, 'utf8'); } catch { /* no output file */ }
      if (code === 0) finish(resolve, text);
      else finish(reject, new Error(`codex exec exited ${code}`));
      // note: finish() also unlinks; read happened above before unlink
    });
  });
}
const codex = {
  id: 'codex', label: 'Codex (OpenAI)', provider: 'codex',
  model: codexModels()[0] || null, analysis: 'llm',
  async available() { return (await checkConnection('codex')).connected; },
  async listModels() { return codexModels(); },
  agentic: true,
  async explore(opts = {}) { try { return await codexExploreRaw({ ...opts, model: opts.model || this.model }); } catch (err) { return { ok: false, error: errMsg(err) }; } },
  async ask(prompt, opts = {}) {
    try { return await codexAskRaw(prompt, opts.model || this.model); }
    catch (err) { return JSON.stringify({ ok: false, error: errMsg(err) }); }
  },
  async runAgent(job = {}) {
    try {
      if (!(await this.available())) return { ok: false, error: 'codex not available' };
      const prompt = job.prompt || `Role: ${job.role || 'agent'}\nTask: ${JSON.stringify(job)}`;
      return { ok: true, text: await codexAskRaw(prompt, job.model) };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

// --- claude-code: real backend over the Claude Code CLI (`claude -p`), non-interactive + tool-less. ---
// SecForge lists claude-opus-4-8 first, but sonnet is the speed/cost-sensible default for analysis calls.
const CLAUDE_KNOWN_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5';
// One non-interactive Claude Code run. Prompt goes over stdin (avoids ARG_MAX on large prompts,
// unlike codex's arg-based prompt). `--tools=` + `--strict-mcp-config` + `--setting-sources ''`
// disable every built-in/MCP tool and project config, so this is a pure text completion — it
// never touches the filesystem (cwd: tmpdir() is belt-and-suspenders on top of that). Bounded by
// its own timeout; throws on failure.
function claudeAskRaw(prompt, model) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text', '--tools=', '--strict-mcp-config', '--setting-sources', ''];
    args.push('--model', model || CLAUDE_DEFAULT_MODEL);
    let out = '';
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const cp = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* ignore */ } finish(reject, new Error('claude -p timed out')); }, 180000);
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('error', (e) => finish(reject, e));
    cp.on('exit', (code) => {
      if (code === 0) finish(resolve, out);
      else finish(reject, new Error(`claude -p exited ${code}`));
    });
    cp.stdin.write(String(prompt));
    cp.stdin.end();
  });
}
// --- agentic, READ-ONLY exploration (the mapping Lead) ---------------------------------------
// explore({prompt, cwd, model, maxTurns, schema}) runs the CLI with ONLY Read/Glob/Grep enabled, cwd
// pinned to the directory the caller passes (SecForge passes the FROZEN snapshot's source dir), a
// turn cap, and a JSON schema the final answer must satisfy. Returns {ok, structured, text,
// sessionId, turns, cost} or {ok:false, error}. Never throws. This is the only place an engine may
// read files; it still cannot write, run, or reach the network from inside the sandboxed tree.
const LEAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.SECFORGE_LEAD_TIMEOUT_MS) || 900_000);
function claudeExploreRaw({ prompt, cwd, model, maxTurns = 28, schema = null }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep',
      '--disallowedTools', 'Write', 'Edit', 'Bash', 'NotebookEdit', 'Agent', 'WebFetch', 'WebSearch',
      '--permission-mode', 'default', '--max-turns', String(maxTurns), '--strict-mcp-config', '--setting-sources', '',
      '--model', model || CLAUDE_DEFAULT_MODEL];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    let out = '', err = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    let cp;
    try { cp = spawn('claude', args, { cwd: cwd || tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: errMsg(e) }); }
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* ignore */ } finish({ ok: false, error: 'claude explore timed out' }); }, LEAD_TIMEOUT_MS);
    cp.stdout.on('data', (d) => { out += d; });
    cp.stderr.on('data', (d) => { err += d; });
    cp.on('error', (e) => finish({ ok: false, error: errMsg(e) }));
    cp.on('exit', (code) => {
      let j = null; try { j = JSON.parse(out); } catch { /* not json */ }
      if (code !== 0 || !j) return finish({ ok: false, error: `claude explore exited ${code}: ${(err || out).slice(0, 300)}` });
      if (j.is_error) return finish({ ok: false, error: `claude explore error: ${String(j.result || j.subtype).slice(0, 300)}` });
      finish({ ok: true, structured: j.structured_output ?? null, text: typeof j.result === 'string' ? j.result : '', sessionId: j.session_id || null, turns: j.num_turns ?? null, cost: j.total_cost_usd ?? null });
    });
    cp.stdin.write(String(prompt));
    cp.stdin.end();
  });
}
// Codex parity: read-only sandbox, cwd pinned, schema-enforced last message written to a temp file.
function codexExploreRaw({ prompt, cwd, model, schema = null }) {
  return new Promise((resolve) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const out = join(tmpdir(), `secforge-codex-explore-${stamp}.txt`);
    const schemaFile = join(tmpdir(), `secforge-codex-schema-${stamp}.json`);
    const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', out];
    if (schema) { try { writeFileSync(schemaFile, JSON.stringify(schema)); args.push('--output-schema', schemaFile); } catch { /* best effort */ } }
    if (model) args.push('-m', model);
    args.push(String(prompt));
    let done = false;
    const cleanup = () => { for (const f of [out, schemaFile]) { try { unlinkSync(f); } catch { /* best effort */ } } };
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); cleanup(); resolve(v); };
    let cp;
    try { cp = spawn('codex', args, { cwd: cwd || tmpdir(), stdio: 'ignore' }); }
    catch (e) { return finish({ ok: false, error: errMsg(e) }); }
    const timer = setTimeout(() => { try { cp.kill('SIGKILL'); } catch { /* ignore */ } finish({ ok: false, error: 'codex explore timed out' }); }, LEAD_TIMEOUT_MS);
    cp.on('error', (e) => finish({ ok: false, error: errMsg(e) }));
    cp.on('exit', (code) => {
      let text = ''; try { text = readFileSync(out, 'utf8'); } catch { /* no output */ }
      if (code !== 0) return finish({ ok: false, error: `codex explore exited ${code}` });
      let structured = null; try { structured = JSON.parse(text); } catch { /* prose */ }
      finish({ ok: true, structured, text, sessionId: null, turns: null, cost: null });
    });
  });
}

const claudeCode = {
  id: 'claude-code', label: 'Claude Code', provider: 'claude-code',
  model: CLAUDE_DEFAULT_MODEL, analysis: 'llm',
  async available() { return (await checkConnection('claude-code')).connected; },
  async listModels() { return CLAUDE_KNOWN_MODELS; },
  agentic: true,
  async explore(opts = {}) { try { return await claudeExploreRaw({ ...opts, model: opts.model || this.model }); } catch (err) { return { ok: false, error: errMsg(err) }; } },
  async ask(prompt, opts = {}) {
    try { return await claudeAskRaw(prompt, opts.model || this.model); }
    catch (err) { return JSON.stringify({ ok: false, error: errMsg(err) }); }
  },
  async runAgent(job = {}) {
    try {
      if (!(await this.available())) return { ok: false, error: 'claude-code not available' };
      const prompt = job.prompt || `Role: ${job.role || 'agent'}\nTask: ${JSON.stringify(job)}`;
      return { ok: true, text: await claudeAskRaw(prompt, job.model) };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

// --- provider connection detection: has the user logged in / configured this SDK? ---
function onPath(bin) { try { return spawnSync('which', [bin], { timeout: 1500 }).status === 0; } catch { return false; } }
function homeHas(...p) { try { return existsSync(join(homedir(), ...p)); } catch { return false; } }

// `analysis` reports what a CONNECTED provider actually does to results, separate from `connected`
// (signed-in / reachable). 'llm' = askRaw genuinely calls a working backend; 'rules-only' = ask() is
// a no-op in this build, so results are byte-identical to the deterministic rules engine.
const CONNECTORS = {
  'claude-code': {
    label: 'Claude Code', models: CLAUDE_KNOWN_MODELS,
    analysis: 'llm', // wired: runs `claude -p` non-interactively (tools disabled)
    howToConnect: 'run: claude  (and log in)',
    check() {
      if (process.env.ANTHROPIC_API_KEY) return { connected: true, detail: 'ANTHROPIC_API_KEY set' };
      if (homeHas('.claude', '.credentials.json') || homeHas('.claude', 'credentials.json')) return { connected: true, detail: 'Claude Code login found' };
      if (onPath('claude')) return { connected: true, detail: 'claude CLI on PATH' };
      return { connected: false, detail: 'not logged in — run: claude' };
    },
  },
  codex: {
    label: 'Codex (OpenAI)', get models() { return codexModels(); },
    analysis: 'llm', // wired: runs `codex exec` non-interactively (read-only sandbox)
    howToConnect: 'run: codex login',
    check() {
      const models = codexModels();
      if (homeHas('.codex', 'auth.json')) return { connected: true, detail: 'found ~/.codex/auth.json', models };
      if (onPath('codex')) return { connected: true, detail: 'codex CLI on PATH', models };
      if (process.env.OPENAI_API_KEY) return { connected: true, detail: 'OPENAI_API_KEY set', models };
      return { connected: false, detail: 'not logged in — run: codex login', models };
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

// A still-unwired CLI-SDK adapter (gemini): connection is real; non-interactive analysis is not
// wired in this build, so ask() is a safe no-op and the deterministic engine runs. codex and
// claude-code have graduated out of this helper — they're real adapters defined above.
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
  ['claude-code', claudeCode],
  ['codex', codex],
  ['gemini', cliAdapter('gemini')],
  ['ollama', ollama],
  ['openai', openai],
  ['anthropic', anthropic],
]);

// Register a backend (or override a built-in one).
export function register(adapter) { REGISTRY.set(adapter.id, adapter); return adapter; }

// Exported so a test (or a future backend) can build a real adapter the same way openai/
// anthropic/ollama do above, instead of hand-rolling the ask()/runAgent() safety wrapper.
export { makeAdapter };

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
    out.push({ id, label: c.label, provider: id, connected: !!r.connected, analysis: c.analysis, agentic: !!(REGISTRY.get(id) && REGISTRY.get(id).agentic), howToConnect: c.howToConnect, models, model: models[0] || null });
  }
  const pref = process.env.SECFORGE_DEFAULT_ENGINE;
  const defaultId = (pref && out.some((e) => e.id === pref && e.connected)) ? pref : 'rules';
  return out.map((e) => ({ ...e, default: e.id === defaultId }));
}
