import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, emit, unsubscribe } from '../src/bus.js';

describe('bus', () => {
  test('subscribe() receives events emitted for its own sessionId only', () => {
    const seenA = [];
    const seenB = [];
    const unsubA = subscribe('sess-a', (evt) => seenA.push(evt));
    const unsubB = subscribe('sess-b', (evt) => seenB.push(evt));

    emit('sess-a', { stage: 'one' });
    emit('sess-b', { stage: 'two' });
    emit('sess-a', { stage: 'three' });

    assert.deepEqual(seenA, [{ stage: 'one' }, { stage: 'three' }]);
    assert.deepEqual(seenB, [{ stage: 'two' }]);
    unsubA(); unsubB();
  });

  test('unsubscribe() (either the returned function or unsubscribe()) stops further delivery', () => {
    const seen = [];
    const cb = (evt) => seen.push(evt);
    const off = subscribe('sess-c', cb);
    emit('sess-c', { n: 1 });
    off();
    emit('sess-c', { n: 2 });
    assert.deepEqual(seen, [{ n: 1 }]);

    subscribe('sess-d', cb);
    emit('sess-d', { n: 3 });
    unsubscribe('sess-d', cb);
    emit('sess-d', { n: 4 });
    assert.deepEqual(seen, [{ n: 1 }, { n: 3 }]);
  });

  test('emit() with no subscribers is a harmless no-op', () => {
    assert.doesNotThrow(() => emit('nobody-listening', { x: 1 }));
  });

  test('unsubscribe() on an unknown sessionId is a harmless no-op', () => {
    assert.doesNotThrow(() => unsubscribe('never-subscribed', () => {}));
  });
});
