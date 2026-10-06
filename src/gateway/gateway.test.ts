import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msg, setup } from '../../test/fixtures.ts';
import { tempDir } from '../../test/helpers.ts';
import { openDb } from '../store/index.ts';
import { approvePairing } from './index.ts';

const settle = async (t: ReturnType<typeof setup>) => {
  await t.lanes.idle();
  await t.gateway.deliver();
};

test('unknown senders get one pairing code; approval greets them', async () => {
  const t = setup();
  await t.gateway.start();
  await t.channel.sink!(msg('hello'));
  await t.channel.sink!(msg('hello again'));
  await settle(t);
  assert.equal(t.model.requests.length, 0, 'unpaired messages never reach the model');
  assert.equal(t.channel.sent.length, 1);
  const code = /ruby pair approve ([A-Z0-9]{6})/.exec(t.channel.sent[0]!.text)?.[1];
  assert.ok(code);
  assert.equal(approvePairing(t.store, 'nope'), null);
  assert.ok(approvePairing(t.store, code!.toLowerCase()));
  await t.gateway.deliver();
  assert.match(t.channel.sent[1]!.text, /connected/);
  await t.channel.sink!(msg('now?'));
  await settle(t);
  assert.equal(t.model.requests.length, 1);
  await t.gateway.stop(0);
});

test('paired messages run a task, reply durably, and duplicates are ignored', async () => {
  const t = setup([{ text: 'Hi Ada!' }]);
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  const m = msg('hi');
  await t.channel.sink!(m);
  await t.channel.sink!({ ...m }); // platform redelivery
  await settle(t);
  assert.equal(t.model.requests.length, 1);
  assert.equal(t.channel.sent.length, 1);
  assert.equal(t.channel.sent[0]!.text, 'Hi Ada!');
  assert.equal(t.channel.sent[0]!.replyToExternalId, m.externalId);
  assert.equal(t.store.outboxByStatus('sent').length, 1);
  await t.gateway.stop(0);
  assert.ok(t.channel.stopped);
});

test('group chats are ignored', async () => {
  const t = setup();
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  await t.channel.sink!(msg('hi all', { isPrivate: false }));
  await settle(t);
  assert.equal(t.model.requests.length, 0);
  assert.equal(t.channel.sent.length, 0);
  await t.gateway.stop(0);
});

test('/new starts a fresh session; routes link chats into one conversation', async () => {
  const t = setup([{ text: 'a' }, { text: 'b' }, { text: 'c' }], { routes: [{ match: { channel: 'fake' }, conversation: 'personal' }] });
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  await t.channel.sink!(msg('one', { chatId: 'chat1' }));
  await settle(t);
  await t.channel.sink!(msg('two', { chatId: 'chat2' }));
  await settle(t);
  assert.equal(t.model.requests[1]!.messages.length, 3, 'chat2 sees chat1 history through the shared route');
  await t.channel.sink!(msg('/new'));
  await t.channel.sink!(msg('three'));
  await settle(t);
  assert.equal(t.model.requests[2]!.messages.length, 1, 'fresh session after /new');
  await t.gateway.stop(0);
});

test('delivery retries transient failures and gives up on permanent ones', async () => {
  const t = setup([{ text: 'x' }, { text: 'y' }]);
  t.store.addIdentity('fake', 'u1', 'Ada');
  let now = Date.now() + 60_000; // the gateway clock runs ahead of the real time used when queueing
  (t.gateway as unknown as { now: () => Date }).now = () => new Date(now);
  await t.gateway.start();
  t.channel.failures.push({ status: 'failed', retryable: true, error: 'flaky', retryAfterMs: 1000 });
  await t.channel.sink!(msg('a'));
  await settle(t);
  assert.equal(t.channel.sent.length, 0);
  assert.equal(t.store.outboxByStatus('pending').length, 1);
  now += 1500;
  await t.gateway.deliver();
  assert.equal(t.channel.sent.length, 1);
  t.channel.failures.push({ status: 'failed', retryable: false, error: 'blocked' });
  await t.channel.sink!(msg('b'));
  await settle(t);
  assert.equal(t.store.outboxByStatus('failed').length, 1);
  await t.gateway.stop(0);
});

