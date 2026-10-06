// Failure injection: channel delivery, crash/restart recovery and SQLite faults.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ModelRequest } from '../src/contracts/index.ts';
import { openDb } from '../src/store/index.ts';
import { msg, setup } from './fixtures.ts';
import { tempDir } from './helpers.ts';

/** A gateway clock that runs ahead of the real time used when queueing, and that tests advance by hand. */
function clock() {
  let t = Date.now() + 60_000;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const settle = async (t: ReturnType<typeof setup>) => {
  await t.lanes.idle();
  await t.gateway.deliver();
};

const paired = (t: ReturnType<typeof setup>) => t.store.addIdentity('fake', 'u1', 'Ada');

test('a transient send failure is retried with backoff and delivered exactly once', async () => {
  const c = clock();
  const t = setup([{ text: 'hello' }], { gateway: { now: c.now } });
  paired(t);
  await t.gateway.start();
  t.channel.failures.push({ status: 'failed', retryable: true, error: 'ECONNRESET' }, { status: 'failed', retryable: true, error: '503' });
  await t.channel.sink!(msg('hi'));
  await settle(t);
  assert.equal(t.channel.sent.length, 0);
  const pending = t.store.outboxByStatus('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.attempts, 1);
  assert.equal(pending[0]!.lastError, 'ECONNRESET');

  await t.gateway.deliver();
  assert.equal(t.channel.sent.length, 0, 'not due yet: backoff is respected');
  c.advance(2_500);
  await t.gateway.deliver();
  assert.equal(t.store.outboxByStatus('pending')[0]!.attempts, 2);
  c.advance(10_000);
  await t.gateway.deliver();
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.map((m) => m.text), ['hello'], 'delivered exactly once');
  assert.equal(t.store.outboxByStatus('sent').length, 1);
  assert.equal(t.store.outboxByStatus('pending').length, 0);
  assert.equal(t.model.requests.length, 1, 'redelivery never re-runs the task');
  await t.gateway.stop(0);
});

test('a permanently failing channel gives up after the attempt cap instead of looping forever', async () => {
  const c = clock();
  const t = setup([{ text: 'x' }], { gateway: { now: c.now, maxDeliveryAttempts: 3 } });
  paired(t);
  await t.gateway.start();
  let calls = 0;
  t.channel.send = async () => {
    calls++;
    return { status: 'failed', retryable: true, error: 'still down' };
  };
  await t.channel.sink!(msg('hi'));
  await settle(t);
  for (let i = 0; i < 10; i++) {
    c.advance(700_000);
    await t.gateway.deliver();
  }
  assert.equal(calls, 3, 'stops at the attempt cap');
  const failed = t.store.outboxByStatus('failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.lastError, 'still down');
  assert.equal(t.store.outboxByStatus('pending').length, 0);
  assert.equal(t.gateway.health().outbox.failed, 1);
  await t.gateway.stop(0);
});

test('a non-retryable send failure fails immediately without retrying', async () => {
  const c = clock();
  const t = setup([{ text: 'x' }], { gateway: { now: c.now } });
  paired(t);
  await t.gateway.start();
  let calls = 0;
  t.channel.send = async () => {
    calls++;
    return { status: 'failed', retryable: false, error: 'bot was blocked by the user' };
  };
  await t.channel.sink!(msg('hi'));
  await settle(t);
  c.advance(3_600_000);
  await t.gateway.deliver();
  assert.equal(calls, 1);
  assert.equal(t.store.outboxByStatus('failed')[0]!.lastError, 'bot was blocked by the user');
  await t.gateway.stop(0);
});

test('a send reported as possibly delivered is marked uncertain and never resent', async () => {
  const c = clock();
  const t = setup([{ text: 'x' }], { gateway: { now: c.now } });
  paired(t);
  await t.gateway.start();
  let calls = 0;
  t.channel.send = async () => {
    calls++;
    return { status: 'uncertain', error: 'request timed out after the body was sent' };
  };
  await t.channel.sink!(msg('hi'));
  await settle(t);
  c.advance(3_600_000);
  await t.gateway.deliver();
  await t.gateway.deliver();
  assert.equal(calls, 1, 'not blindly re-sent');
  assert.equal(t.store.outboxByStatus('uncertain').length, 1);
  assert.equal(t.gateway.health().outbox.uncertain, 1);
  await t.gateway.stop(0);
});

test('a send that throws is uncertain, not retried, unless the channel dedupes sends', async () => {
  const c = clock();
  const t = setup([{ text: 'a' }, { text: 'b' }], { gateway: { now: c.now } });
  paired(t);
  await t.gateway.start();
  let calls = 0;
  t.channel.send = async () => {
    calls++;
    throw new Error('socket hang up');
  };
  await t.channel.sink!(msg('one'));
  await settle(t);
  c.advance(3_600_000);
  await t.gateway.deliver();
  assert.equal(calls, 1);
  assert.equal(t.store.outboxByStatus('uncertain')[0]!.lastError, 'socket hang up');

  // With platform-side dedupe a resend is safe, so the same fault is retried.
  (t.channel as { capabilities: unknown }).capabilities = { maxMessageChars: 4096, dedupesSends: true, typingIndicator: false };
  await t.channel.sink!(msg('two'));
  await settle(t);
  assert.equal(calls, 2);
  assert.equal(t.store.outboxByStatus('pending').length, 1);
  assert.equal(t.store.outboxByStatus('uncertain').length, 1);
  await t.gateway.stop(0);
});

test('a send that hangs past the timeout is uncertain and does not block later deliveries', async () => {
  const t = setup([{ text: 'a' }, { text: 'b' }], { gateway: { sendTimeoutMs: 5, now: () => new Date(Date.now() + 60_000) } });
  paired(t);
  await t.gateway.start();
  const real = t.channel.send.bind(t.channel);
  let first = true;
  t.channel.send = (m) => {
    if (first) {
      first = false;
      return new Promise(() => {}); // never settles
    }
    return real(m);
  };
  await t.channel.sink!(msg('one'));
  await settle(t);
  assert.equal(t.store.outboxByStatus('uncertain').length, 1);
  assert.match(t.store.outboxByStatus('uncertain')[0]!.lastError!, /may or may not/);
  await t.channel.sink!(msg('two'));
  await settle(t);
  assert.deepEqual(t.channel.sent.map((m) => m.text), ['b']);
  await t.gateway.stop(0);
});

test('a crash during a send leaves it uncertain (no dedupe) or retried (dedupe)', async () => {
  for (const dedupes of [false, true]) {
    const file = `${tempDir()}/garnet.db`;
    const first = setup([], { db: openDb(file) });
    first.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat1', text: 'half-sent' });
    first.store.claimDue(new Date(Date.now() + 1000).toISOString()); // now `sending`; the process dies here
    first.db.close();

    const second = setup([], { db: openDb(file), gateway: { now: () => new Date(Date.now() + 60_000) } });
    (second.channel as { capabilities: unknown }).capabilities = { maxMessageChars: 4096, dedupesSends: dedupes, typingIndicator: false };
    await second.gateway.start();
    await second.gateway.deliver();
    if (dedupes) assert.deepEqual(second.channel.sent.map((m) => m.text), ['half-sent']);
    else {
      assert.equal(second.channel.sent.length, 0, 'not resent blindly');
      assert.equal(second.store.outboxByStatus('uncertain').length, 1);
    }
    await second.gateway.stop(0);
    second.db.close();
  }
});

/** Makes the model block forever, so a "crash" can happen mid-task. */
function blockModel(t: ReturnType<typeof setup>) {
  const original = t.model.stream.bind(t.model);
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  t.model.stream = async function* (req: ModelRequest) {
    started();
    await new Promise(() => {}); // the process dies before the provider answers
    yield* original(req);
  };
  return running;
}

test('a crash mid-task: interrupted work is not replayed, queued work runs once, duplicates are deduped', async () => {
  const file = `${tempDir()}/garnet.db`;
  const first = setup([], { db: openDb(file) });
  paired(first);
  const inFlight = blockModel(first);
  await first.gateway.start();
  const m1 = msg('send the invoice');
  const m2 = msg('also check the weather');
  await first.channel.sink!(m1);
  await inFlight;
  await first.channel.sink!(m2); // queued behind m1 on the same conversation lane
  assert.equal(first.store.inboxByStatus('processing').length, 1);
  assert.equal(first.store.inboxByStatus('pending').length, 1);
  assert.equal(first.sessions.unfinishedTasks().length, 1);
  first.db.close(); // crash

  const second = setup([{ text: 'Weather is fine.' }], { db: openDb(file) });
  await second.gateway.start();
  await second.channel.sink!({ ...m1 }); // the platform redelivers messages we already had
  await second.channel.sink!({ ...m2 });
  await settle(second);

  assert.equal(second.model.requests.length, 1, 'only the queued message ran; the interrupted one was not replayed');
  const lastUser = second.model.requests[0]!.messages.at(-1)!;
  assert.equal(lastUser.role, 'user');
  assert.ok(lastUser.content.some((b) => b.type === 'text' && b.text === 'also check the weather'));
  const texts = second.channel.sent.map((m) => m.text);
  assert.equal(texts.filter((x) => /restarted while working/.test(x)).length, 1, 'the owner is told once');
  assert.equal(texts.filter((x) => x === 'Weather is fine.').length, 1);
  assert.equal(second.store.inboxByStatus('interrupted').length, 1);
  assert.equal(second.store.inboxByStatus('done').length, 1);
  assert.equal(second.sessions.unfinishedTasks().length, 0, 'the orphaned task is closed');

  // A further restart has nothing left to do.
  await second.gateway.stop(0);
  second.db.close();
  const third = setup([], { db: openDb(file) });
  await third.gateway.start();
  await third.channel.sink!({ ...m2 });
  await settle(third);
  assert.equal(third.model.requests.length, 0);
  assert.equal(third.channel.sent.length, 0);
  await third.gateway.stop(0);
  third.db.close();
});

test('a message persisted before the crash but never started is run once after restart', async () => {
  const file = `${tempDir()}/garnet.db`;
  const first = setup([], { db: openDb(file) });
  paired(first);
  const m = msg('remember to buy milk');
  first.store.receive(m); // persisted and acknowledged to the platform, then the process died
  first.db.close();

  const second = setup([{ text: 'Noted.' }], { db: openDb(file) });
  await second.gateway.start();
  await second.channel.sink!({ ...m });
  await settle(second);
  assert.equal(second.model.requests.length, 1);
  assert.deepEqual(second.channel.sent.map((x) => x.text), ['Noted.']);
  await second.gateway.stop(0);
  second.db.close();
});

test('a locked database rejects the inbound message so the channel redelivers it; nothing is lost or duplicated', async () => {
  const file = `${tempDir()}/garnet.db`;
  const t = setup([{ text: 'Got it.' }], { db: openDb(file) });
  paired(t);
  t.db.exec('PRAGMA busy_timeout = 0'); // fail fast instead of waiting 5 s
  await t.gateway.start();

  const other = new DatabaseSync(file); // another process holding the write lock
  other.exec('BEGIN IMMEDIATE');
  const m = msg('hello');
  await assert.rejects(() => t.channel.sink!(m), /locked|busy/i);
  assert.equal(t.model.requests.length, 0);
  other.exec('ROLLBACK');
  other.close();

  await t.channel.sink!({ ...m }); // the channel retries because the sink rejected
  await settle(t);
  assert.equal(t.model.requests.length, 1);
  assert.deepEqual(t.channel.sent.map((x) => x.text), ['Got it.']);
  await t.gateway.stop(0);
});

test('a database fault while delivering leaves the message pending, not lost', async () => {
  const file = `${tempDir()}/garnet.db`;
  const t = setup([], { db: openDb(file) });
  t.db.exec('PRAGMA busy_timeout = 0');
  t.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat1', text: 'important' });
  const other = new DatabaseSync(file);
  other.exec('BEGIN IMMEDIATE');
  await assert.rejects(() => t.gateway.deliver(), /locked|busy/i);
  assert.equal(t.channel.sent.length, 0);
  other.exec('ROLLBACK');
  other.close();
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.map((m) => m.text), ['important']);
  assert.equal(t.store.outboxByStatus('sent').length, 1);
});
