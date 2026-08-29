// @secforge/map — the mapping engine. Phase 1 vendors codengram (snapshot → inventory →
// Lead-derived features → evidence-validate → index.sqlite → phase1-maps), guards removed.
// This skeleton exposes the contract the Map tab consumes so the wiring is real today.

/**
 * Map a project into the knowledge base. Phase 1 replaces the body with the codengram engine.
 * @returns {Promise<{status:string, features:Array, coverage:object}>}
 */
export async function mapProject({ sourceRoot, onProgress } = {}) {
  onProgress?.({ phase: 'snapshot', pct: 0 });
  // ponytail: stubbed until codengram is vendored; returns the shape the UI/graph expect.
  return {
    status: 'STUB_NOT_MAPPED',
    sourceRoot,
    features: [],
    coverage: { technical: 0, semantic: 0, gate: 'blocked' },
    note: 'map engine stub — codengram vendored in Phase 1',
  };
}

export function featureGraph(/* featureId */) {
  return { nodes: [], edges: [], note: 'graph projection stub' };
}
