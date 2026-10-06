// One-shot reminders, message jobs, script-only jobs, stored jobs and deletion while running.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import type { JobConfig } from '../config/index.ts';
import type { TaskRecord } from '../contracts/index.ts';
import { JobStore, openDb } from '../store/index.ts';
import { JobBook, Scheduler, type RunScript } from './index.ts';

const task = (status: TaskRecord['status'] = 'completed'): TaskRecord => ({
  id: 't', sessionId: 's', status, usage: { inputTokens: 500, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, modelCalls: 1, toolCalls: 0, startedAt: '', endedAt: '', reason: status === 'failed' ? 'boom' : null,
});
const AGENT = { by: 'agent', sessionId: 's1', conversation: 'telegram:default:42', at: '' } as const;
const notify = { channel: 'telegram', chatId: '42', account: 'default' };

function setup(opts: { runScript?: RunScript | null; run?: (job: JobConfig, signal: AbortSignal) => Promise<{ task: TaskRecord; text: string }> } = {}) {
  let now = new Date('2026-10-06T08:00:10Z');
  const store = new JobStore(openDb(':memory:'));
  const book = new JobBook({ configJobs: [], store, timezone: 'Europe/London', maxAgentJobs: 3, now: () => now });
  const runs: string[] = [];
  const notes: string[] = [];
  const scheduler = new Scheduler({
    jobs: () => book.jobs(), store, workspace: tempDir(), tickSeconds: 30, now: () => now, timeZone: 'Europe/London',
    run: async (job, text, signal) => {
      runs.push(text);
      return opts.run ? opts.run(job, signal) : { task: task(), text: 'Done it.' };
    },
    notify: (_job, text) => notes.push(text),
    ...(opts.runScript !== undefined ? { runScript: opts.runScript } : {}),
  });
  book.onRemoved((id) => scheduler.cancel(id));
  const tick = async () => {
    await scheduler.tick();
    await scheduler.stop();
  };
  return { store, book, scheduler, runs, notes, tick, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

test('a one-shot reminder fires once at its time, never calls the model, and is then done', async () => {
  const t = setup();
  t.book.create({ id: 'call-mom', kind: 'once', at: '2026-10-06T08:20:00Z', message: 'Call mom', notify, notifyWhen: 'always' }, AGENT);
  await t.tick();
  assert.equal(t.notes.length, 0, 'not yet');
  t.advance(20 * 60_000);
  await t.tick();
  t.advance(60 * 60_000);
  await t.tick();
  assert.deepEqual(t.notes, ['⏰ Call mom']);
  assert.equal(t.runs.length, 0, 'message jobs never run the model');
  assert.equal(t.store.runs('call-mom')[0]?.status, 'completed');
  const entry = t.book.list().find((e) => e.job.id === 'call-mom')!;
  assert.equal(entry.done, true);
  assert.equal(entry.next, null);
  assert.equal(t.book.agentJobCount(), 0, 'finished reminders do not count against the cap');
});

test('a one-shot missed during downtime runs late (catch-up) or is recorded as missed', async () => {
  const t = setup();
  t.book.create({ id: 'late', kind: 'once', at: '2026-10-06T08:20:00Z', message: 'Late one', notify }, AGENT);
  t.book.create({ id: 'skip', kind: 'once', at: '2026-10-06T08:20:00Z', message: 'Skipped', notify, catchUp: false }, AGENT);
  t.advance(5 * 3_600_000); // Ruby was down
  await t.tick();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /^⏰ Late one \(due 2026-10-06 09:20 Europe\/London; Ruby was not running then\)$/);
  assert.equal(t.store.runs('skip')[0]?.status, 'missed');
});

test('a one-shot time in the past is refused when created', () => {
  const t = setup();
  assert.throws(() => t.book.create({ id: 'past', kind: 'once', at: '2026-10-06T07:00:00Z', message: 'x' }, AGENT), /already in the past/);
});

test('a config one-shot whose time passed before Ruby first saw it is recorded as missed, not run', async () => {
  const store = new JobStore(openDb(':memory:'));
  const notes: string[] = [];
  const job = { id: 'old', enabled: true, kind: 'once', at: '2026-10-01T09:00:00Z', message: 'old', notifyWhen: 'always', catchUp: true, timeoutMinutes: 1, budget: { maxTokensPerRun: 1000, maxTokensPerDay: 1000 }, permissions: {} } as unknown as JobConfig;
  const s = new Scheduler({ jobs: [job], store, workspace: tempDir(), now: () => new Date('2026-10-06T08:00:00Z'), run: async () => ({ task: task(), text: '' }), notify: (_j, t) => notes.push(t) });
  await s.tick();
  await s.stop();
  assert.deepEqual(notes, []);
  assert.equal(store.runs('old')[0]?.status, 'missed');
});

test('script jobs send non-empty output, stay quiet when unchanged or empty, and never call the model', async () => {
  let stdout = 'price: 10\n';
  const t = setup({ runScript: async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false, cancelled: false }) });
  t.book.create({ id: 'price', kind: 'heartbeat', everyMinutes: 30, script: { command: 'curl -s example.com/price' }, notify, notifyWhen: 'on_change' }, AGENT);
  const slot = async () => {
    t.advance(30 * 60_000);
    await t.tick();
  };
  await slot();
  await slot(); // unchanged
  stdout = 'price: 12\n';
  await slot();
  stdout = '   \n';
  await slot(); // empty
  assert.deepEqual(t.notes, ['[price] price: 10', '[price] price: 12']);
  assert.deepEqual(t.store.runs('price').map((r) => r.status), ['completed', 'completed', 'skipped_unchanged', 'completed']);
  assert.equal(t.runs.length, 0);
  assert.equal(t.store.runs('price').reduce((n, r) => n + r.tokens, 0), 0, 'no tokens spent');
});

