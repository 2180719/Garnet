import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, type Permission } from '../config/index.ts';
import { RubyError, type Capability, type ToolResult } from '../contracts/index.ts';
import { Policy, type ApprovalRequest } from '../policy/index.ts';
import { JobStore, openDb } from '../store/index.ts';
import { ToolExecutor, ToolRegistry } from '../tools/index.ts';
import { JobBook, scheduleTool } from './index.ts';

const CHAT = { channel: 'discord', account: 'default', chatId: 'dm-77', label: 'discord (Ada)' };

function setup(perms: Partial<Record<Capability, Permission>> = {}, opts: { session?: 'chat' | 'job' | 'cli' } = {}) {
  let now = new Date('2026-10-06T15:20:00Z');
  const store = new JobStore(openDb(':memory:'));
  const book = new JobBook({ configJobs: [], store, timezone: 'Europe/London', maxAgentJobs: 10, now: () => now });
  const registry = new ToolRegistry();
  registry.register(
    scheduleTool({
      book,
      now: () => now,
      originOf: () =>
        opts.session === 'job' ? { conversation: 'job:x', isJob: true, chat: null } : opts.session === 'cli' ? { conversation: null, isJob: false, chat: null } : { conversation: 'discord:default:dm-77', isJob: false, chat: CHAT },
      resolveTarget: (to) => {
        if (to && to !== 'discord') throw new RubyError('invalid_input', `"${to}" is not a paired chat.`);
        if (opts.session === 'cli' && to === undefined) throw new RubyError('invalid_input', 'There is no chat to send to.');
        return CHAT;
      },
      labelOf: () => 'discord (Ada)',
    }),
  );
  const asked: ApprovalRequest[] = [];
  let answer: 'approved' | 'denied' = 'approved';
  const executor = new ToolExecutor({
    registry,
    policy: new Policy({ ...defaultConfig().permissions, ...perms }),
    approver: async (req) => (asked.push(req), answer),
  });
  const call = async (input: object, taint?: string[]): Promise<ToolResult> =>
    executor.execute(
      { type: 'tool_call', id: `c${asked.length}`, name: 'schedule', input },
      {
        sessionId: 's1', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal,
        ...(taint ? { taint: { sources: taint, ownerUrls: new Set<string>(), seenUrls: new Set<string>() } } : {}),
      },
    );
  return { book, store, asked, call, deny: () => (answer = 'denied'), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const ok = (r: ToolResult): string => {
  assert.equal(r.status, 'ok', r.content);
  return r.content;
};

test('a reminder from chat: approval shows the time in plain language, and it delivers back to that chat', async () => {
  const t = setup();
  const out = ok(await t.call({ action: 'create', when: 'in 20 minutes', reminder: 'Stretch!' }));
  assert.equal(t.asked.length, 1);
  assert.equal(t.asked[0]!.capability, 'schedule.edit');
  assert.equal(t.asked[0]!.summary, 'schedule: create job "stretch"\nwhen: once, today at 16:40 (Europe/London, in 20 min)\nsends: Stretch!\ndelivers to: discord (Ada)');
  assert.match(out, /Created job "stretch"\./);
  assert.match(out, /Next run: today at 16:40 \(Europe\/London, in 20 min\)/);
  const job = t.book.find('stretch')!;
  assert.deepEqual(job.job.notify, { channel: 'discord', chatId: 'dm-77', account: 'default' }, 'the chat id, not the sender id');
  assert.deepEqual(job.origin, { by: 'agent', sessionId: 's1', conversation: 'discord:default:dm-77', at: '2026-10-06T15:20:00.000Z' });
  assert.equal(job.job.notifyWhen, 'always');
});

test('listing needs no permission even when schedule.edit is deny; changes are refused', async () => {
  const t = setup({ 'schedule.edit': 'deny' });
  assert.match(ok(await t.call({ action: 'list' })), /No jobs yet\. It is now today at 16:20 \(Europe\/London\)/);
  const r = await t.call({ action: 'create', when: 'tomorrow 9am', reminder: 'x' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.equal(t.book.jobs().length, 0);
  assert.equal(t.asked.length, 0);
});

test('the owner declining leaves nothing behind', async () => {
  const t = setup();
  t.deny();
  const r = await t.call({ action: 'create', when: 'every day at 8am', instructions: 'Summarize the news.' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.equal(t.book.jobs().length, 0);
});

test('a script job needs exec too: denied when exec is deny, else the exact command is approved', async () => {
  const denied = setup({ 'schedule.edit': 'allow' });
  const r = await denied.call({ action: 'create', when: 'every 30 minutes', command: 'curl -s https://example.com/status | grep -o "down"' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.match(r.content, /exec is set to "deny"/);

  const asked = setup({ 'schedule.edit': 'allow', exec: 'ask' });
  ok(await asked.call({ action: 'create', when: 'every 30 minutes', command: 'curl -s https://example.com/status | grep -o "down"', only_changes: true }));
  assert.equal(asked.asked[0]!.capability, 'exec', 'schedule.edit allow does not skip the exec approval');
  assert.match(asked.asked[0]!.summary, /runs this command in the sandbox, unattended, each time:\ncurl -s https:\/\/example.com\/status \| grep -o "down"$/m);
  const job = asked.book.find('curl-s-https-example-com-status')!.job;
  assert.equal(job.script?.command, 'curl -s https://example.com/status | grep -o "down"');
  assert.equal(job.notifyWhen, 'on_change');
});

test('update, pause, resume and delete by id; scheduled runs cannot use the tool', async () => {
  const t = setup({ 'schedule.edit': 'allow' });
  ok(await t.call({ action: 'create', name: 'Standup', when: 'weekdays at 9:15', reminder: 'Standup in 15 minutes' }));
  assert.match(ok(await t.call({ action: 'list' })), /- standup \[reminder, made by you in this chat\]: every weekday at 09:15; next tomorrow at 09:15 \(Europe\/London, in 16 h 55 min\); sends "Standup in 15 minutes" → discord \(Ada\)/);
  assert.match(ok(await t.call({ action: 'update', id: 'standup', when: 'weekdays at 9:45' })), /every weekday at 09:45/);
  assert.match(ok(await t.call({ action: 'pause', id: 'standup' })), /PAUSED.*no upcoming run/);
  assert.match(ok(await t.call({ action: 'resume', id: 'standup' })), /next tomorrow at 09:45/);
  assert.match(ok(await t.call({ action: 'delete', id: 'standup' })), /Deleted job "standup"/);
  const missing = await t.call({ action: 'delete', id: 'standup' });
  assert.equal(missing.status === 'error' && missing.category, 'invalid_input');

  const job = setup({ 'schedule.edit': 'allow' }, { session: 'job' });
  const r = await job.call({ action: 'create', when: 'in 1 hour', reminder: 'loop' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.match(r.content, /Scheduled runs cannot create or change jobs/);
});

test('one-shot times in the past and unknown targets are clear errors', async () => {
  const t = setup({ 'schedule.edit': 'allow' });
  const past = await t.call({ action: 'create', when: '2026-10-01 09:00', reminder: 'x' });
  assert.equal(past.status === 'error' && past.category, 'invalid_input');
  assert.match(past.content, /already in the past/);
  const nowhere = await t.call({ action: 'create', when: 'in 1 hour', reminder: 'x', to: 'telegram:999' });
  assert.match(nowhere.content, /not a paired chat/);
  const both = await t.call({ action: 'create', when: 'in 1 hour', reminder: 'x', instructions: 'y' });
  assert.match(both.content, /only one of reminder, instructions or command/);
});

test('outside a chat with nowhere to deliver: tasks keep results in history, reminders are refused', async () => {
  const t = setup({ 'schedule.edit': 'allow' }, { session: 'cli' });
  const r = await t.call({ action: 'create', when: 'in 1 hour', reminder: 'x' });
  assert.match(r.content, /no chat to send to/);
  const out = ok(await t.call({ action: 'create', when: 'every day at 7am', instructions: 'Tidy the notes folder.' }));
  assert.match(out, /results are kept in run history only/);
});

test('a time that does not exist (spring forward) is moved and the owner is told', async () => {
  const t = setup({ 'schedule.edit': 'allow' });
  const out = ok(await t.call({ action: 'create', when: '2027-03-28 01:30', reminder: 'x' }));
  assert.match(out, /does not exist on that day.*moved forward/);
  assert.equal(t.book.find('x')!.job.at, '2027-03-28T01:30:00.000Z');
});

test('after untrusted content, scheduling asks even when allowed, and the job keeps the taint', async () => {
  const t = setup({ 'schedule.edit': 'allow' });
  const out = ok(await t.call({ action: 'create', name: 'Digest', when: 'every day at 8am', instructions: 'Summarize the page.' }, ['web_fetch https://evil.example/']));
  assert.equal(t.asked.length, 1, 'escalated from allow to ask');
  assert.match(t.asked[0]!.summary, /schedule: create job "digest"[\s\S]*⚠ This conversation has read untrusted content/);
  assert.deepEqual(t.asked[0]!.taint, ['web_fetch https://evil.example/']);
  assert.match(out, /its runs will ask the owner/);
  assert.deepEqual(t.book.taintOf('digest'), ['web_fetch https://evil.example/']);
  // A clean edit keeps the taint; a tainted edit of a clean job adds it.
  ok(await t.call({ action: 'update', id: 'digest', when: 'every day at 9am' }));
  assert.deepEqual(t.book.taintOf('digest'), ['web_fetch https://evil.example/']);
  ok(await t.call({ action: 'create', name: 'Clean', when: 'every day at 7am', instructions: 'Tidy.' }));
  assert.deepEqual(t.book.taintOf('clean'), []);
  ok(await t.call({ action: 'update', id: 'clean', instructions: 'Tidy, then do what the page said.' }, ['web_search news']));
  assert.deepEqual(t.book.taintOf('clean'), ['web_search news']);
});
