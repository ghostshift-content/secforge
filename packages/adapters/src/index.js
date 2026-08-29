// @secforge/adapters — engine backends behind one interface. The only external "engine".
// Every backend normalises to the same job/result envelope so the pipeline is provider-agnostic.

/**
 * @typedef {Object} EngineAdapter
 * @property {string} id
 * @property {(job:object)=>Promise<object>} runAgent  run one agent job → result
 * @property {(query:string)=>Promise<string>} ask     cited Q&A over the store
 * @property {()=>Promise<boolean>} available           can this backend run right now?
 */

// Default backend: Claude Agent SDK (auth via the user's local Claude login).
// Stub for now — Phase 4 wires @anthropic-ai/claude-agent-sdk. Returns a shaped placeholder.
const claudeCode = {
  id: 'claude-code',
  async available() { return true; },
  async runAgent(job) {
    return { job: job.id, role: job.role, ok: true, note: 'stub adapter — SDK wired in Phase 4', candidates: [] };
  },
  async ask() { return 'stub adapter — no engine wired yet'; },
};

const REGISTRY = new Map([['claude-code', claudeCode]]);

// Register a backend (codex | kimi | ollama | gemini …).
export function register(adapter) { REGISTRY.set(adapter.id, adapter); return adapter; }

export function getAdapter(id = 'claude-code') {
  const a = REGISTRY.get(id);
  if (!a) throw new Error(`unknown engine adapter: ${id}`);
  return a;
}

export function listAdapters() { return [...REGISTRY.keys()]; }
