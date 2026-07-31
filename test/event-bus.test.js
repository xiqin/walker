'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../src/events/event-bus');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('EventBus publish 异步投递给 listener', async () => {
  const bus = createEventBus();
  const received = [];
  bus.subscribe((event) => received.push(event.type));

  const count = bus.publish({ type: 'session.output' });

  assert.equal(count, 1);
  assert.deepEqual(received, []);
  await wait(10);
  assert.deepEqual(received, ['session.output']);
});

test('EventBus publish 不等待慢 listener', async () => {
  const bus = createEventBus();
  let slowDone = false;
  const received = [];
  bus.subscribe(async () => {
    await wait(50);
    slowDone = true;
  });
  bus.subscribe((event) => received.push(event.type));

  const startedAt = Date.now();
  bus.publish({ type: 'prompt.completed' });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 25);
  await wait(10);
  assert.deepEqual(received, ['prompt.completed']);
  assert.equal(slowDone, false);
  await wait(60);
  assert.equal(slowDone, true);
});

test('EventBus 单 listener 抛错不影响其他 listener 且错误可观察', async () => {
  const observed = [];
  const bus = createEventBus({ onListenerError: (entry) => observed.push(entry) });
  const received = [];
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((event) => received.push(event.type));

  bus.publish({ type: 'error' });
  await wait(10);

  assert.deepEqual(received, ['error']);
  assert.equal(bus.getErrors().length, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].err.message, 'boom');
});

test('EventBus unsubscribe 释放 listener', async () => {
  const bus = createEventBus();
  let count = 0;
  const unsubscribe = bus.subscribe(() => { count += 1; });

  bus.publish({ type: 'first' });
  await wait(10);
  assert.equal(count, 1);
  assert.equal(bus.getListenerCount(), 1);

  assert.equal(unsubscribe(), true);
  assert.equal(bus.getListenerCount(), 0);
  bus.publish({ type: 'second' });
  await wait(10);
  assert.equal(count, 1);
});
