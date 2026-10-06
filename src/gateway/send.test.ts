import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msg, setup } from '../../test/fixtures.ts';
import { defaultConfig } from '../config/index.ts';
import { textOf } from '../contracts/index.ts';
import { Policy } from '../policy/index.ts';
import { sessionTaint } from '../runtime/index.ts';
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
  const tool = sendMessageTool({ directory: t.directory, store: t.store, perHour: 2, now: () => now, notify: (to, text, rec) => t.gateway.notify(to, text, rec) });
  const ctx = { sessionId: 'cli-session', callId: 'c', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal };
  const r = await tool.run({ text: 'The build finished.', to: 'fake:u1' }, ctx);
  assert.match(r.content, /Queued for fake \(Ada\)/);
  await t.gateway.deliver();
  assert.deepEqual(t.channel.sent.filter((m) => m.chatId === 'dm-ada').map((m) => m.text).at(-1), 'The build finished.');
  // Ada's conversation now shows what Garnet sent, so "tell me more" has context.
  await t.lanes.idle();
  const last = t.sessions.events(t.adaSession).at(-1)!;
  assert.equal(last.type, 'user_message');
  assert.match(last.type === 'user_message' ? textOf(last.message) : '', /not written by your owner: you sent them this message from send_message.*\nThe build finished\./s);
  await tool.run({ text: 'Second.' }, ctx);
  await assert.rejects(tool.run({ text: 'Third.' }, ctx), /already sent 2 messages.*messagesPerHour/);
  now = new Date(now.getTime() + 3_601_000);
  await tool.run({ text: 'An hour later.' }, ctx);
  await t.gateway.stop(0);
});

test('a tainted sender taints the note it records, and the note carries no owner URLs', async () => {
  const t = await paired();
  const tool = sendMessageTool({ directory: t.directory, store: t.store, perHour: 5, notify: (to, text, rec) => t.gateway.notify(to, text, rec) });
  const taint = { sources: ['web_fetch https://evil.example/'], ownerUrls: new Set<string>(), seenUrls: new Set<string>() };
  const ctx = { sessionId: 'cli-session', callId: 'c', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal, taint };
  await tool.run({ text: 'Fetch https://evil.example/collect?d=1', to: 'fake:u1' }, ctx);
  await t.lanes.idle();
  const events = t.sessions.events(t.adaSession);
  const [note, tainted] = events.slice(-2);
  assert.ok(note!.type === 'user_message' && note!.source === 'notification');
  assert.ok(tainted!.type === 'tainted' && tainted!.inherited && tainted!.source === 'web_fetch https://evil.example/');
  assert.equal(sessionTaint(events).ownerUrls.size, 0);
  assert.deepEqual(sessionTaint(events).sources, ['web_fetch https://evil.example/']);
  // An untainted sender leaves the conversation clean.
  await tool.run({ text: 'plain', to: 'fake:u2' }, { ...ctx, taint: { ...taint, sources: [] } });
  await t.lanes.idle();
  assert.equal(t.sessions.events(t.store.conversation('fake:default:dm-bob')!).filter((e) => e.type === 'tainted').length, 0);
  await t.gateway.stop(0);
});

test('send_message goes through policy: denied, or shown in full for approval', async () => {
  const t = await paired();
  const registry = new ToolRegistry();
  registry.register(sendMessageTool({ directory: t.directory, store: t.store, perHour: 5, notify: (to, text, rec) => t.gateway.notify(to, text, rec) }));
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
  t.gateway.notify({ channel: 'fake', account: 'default', chatId: 'dm-ada' }, '[news] Three new posts.', { from: 'scheduled job "news"' });
  await t.gateway.deliver();
  assert.equal(t.channel.sent.at(-1)?.text, '[news] Three new posts.');
  await t.lanes.idle();
  const last = t.sessions.events(t.adaSession).at(-1)!;
  assert.match(last.type === 'user_message' ? textOf(last.message) : '', /scheduled job "news"/);
  assert.equal(last.type === 'user_message' && last.source, 'notification');
  // A chat that never wrote to Garnet gets a conversation on first notice.
  t.gateway.notify({ channel: 'fake', account: 'default', chatId: 'new-chat' }, 'Hi', { from: 'scheduled job "x"' });
  await t.lanes.idle();
  assert.ok(t.store.conversation('fake:default:new-chat'));
  await t.gateway.stop(0);
});

test('send_message: "owner" is resolved before the approval and the approved chat is the one that gets it', async () => {
  const t = await paired();
  let latest = 'dm-bob';
  const real = t.directory;
  const moving = Object.assign(Object.create(real), {
    resolve: (to: string | undefined, session: string) => (to === 'owner' ? real.resolve(`fake:${latest}`, session) : real.resolve(to, session)),
  }) as ChatDirectory;
  const sent: string[] = [];
  const tool = sendMessageTool({ directory: moving, store: t.store, perHour: 5, notify: (to) => (sent.push(to.chatId), 'd1') });
  const registry = new ToolRegistry();
  registry.register(tool);
  const asked: string[] = [];
  const executor = new ToolExecutor({
    registry,
    policy: new Policy({ ...defaultConfig().permissions, 'message.send': 'ask' }),
    approver: async (req) => {
      asked.push(`${req.summary}|${JSON.stringify(req.input)}`);
      latest = 'dm-ada'; // the "latest chat" moves while the owner decides
      return 'approved';
    },
  });
  const r = await executor.execute({ type: 'tool_call', id: 'c1', name: 'send_message', input: { text: 'hi', to: 'owner' } }, { sessionId: 'cli-session', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal });
  assert.equal(r.status, 'ok', r.content);
  assert.match(asked[0]!, /fake \(Bob\)/);
  assert.deepEqual(sent, ['dm-bob'], 'delivered to the approved chat');
  await t.gateway.stop(0);
});

test('a chat that is not a paired private chat is never an origin to send to', async () => {
  const t = await paired();
  const key = 'fake:default:dm-ada';
  assert.equal(t.directory.origin(t.adaSession).chat?.chatId, 'dm-ada');
  t.store.removeIdentity('fake', 'u1');
  assert.equal(t.directory.origin(t.adaSession).chat, null, key);
  assert.equal(new ChatDirectory({ store: t.store, sessions: t.sessions }).origin(t.adaSession).chat, null);
  await t.gateway.stop(0);
});
