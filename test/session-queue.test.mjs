import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionQueue } from '../src/session-queue.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.equal(predicate(), true);
}

test('同一会话串行处理，不同会话可以并行', async () => {
  const started = [];
  const release = new Map();
  const q = new SessionQueue({
    maxConcurrent: 2,
    maxQueued: 10,
    getKey: (item) => item.session,
  });
  const handler = async (item) => {
    started.push(item.id);
    await new Promise((resolve) => release.set(item.id, resolve));
  };

  assert.equal(q.enqueue({ id: 'a1', session: 'same' }, handler), true);
  assert.equal(q.enqueue({ id: 'a2', session: 'same' }, handler), true);
  assert.equal(q.enqueue({ id: 'b1', session: 'other' }, handler), true);

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['a1', 'b1']);
  assert.equal(q.inFlight, 2);
  assert.equal(q.pendingCount(), 1);

  release.get('a1')();
  await waitFor(() => started.includes('a2'));
  assert.deepEqual(started, ['a1', 'b1', 'a2']);

  release.get('a2')();
  release.get('b1')();
  await waitFor(() => q.inFlight === 0);
});
