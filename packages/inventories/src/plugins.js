// @secforge/inventories/plugins — the plugin CONTRACT + registry. Ported near-verbatim from codengram's
// packages/plugins/index.js. A plugin declares what it handles (`detect`) and how it reads the source
// deterministically (`inventory`). Adding a new stack is a new plugin, never a core edit.

// The 11 raw inventory kinds every plugin/extractor fills. Ported from codengram's INVENTORY_FILES
// (schemas/index.js) with the numeric prefixes stripped — @secforge/schemas has no equivalent, so it's
// defined locally here (the single source of truth for this package).
export const INVENTORY_KEYS = Object.freeze([
  'routes_endpoints', 'rest_api', 'graphql', 'workers_jobs',
  'services_finders_policies', 'response_shaping', 'downloads_uploads_exports',
  'search_aggregation', 'tokens_actors', 'processes_ipc', 'datastores_integrations',
]);

// A plugin is a plain object; definePlugin validates + freezes it (fail fast on a malformed plugin).
export function definePlugin(spec) {
  const p = spec || {};
  if (!p.id || typeof p.id !== 'string') throw new Error('plugin needs a string id');
  if (!Array.isArray(p.langs) || !p.langs.length) throw new Error(`plugin ${p.id}: langs must be a non-empty array`);
  if (typeof p.detect !== 'function') throw new Error(`plugin ${p.id}: detect(profile) must be a function`);
  if (typeof p.inventory !== 'function') throw new Error(`plugin ${p.id}: inventory(ctx) must be a function`);
  return Object.freeze({ schema_compat: '0.1.0', ...p });
}

export class Registry {
  constructor() { this._plugins = []; }
  register(plugin) { this._plugins.push(definePlugin(plugin)); return this; }
  all() { return this._plugins.slice(); }
  // Every plugin whose detect() says yes for this repo profile. Deterministic order = registration order.
  match(profile) { return this._plugins.filter((p) => { try { return !!p.detect(profile); } catch { return false; } }); }
}