test('script jobs: failures are reported and counted towards pausing; without exec they fail clearly', async () => {
  const t = setup({ runScript: async () => ({ exitCode: 2, stdout: '', stderr: 'no such host\n', timedOut: false, cancelled: false }) });
  t.book.create({ id: 'bad', kind: 'heartbeat', everyMinutes: 30, script: { command: 'false' }, notify }, AGENT);
  for (let i = 0; i < 3; i++) {
    t.advance(30 * 60_000);
    await t.tick();
  }
  assert.equal(t.store.state('bad').paused, true);
  assert.match(t.notes[0]!, /The script failed \(exit code 2\)\.\nno such host/);
  assert.ok(t.notes.some((n) => /failed 3 times in a row and is paused/.test(n)));

  const noExec = setup({ runScript: null });
  noExec.book.create({ id: 's', kind: 'once', at: '2026-10-06T08:10:00Z', script: { command: 'date' }, notify }, AGENT);
  noExec.advance(10 * 60_000);
  await noExec.tick();
  assert.match(noExec.notes[0]!, /need the exec permission/);
  assert.equal(noExec.store.runs('s')[0]?.status, 'failed');
});

test('deleting a job while it runs stops the run, without a failure or a message', async () => {
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const t = setup({
    run: (_job, signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ task: task('cancelled'), text: 'Stopped.' }), { once: true }));
    },
  });
  t.book.create({ id: 'long', kind: 'once', at: '2026-10-06T08:10:00Z', instructions: 'Do a long thing.', notify }, AGENT);
  t.advance(10 * 60_000);
  await t.scheduler.tick();
  await running;
  assert.ok(t.scheduler.isRunning('long'));
  t.book.remove('long'); // the in-process listener cancels it
  await t.scheduler.stop();
  assert.equal(t.store.runs('long')[0]?.status, 'cancelled');
  assert.match(t.store.runs('long')[0]?.note ?? '', /deleted/);
  assert.deepEqual(t.notes, []);
  assert.equal(t.book.find('long'), undefined);
  assert.equal(t.store.state('long').consecutiveFailures, 0);
});

test('a job deleted by another process (CLI) is stopped at the next tick', async () => {
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const t = setup({
    run: (_job, signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ task: task('cancelled'), text: '' }), { once: true }));
    },
  });
  t.book.create({ id: 'long', kind: 'heartbeat', everyMinutes: 30, instructions: 'Long.', notify }, AGENT);
  t.advance(30 * 60_000);
  await t.scheduler.tick();
  await running;
  t.store.deleteDefinition('long'); // what `ruby jobs delete` does from another process
  await t.scheduler.tick();
  await t.scheduler.stop();
  assert.equal(t.store.runs('long')[0]?.status, 'cancelled');
});

test('stored jobs: limits, provenance, pause and resume, update and config precedence', () => {
  const t = setup();
  const e = t.book.create({ id: 'a', kind: 'cron', cron: '0 9 * * *', message: 'Morning', notify }, AGENT);
  assert.equal(e.origin.by, 'agent');
  assert.equal(e.next?.toISOString(), '2026-10-07T08:00:00.000Z', '09:00 London');
  assert.throws(() => t.book.create({ id: 'a', kind: 'cron', cron: '0 9 * * *', message: 'x' }, AGENT), /already exists/);
  assert.throws(() => t.book.create({ id: 'fast', kind: 'cron', cron: '* * * * *', message: 'x' }, AGENT), /at most every 5 minutes/);
  assert.throws(() => t.book.create({ id: 'two', kind: 'cron', cron: '0 9 * * *', message: 'x', instructions: 'y' }, AGENT), /exactly one of/);
  assert.throws(() => t.book.create({ id: 'esc', kind: 'cron', cron: '0 9 * * *', instructions: 'y', permissions: { 'schedule.edit': 'allow' } }, AGENT), /cannot create or change other jobs/);
  t.book.create({ id: 'b', kind: 'heartbeat', everyMinutes: 60, message: 'x' }, AGENT);
  t.book.create({ id: 'c', kind: 'heartbeat', everyMinutes: 60, message: 'x' }, AGENT);
  assert.throws(() => t.book.create({ id: 'd', kind: 'heartbeat', everyMinutes: 60, message: 'x' }, AGENT), /already 3 jobs/);
  assert.ok(t.book.create({ id: 'd', kind: 'heartbeat', everyMinutes: 60, message: 'x' }, { by: 'owner', via: 'cli', at: '' }), 'the cap is for jobs Ruby creates');

  assert.equal(t.book.pause('a').next, null);
  assert.ok(t.book.resume('a').next);
  const u = t.book.update('a', { kind: 'once', at: '2026-10-08T07:00:00Z' }, 'agent');
  assert.equal(u.job.kind, 'once');
  assert.equal(u.job.cron, undefined, 'the old schedule is replaced');
  assert.equal(u.job.message, 'Morning', 'unchanged fields stay');
  assert.equal(t.book.freeId('Water the plants please now'), 'water-the-plants-please-now');
  assert.equal(t.book.freeId('A'), 'a-2');

  const withConfig = new JobBook({ configJobs: [{ ...u.job, id: 'a' }], store: t.store, timezone: 'UTC', maxAgentJobs: 3 });
  assert.equal(withConfig.find('a')?.origin.by, 'config', 'config.json wins on a name clash');
  assert.match(withConfig.problems()[0]?.problem ?? '', /same name/);
  assert.throws(() => withConfig.remove('a'), /config.json/);
  assert.throws(() => withConfig.update('a', { message: 'x' }, 'agent'), /config.json/);
});
