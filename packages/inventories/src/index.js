// @secforge/inventories — deterministic inventory extraction (no LLM). Runs every plugin whose detect()
// matches the repo profile, plus the universal fallback extractor and the schema-first GraphQL SDL extractor,
// merges the 11 raw file:line inventory lists, and reports coverage meta (which source files ended up
// represented, which plugins fired). This is the raw ROW layer only — never graph nodes, never identity.
import { Registry, INVENTORY_KEYS } from './plugins.js';
import { isCodeFile, profileRepo } from './profiler.js';
import { buildContext, universalInventory } from './universal.js';
import { railsPlugin } from './rails.js';
import { djangoDrfPlugin } from './django-drf.js';
import { graphqlSdlInventory } from './graphql-sdl.js';

export { profileRepo, isCodeFile, INVENTORY_KEYS };

export function builtinRegistry() {
  return new Registry()
    .register(railsPlugin)
    .register(djangoDrfPlugin);
}

// Merge every matching plugin's 11 lists + the universal fallback + the GraphQL SDL extractor; dedup identical
// file:line:entry rows. If the language-specific plugins produced no feature-bearing rows (an unsupported
// stack), the universal extractor still produces a real, cited map instead of returning zero features.
export function extractInventories({ sourceRoot, profile, registry = builtinRegistry() }) {
  const ctx = buildContext(sourceRoot);
  const merged = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));
  const seen = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, new Set()]));
  const absorb = (inv, pluginId) => {
    for (const key of INVENTORY_KEYS) for (const it of inv[key] || []) {
      const sig = `${it.file}:${it.line}:${it.entry}`;
      if (seen[key].has(sig)) continue;
      seen[key].add(sig); merged[key].push({ ...it, plugin: pluginId });
    }
  };

  const matched = registry.match(profile);
  for (const plugin of matched) absorb(plugin.inventory(ctx) || {}, plugin.id);

  const universal = universalInventory(ctx);
  const specializedFiles = new Set(INVENTORY_KEYS.flatMap((k) => merged[k].map((r) => r.file)));
  // A specialized plugin adds PRECISION for the files it represented — it does not claim every file in its
  // language. Universal source-module anchors still cover any file the plugin left unrepresented.
  const needsUniversal = (row) => row.detail === 'openapi' || !specializedFiles.has(row.file);
  for (const key of INVENTORY_KEYS) absorb({ [key]: (universal[key] || []).filter(needsUniversal) }, 'universal');

  absorb({ graphql: graphqlSdlInventory(ctx) }, 'graphql-sdl');

  for (const key of INVENTORY_KEYS) merged[key].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // Coverage reconciles against the frozen snapshot manifest (ctx.files) via the same canonical predicate
  // isCodeFile uses everywhere else.
  const sourceFiles = ctx.files.filter((f) => isCodeFile(f.name) && !ctx.bundled.has(f.path));
  const represented = new Set(INVENTORY_KEYS.flatMap((k) => merged[k].map((r) => r.file)));
  Object.defineProperty(merged, Symbol.for('secforge.inventory.meta'), {
    enumerable: false, value: Object.freeze({
      matched_plugins: matched.map((p) => p.id),
      universal_used: INVENTORY_KEYS.some((k) => merged[k].some((r) => r.plugin === 'universal')),
      source_code_files: sourceFiles.length,
      represented_source_files: sourceFiles.filter((f) => represented.has(f.path)).length,
      unrepresented_source_files: sourceFiles.filter((f) => !represented.has(f.path)).length,
    }),
  });
  return merged;
}

export function inventoryMeta(inventories) {
  return inventories?.[Symbol.for('secforge.inventory.meta')] || {
    matched_plugins: [], universal_used: false,
    source_code_files: 0, represented_source_files: 0, unrepresented_source_files: 0,
  };
}
