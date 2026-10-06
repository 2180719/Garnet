import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msg, setup } from '../../test/fixtures.ts';
import { defaultConfig } from '../config/index.ts';
import { textOf } from '../contracts/index.ts';
import { Policy } from '../policy/index.ts';
import { ToolExecutor, ToolRegistry } from '../tools/index.ts';
import { ChatDirectory, sendMessageTool } from './index.ts';

/** A gateway with two paired people: Ada on "fake" (chat id = sender id would be usual on Telegram; here they differ, as in Discord DMs). */
async function paired() {
  const t = setup();
  await t.gateway.start();
  t.store.addIdentity('fake', 'u1', 'Ada');
  t.store.addIdentity('fake', 'u2', 'Bob');
  await t.gateway.receive(msg('hi', { chatId: 'dm-ada', sender: { id: 'u1', displayName: 'Ada' }, receivedAt: '2026-10-06T08:00:00Z' }));
  await t.lanes.idle();
  await t.gateway.receive(msg('hello', { chatId: 'dm-bob', sender: { id: 'u2', displayName: 'Bob' }, receivedAt: '2026-10-06T08:01:00Z' }));
  await t.lanes.idle();
  const directory = new ChatDirectory({ store: t.store, sessions: t.sessions });
  const adaSession = t.store.conversation('fake:default:dm-ada')!;
  return { ...t, directory, adaSession };
}

test('targets resolve to real chat ids of paired identities only', async () => {
  const t = await paired();
  assert.equal(t.directory.resolve(undefined, t.adaSession).chatId, 'dm-ada', 'omitted: this chat');
  assert.equal(t.directory.resolve('owner', 'no-session').chatId, 'dm-bob', 'owner: the most recently active chat');
  assert.equal(t.directory.resolve(undefined, 'cli-session').chatId, 'dm-bob', 'outside a chat: the latest chat');
  assert.equal(t.directory.resolve('fake:u1', 'x').chatId, 'dm-ada', 'a sender id maps to the chat it uses (Discord DMs)');
  assert.equal(t.directory.resolve('fake:dm-ada', 'x').chatId, 'dm-ada', 'a known chat id works too');
  assert.throws(() => t.directory.resolve('fake:someone-else', 'x'), /not a paired chat.*fake:u1 \(Ada\)/);
  assert.throws(() => t.directory.resolve('telegram', 'x'), /No paired chat on "telegram"/);
  t.store.removeIdentity('fake', 'u2');
  assert.throws(() => t.directory.resolve('fake:u2', 'x'), /not a paired chat/, 'revoked identities cannot be messaged');
  await t.gateway.stop(0);
});

test('send_message queues durably, records the text in the target chat, and is rate-limited', async () => {
  const t = await paired();
  let now = new Date();
  const tool = sendMessageTool({ directory: t.directory, store: t.store, perHour: 2, now: () => now });
  const ctx = { sessionId: 'cli-session', callId: 'c', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal };
  const r = await tool.run({ text: 'The build finished.', to: 'fake:u1' }, ctx);
  assert.match(r.content, /Queued for fake \(Ada\)/);
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.filter((m) => m.chatId === 'dm-ada').map((m) => m.text).at(-1), 'The build finished.');
  // Ada's conversation now shows what Ruby sent, so "tell me more" has context.
  const last = t.sessions.events(t.adaSession).at(-1)!;
  assert.equal(last.type, 'user_message');
  assert.match(last.type === 'user_message' ? textOf(last.message) : '', /Ruby sent this message.*not written by the owner.*\nThe build finished\./s);
  await tool.run({ text: 'Second.' }, ctx);
  await assert.rejects(tool.run({ text: 'Third.' }, ctx), /already sent 2 messages.*messagesPerHour/);
  now = new Date(now.getTime() + 3_601_000);
  await tool.run({ text: 'An hour later.' }, ctx);
  await t.gateway.stop(0);
});

test('send_message goes through policy: denied, or shown in full for approval', async () => {
  const t = await paired();
  const registry = new ToolRegistry();
  registry.register(sendMessageTool({ directory: t.directory, store: t.store, perHour: 5 }));
  const ctx = { sessionId: t.adaSession, workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal };
  const call = { type: 'tool_call' as const, id: 'c1', name: 'send_message', input: { text: 'Hello Bob, Ada asked me to say hi.', to: 'fake:u2' } };

  const denied = new ToolExecutor({ registry, policy: new Policy({ ...defaultConfig().permissions, 'message.send': 'deny' }), approver: async () => 'approved' });
  const d = await denied.execute(call, ctx);
  assert.equal(d.status === 'error' && d.category, 'denied');

  const asked: string[] = [];
  const ask = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async (req) => (asked.push(`${req.capability}|${req.summary}`), 'denied') });
  const a = await ask.execute(call, ctx);
  assert.equal(a.status === 'error' && a.category, 'denied');
  assert.deepEqual(asked, ['message.send|send_message to fake (Bob):\nHello Bob, Ada asked me to say hi.']);
  assert.equal(t.store.sentSince('2000-01-01T00:00:00Z'), 0, 'nothing was sent');
  await t.gateway.stop(0);
});

test('gateway.notify with a source records job results in the chat conversation', async () => {
  const t = await paired();
  t.gateway.notify({ channel: 'fake', account: 'default', chatId: 'dm-ada' }, '[news] Three new posts.', 'scheduled job "news"');
  await t.gateway.deliver();
  assert.equal(t.channel.sent.at(-1)?.text, '[news] Three new posts.');
  const last = t.sessions.events(t.adaSession).at(-1)!;
  assert.match(last.type === 'user_message' ? textOf(last.message) : '', /scheduled job "news"/);
  assert.equal(last.type === 'user_message' && last.source, 'notification');
  // A chat that never wrote to Ruby gets a conversation on first notice.
  t.gateway.notify({ channel: 'fake', account: 'default', chatId: 'new-chat' }, 'Hi', 'scheduled job "x"');
  assert.ok(t.store.conversation('fake:default:new-chat'));
  await t.gateway.stop(0);
});
