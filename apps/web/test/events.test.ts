import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Emitter } from '../src/core/events.ts';

interface TestEvents {
  greet: { name: string };
  ping: undefined;
}

void test('emit delivers the payload to a subscribed listener', () => {
  const bus = new Emitter<TestEvents>();
  const received: { name: string }[] = [];

  bus.on('greet', (payload) => received.push(payload));
  bus.emit('greet', { name: 'Alice' });

  assert.deepEqual(received, [{ name: 'Alice' }]);
});

void test('the returned unsubscribe stops further delivery', () => {
  const bus = new Emitter<TestEvents>();
  const received: { name: string }[] = [];

  const off = bus.on('greet', (payload) => received.push(payload));
  bus.emit('greet', { name: 'first' });
  off();
  bus.emit('greet', { name: 'second' });

  assert.deepEqual(received, [{ name: 'first' }]);
});

void test('a listener that unsubscribes itself during emit does not break iteration for the others', () => {
  const bus = new Emitter<TestEvents>();
  const order: string[] = [];

  let offSelf: () => void = () => undefined;
  offSelf = bus.on('greet', () => {
    order.push('self');
    offSelf();
  });
  bus.on('greet', () => order.push('second'));
  bus.on('greet', () => order.push('third'));

  // The emitter copies the listener set before iterating, so removing a
  // listener mid-emit must not skip or crash on the ones that come after it.
  bus.emit('greet', { name: 'x' });
  assert.deepEqual(order, ['self', 'second', 'third']);

  // And the self-unsubscribed listener really is gone on the next emit.
  order.length = 0;
  bus.emit('greet', { name: 'y' });
  assert.deepEqual(order, ['second', 'third']);
});

void test('a listener that throws does not stop the other listeners from running', () => {
  const bus = new Emitter<TestEvents>();
  const order: string[] = [];
  const originalConsoleError = console.error;
  const loggedErrors: unknown[] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    bus.on('greet', () => {
      order.push('before');
      throw new Error('boom');
    });
    bus.on('greet', () => order.push('after'));

    bus.emit('greet', { name: 'x' });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(order, ['before', 'after']);
  assert.equal(loggedErrors.length, 1);
});

void test('emitting an event with no listeners is a no-op', () => {
  const bus = new Emitter<TestEvents>();

  // Must not throw even though nothing has ever subscribed to "ping".
  assert.doesNotThrow(() => bus.emit('ping', undefined));
});
