// End to end through the composition root: a Discord DM asks for a reminder,
// the owner approves it in chat, the job is stored, and its run is delivered
// back to that DM (whose chat id differs from the sender id) and recorded in
// the conversation.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeChannel, msg } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { textOf } from '../src/contracts/index.ts';
import { buildService, createGarnet } from '../src/main.ts';
import { FakeModel } from '../src/models/index.ts';
import { sessionTaint } from '../src/runtime/index.ts';

test('reminder from a Discord DM: approve in chat, delivered back to that DM, recorded in the conversation', async () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, timezone: 'Europe/London', model: { provider: 'fake' } }));
  const create = { action: 'create', when: 'in 20 minutes', reminder: 'Stretch your legs' };
  const model = new FakeModel([
    { toolCalls: [{ name: 'schedule', input: create }] },
    { toolCalls: [{ name: 'schedule', input: create }] }, // after /approve, the same call
    (req) => {
      const results = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
      return { text: `OK. ${(results.at(-1) as { content: string }).content.split('\n').at(-1)}` };
    },
    { text: 'You are welcome.' },
  ]);
  const garnet = createGarnet({ home, model, memoryDb: true });
  const channel = new FakeChannel();
  (channel as { channel: string }).channel = 'discord';
  const { gateway, scheduler } = buildService(garnet, () => {}, [channel], true);
  await gateway.start();
  try {
    garnet.gatewayStore.addIdentity('discord', 'user-1', 'Ada');
    const dm = { channel: 'discord', chatId: 'dm-channel-9', sender: { id: 'user-1', displayName: 'Ada' } };

    await gateway.receive(msg('remind me in 20 minutes to stretch', dm));
    await new Promise((r) => setTimeout(r, 50));
    await gateway.deliver();
    const prompt = channel.sent.at(-1)!;
    assert.equal(prompt.chatId, 'dm-channel-9');
    assert.match(prompt.text, /I need your approval/);
    assert.match(prompt.text, /when: once, today at \d\d:\d\d \(Europe\/London, in 20 min\)/);
    assert.match(prompt.text, /delivers to: discord \(Ada\)/);
    const code = /\/approve (\w+)/.exec(prompt.text)![1]!;

    await gateway.receive(msg(`/approve ${code}`, dm));
    await new Promise((r) => setTimeout(r, 50));
    await gateway.deliver();
    assert.match(channel.sent.at(-1)!.text, /^OK\. Next run: today at \d\d:\d\d \(Europe\/London, in 20 min\)\.$/);

    const [entry] = garnet.jobBook.list();
    assert.equal(entry?.job.message, 'Stretch your legs');
    assert.deepEqual(entry?.job.notify, { channel: 'discord', chatId: 'dm-channel-9', account: 'default' });
    assert.equal(entry?.origin.by === 'agent' && entry.origin.conversation, 'discord:default:dm-channel-9');

    // The time comes (run it now rather than waiting 20 minutes).
    await scheduler.runNow(entry!.job.id);
    await gateway.deliver();
    assert.equal(channel.sent.at(-1)!.text, '⏰ Stretch your legs');
    assert.equal(channel.sent.at(-1)!.chatId, 'dm-channel-9');
    const session = garnet.gatewayStore.conversation('discord:default:dm-channel-9')!;
    const note = garnet.store.events(session).at(-1)!;
    assert.equal(note.type === 'user_message' && note.source, 'notification');
    assert.match(note.type === 'user_message' ? textOf(note.message) : '', /scheduled job "stretch-your-legs".*\n⏰ Stretch your legs/s);

    // The owner's reply lands in the same conversation, after the reminder.
    await gateway.receive(msg('thanks!', dm));
    await new Promise((r) => setTimeout(r, 50));
    const last = model.requests.at(-1)!.messages.at(-1)!;
    assert.match(textOf(last), /⏰ Stretch your legs[\s\S]*thanks!/);
  } finally {
    await scheduler.stop();
    await gateway.stop(0);
    garnet.close();
  }
});