test('restart recovery never replays interrupted work', async () => {
  const file = `${tempDir()}/ruby.db`;
  const first = setup([], { db: openDb(file) });
  first.store.addIdentity('fake', 'u1', 'Ada');
  // Simulate a crash mid-task and mid-send.
  const row = first.store.receive(msg('do something'))!;
  const session = first.sessions.createSession();
  first.store.setInbox(row.id, 'processing', { sessionId: session.id });
  first.sessions.createTask(session.id, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
  first.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat1', text: 'half-sent' });
  first.store.claimDue(new Date(Date.now() + 1000).toISOString());
  first.db.close();

  const second = setup([], { db: openDb(file) });
  await second.gateway.start();
  await settle(second);
  assert.equal(second.model.requests.length, 0, 'interrupted work is not rerun');
  assert.match(second.channel.sent.map((m) => m.text).join('\n'), /restarted while working/);
  assert.equal(second.store.outboxByStatus('uncertain').length, 1);
  assert.equal(second.sessions.unfinishedTasks().length, 0);
  await second.gateway.stop(0);
  second.db.close();
});

test('replies to one chat are delivered in order, even when the first waits out a rate limit', async () => {
  const t = setup();
  let now = Date.now() + 60_000;
  (t.gateway as unknown as { now: () => Date }).now = () => new Date(now);
  await t.gateway.start();
  t.channel.failures.push({ status: 'failed', retryable: true, error: 'Too Many Requests', retryAfterMs: 5000 });
  t.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat1', text: 'first' });
  t.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat1', text: 'second' });
  t.store.enqueue({ channel: 'fake', account: 'default', chatId: 'chat2', text: 'other chat' });
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.map((m) => m.text), ['other chat'], 'chat1 waits behind its rate-limited first message');
  now += 6000;
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.map((m) => m.text), ['other chat', 'first', 'second']);
  assert.deepEqual(t.gateway.health().outbox, { pending: 0, failed: 0, uncertain: 0 });
  await t.gateway.stop(0);
});

test('approvals over chat grant exactly one operation', async () => {
  const write = { name: 'write_file', input: { path: 'note.txt', content: 'hi' } };
  const t = setup([{ toolCalls: [write] }, { toolCalls: [write] }, { text: 'Saved note.txt.' }], { withApprovals: true });
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  await t.channel.sink!(msg('save a note'));
  await settle(t);
  const prompt = t.channel.sent.at(-1)!.text;
  const code = /\/approve ([A-Z0-9]{5})/.exec(prompt)?.[1];
  assert.ok(code, prompt);
  assert.match(prompt, /write_file on note\.txt/);
  await t.channel.sink!(msg(`/approve ${code}`));
  await settle(t);
  assert.equal(t.channel.sent.at(-1)!.text, 'Saved note.txt.');
  assert.equal(t.approvals.get(code!)?.usedAt !== null, true, 'the grant was consumed');
  await t.channel.sink!(msg(`/approve ${code}`));
  await settle(t);
  assert.match(t.channel.sent.at(-1)!.text, /already expired or was decided|No pending/);
  await t.gateway.stop(0);
});

test('/stop cancels a task started through chat() (API, dashboard)', async () => {
  const t = setup();
  t.store.addIdentity('fake', 'u1', 'Ada');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let called = false;
  const original = t.model.stream.bind(t.model);
  t.model.stream = async function* (request) {
    called = true;
    await Promise.race([gate, new Promise((r) => request.signal?.addEventListener('abort', r))]);
    yield* original(request);
  };
  await t.gateway.start();
  const running = t.gateway.chat('fake:default:chat1', 'long job', { source: 'api' });
  for (let i = 0; i < 200 && !called; i++) await new Promise((r) => setTimeout(r, 5));
  await t.channel.sink!(msg('/stop'));
  await t.gateway.deliver();
  const reply = t.channel.sent.at(-1)?.text;
  release();
  const result = await running;
  assert.equal(reply, 'Stopping…');
  assert.equal(result.task.status, 'cancelled');
  await t.gateway.stop(0);
});

test('after a restart the inbox backlog runs before messages that arrive during channel start', async () => {
  const file = `${tempDir()}/ruby.db`;
  const first = setup([], { db: openDb(file) });
  first.store.addIdentity('fake', 'u1', 'Ada');
  first.store.receive(msg('older'));
  first.db.close();

  const second = setup([], { db: openDb(file) });
  // The platform hands over a new message as soon as the channel connects.
  second.channel.start = async (sink) => {
    second.channel.sink = sink;
    await sink(msg('newer'));
  };
  await second.gateway.start();
  await settle(second);
  const order = second.model.requests.map((r) => {
    const last = r.messages.findLast((m) => m.role === 'user')!.content[0]!;
    return last.type === 'text' ? last.text : '';
  });
  assert.deepEqual(order, ['older', 'newer']);
  await second.gateway.stop(0);
  second.db.close();
});
