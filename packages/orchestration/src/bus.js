// @secforge/orchestration/bus — an in-process, session-scoped event bus so an SSE route can
// forward a real orchestrator run's live progress instead of replaying a canned animation.
// Same node:events primitive @secforge/orchestrator already uses; no persistence, no queue —
// matches this server's existing single-process model. Not for cross-process/durable delivery.
import { EventEmitter } from 'node:events';

const emitters = new Map(); // sessionId -> EventEmitter

function emitterFor(sessionId) {
  let e = emitters.get(sessionId);
  if (!e) { e = new EventEmitter(); e.setMaxListeners(0); emitters.set(sessionId, e); }
  return e;
}

// Push one event to every subscriber of `sessionId`. Lazily creates the emitter — a publish
// with no subscribers yet is a normal, harmless no-op.
export function emit(sessionId, evt) {
  emitterFor(sessionId).emit('event', evt);
}

// Subscribe to `sessionId`'s events. Returns an unsubscribe function. `cb(evt)` fires for every
// emit() call made after subscribing (no replay/backlog — session.phase on the record itself is
// the resumable source of truth, per the design doc).
export function subscribe(sessionId, cb) {
  const e = emitterFor(sessionId);
  e.on('event', cb);
  return () => unsubscribe(sessionId, cb);
}

// Remove one subscriber. Safe to call more than once or after the emitter was never created.
export function unsubscribe(sessionId, cb) {
  const e = emitters.get(sessionId);
  if (!e) return;
  e.off('event', cb);
  if (e.listenerCount('event') === 0) emitters.delete(sessionId); // ponytail: GC idle emitters, no TTL needed
}