test('the schedule and send_message tools exist only when their permission is not deny', () => {
  const home = tempDir();
  const garnet = createGarnet({ home, memoryDb: true, noModel: true });
  assert.ok(garnet.registry.get('schedule') && garnet.registry.get('send_message'), 'default: ask');
  garnet.close();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, permissions: { 'schedule.edit': 'deny', 'message.send': 'deny' } }));
  const off = createGarnet({ home, memoryDb: true, noModel: true });
  assert.equal(off.registry.get('schedule'), undefined);
  assert.equal(off.registry.get('send_message'), undefined);
  off.close();
});

test('a job created by a tainted conversation runs tainted: its consequential actions still ask', async () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, model: { provider: 'fake' }, permissions: { 'fs.write': 'allow' } }));
  const write = { name: 'write_file', input: { path: 'out.txt', content: 'pwned' } };
  const model = new FakeModel([{ toolCalls: [write] }, { text: 'Done.' }, { toolCalls: [write] }, { text: 'Done.' }]);
  const garnet = createGarnet({ home, model, memoryDb: true });
  const { gateway, scheduler } = buildService(garnet, () => {}, [], false);
  try {
    const origin = { by: 'agent', sessionId: 's', conversation: null, at: new Date().toISOString() } as const;
    garnet.jobBook.create({ id: 'clean', kind: 'cron', cron: '0 9 * * *', instructions: 'Write the file.', permissions: { 'fs.write': 'allow' } }, origin);
    garnet.jobBook.create({ id: 'dirty', kind: 'cron', cron: '0 9 * * *', instructions: 'Write the file.', permissions: { 'fs.write': 'allow' } }, { ...origin, taint: ['web_fetch https://evil.example/'] });
    await scheduler.runNow('clean');
    assert.equal(garnet.jobStore.runs('clean')[0]?.status, 'completed', 'allowed write ran without asking');
    await scheduler.runNow('dirty');
    assert.equal(garnet.jobStore.runs('dirty')[0]?.status, 'waiting_for_approval', 'the inherited taint escalates allow to ask');
    const events = garnet.store.events(garnet.gatewayStore.conversation('job:dirty')!);
    assert.ok(events.some((e) => e.type === 'tainted' && e.inherited && e.source === 'web_fetch https://evil.example/'));
  } finally {
    await scheduler.stop();
    await gateway.stop(0);
    garnet.close();
  }
});

test('a networked script job taints the receiving chat, so its next consequential action asks', async () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, model: { provider: 'fake' }, sandbox: { backend: 'local' }, permissions: { exec: 'allow', 'fs.write': 'allow' } }));
  const garnet = createGarnet({ home, model: new FakeModel(), memoryDb: true });
  const channel = new FakeChannel();
  const { gateway, scheduler } = buildService(garnet, () => {}, [channel], true);
  try {
    assert.equal(garnet.sandbox?.networked, true, 'the local sandbox can reach the network');
    const notify = { channel: 'telegram', chatId: 'chat-1', account: 'default' };
    garnet.jobBook.create({ id: 'feed', kind: 'cron', cron: '0 9 * * *', script: { command: 'echo remote text' }, notify }, { by: 'owner', via: 'cli', at: new Date().toISOString() });
    await scheduler.runNow('feed');
    await gateway.deliver();
    await new Promise((r) => setTimeout(r, 50));
    const session = garnet.gatewayStore.conversation(`${notify.channel}:${notify.account}:${notify.chatId}`)!;
    assert.ok(session, 'the notification was recorded in the chat');
    const taint = sessionTaint(garnet.store.events(session));
    assert.deepEqual(taint.sources, ['command with network access']);
    assert.equal(garnet.ownerPolicy.check('fs.write', { taint }).verdict, 'ask');
  } finally {
    await scheduler.stop();
    await gateway.stop(0);
    garnet.close();
  }
});
