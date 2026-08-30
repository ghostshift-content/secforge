// @secforge/orchestration — SecForge's own in-session orchestration: sequences the map and scan
// pipelines that already exist (@secforge/map, @secforge/assess, @secforge/retrieval) and records
// progress onto the session record @secforge/session already owns. Zero external deps, ESM,
// Product-owned — every "agent" here is a plain async function calling getAdapter(engine).ask(...);
// no external agent framework, stdlib + @secforge/* only.
export { runMapOrchestration, makeConsolidator, isLumpedCluster } from './map-orchestrator.js';
export { runScanOrchestration } from './scan-orchestrator.js';
export { subscribe, emit, unsubscribe } from './bus.js';
export { withRetry } from './retry.js';
