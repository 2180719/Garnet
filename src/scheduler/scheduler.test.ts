import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { parseConfig, type JobConfig } from '../config/index.ts';
import type { TaskRecord } from '../contracts/index.ts';
import { JobStore, openDb } from '../store/index.ts';
import { NOTHING, Scheduler } from './index.ts';

const jobsFrom = (jobs: object[]): JobConfig[] => parseConfig({ version: 1, jobs }).jobs;

function task(status: TaskRecord['status'] = 'completed', tokens = 1000): TaskRecord {
  return { id: 't', sessionId: 's', status, usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, modelCalls: 1, toolCalls: 0, startedAt: '', endedAt: '', reason: status === 'failed' ? 'boom' : null };
}

function setup(jobs: object[], opts: { reply?: string; status?: TaskRecord['status']; check?: () => string; db?: ReturnType<typeof openDb> } = {}) {
  let now = new Date('2026-10-05T10:00:10Z');
  const db = opts.db ?? openDb(':memory:');
  const store = new JobStore(db);
  const runs: string[] = [];
  const notes: string[] = [];
  const scheduler = new Scheduler({
    jobs: jobsFrom(jobs), store, workspace: tempDir(), tickSeconds: 30, now: () => now,
    run: async (job, text) => {
      runs.push(text);
      return { task: task(opts.status), text: opts.reply ?? NOTHING };
    },
    notify: (_job, text) => notes.push(text),
    ...(opts.check ? { check: async () => opts.check!() } : {}),
  });
  const tick = async () => {
    await scheduler.tick();
    await scheduler.stop(); // waits for in-flight runs
  };
  return { db, store, runs, notes, scheduler, tick, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const heartbeat = (extra: object = {}) => ({ id: 'hb', kind: 'heartbeat', everyMinutes: 30, instructions: 'Check things.', ...extra });

test('disabled jobs never run', async () => {
  const t = setup([heartbeat({ enabled: false })]);
  await t.tick();
  t.advance(3_600_000);
  await t.tick();
  assert.equal(t.runs.length, 0);
});

test('heartbeats run once per slot, never backfill on first sight, and survive restarts without duplicates', async () => {
  const file = `${tempDir()}/r.db`;
  const t = setup([heartbeat()], { db: openDb(file) });
  await t.tick(); // establishes the baseline
  assert.equal(t.runs.length, 0);
  t.advance(30 * 60_000);
  await t.tick();
  await t.tick();
  assert.equal(t.runs.length, 1);
  assert.match(t.runs[0]!, /NOTHING_TO_REPORT/);
  assert.equal(t.notes.length, 0, 'nothing to report stays quiet');
  t.db.close();
  const again = setup([heartbeat()], { db: openDb(file) });
  again.advance(30 * 60_000); // same slot as before
  await again.tick();
  assert.equal(again.runs.length, 0, 'restart does not repeat the occurrence');
});

test('missed cron occurrences coalesce, or are skipped when catch-up is off', async () => {
  const cron = { id: 'c', kind: 'cron', cron: '0 * * * *', timezone: 'UTC', instructions: 'Hourly.' };
  const t = setup([cron, { ...cron, id: 'd', catchUp: false }]);
  await t.tick();
  t.advance(5.5 * 3_600_000); // downtime; the latest slot (15:00) is 30 minutes old
  await t.tick();
  assert.equal(t.runs.length, 1, 'one coalesced catch-up run for "c"');
  assert.equal(t.store.runs('d')[0]?.status, 'missed');
});

test('unchanged pre-checks and exhausted budgets skip the model', async () => {
  let value = 'v1';
  const t = setup([heartbeat({ check: { type: 'url_changed', url: 'https://example.com' }, budget: { maxTokensPerDay: 1500 } })], {
    check: () => value,
    reply: 'Something changed!',
  });
  await t.tick();
  t.advance(30 * 60_000);
  await t.tick(); // v1 is new -> run
  t.advance(30 * 60_000);
  await t.tick(); // unchanged -> skip
  assert.equal(t.runs.length, 1);
  assert.equal(t.store.runs('hb')[0]?.status, 'skipped_unchanged');
  assert.deepEqual(t.notes, ['[hb] Something changed!']);
  value = 'v2';
  t.advance(30 * 60_000);
  await t.tick(); // changed -> run (1000 tokens so far, budget 1500)
  value = 'v3';
  t.advance(30 * 60_000);
  await t.tick(); // 2000 >= 1500 -> skipped
  assert.equal(t.runs.length, 2);
  assert.equal(t.store.runs('hb')[0]?.status, 'skipped_budget');
});

test('repeated failures pause the job and tell the owner', async () => {
  const t = setup([heartbeat()], { status: 'failed' });
  await t.tick();
  for (let i = 0; i < 4; i++) {
    t.advance(30 * 60_000);
    await t.tick();
  }
  assert.equal(t.runs.length, 3);
  assert.ok(t.store.state('hb').paused);
  assert.ok(t.notes.some((n) => /paused/.test(n)));
  t.scheduler.resume('hb');
  assert.ok(!t.store.state('hb').paused);
});

test('a run cancelled by shutdown is recorded as interrupted, not as a failure', async () => {
  const store = new JobStore(openDb(':memory:'));
  const notes: string[] = [];
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const scheduler = new Scheduler({
    jobs: jobsFrom([heartbeat()]), store, workspace: tempDir(), notify: (_j, text) => notes.push(text),
    run: (_job, _text, signal) => {
      started();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ task: task('cancelled'), text: 'Stopped.' }), { once: true }));
    },
  });
  store.saveState({ ...store.state('hb'), consecutiveFailures: 2 });
  const run = scheduler.runNow('hb');
  await running;
  await scheduler.stop();
  await run;
  assert.equal(store.runs('hb')[0]?.status, 'interrupted');
  assert.equal(store.state('hb').consecutiveFailures, 2, 'a restart does not count towards pausing');
  assert.ok(!store.state('hb').paused);
  assert.deepEqual(notes, [], 'the owner is not messaged about a shutdown');
});

test('job config is validated', () => {
  assert.throws(() => jobsFrom([{ id: 'x', kind: 'cron', instructions: 'i' }]), /cron jobs need/);
  assert.throws(() => jobsFrom([{ id: 'x', kind: 'cron', cron: '99 * * * *', instructions: 'i' }]), /out of range/);
  assert.throws(() => jobsFrom([{ id: 'x', kind: 'heartbeat', everyMinutes: 30, instructions: 'i', timezone: 'Nowhere/Land' }]), /time zone/);
  assert.throws(() => jobsFrom([heartbeat(), heartbeat()]), /Duplicate/);
  assert.equal(jobsFrom([heartbeat()])[0]!.permissions['fs.write'], 'deny', 'jobs default to read-only');
});

test('a daily job fires once on a fall-back day (no run for the repeated wall-clock minute)', async () => {
  const daily = { id: 'n', kind: 'cron', cron: '30 1 * * *', timezone: 'America/New_York', instructions: 'Nightly.' };
  const t = setup([daily]);
  const jump = (iso: string) => t.advance(new Date(iso).getTime() - t.scheduler['now']().getTime());
  jump('2026-11-01T05:00:10Z'); // 01:00 EDT, before the first 01:30
  await t.tick();
  jump('2026-11-01T05:30:10Z'); // 01:30 EDT
  await t.tick();
  jump('2026-11-01T06:30:10Z'); // 01:30 EST, the same wall-clock minute again
  await t.tick();
  assert.equal(t.runs.length, 1, 'the repeated 01:30 does not run again');
  jump('2026-11-02T06:30:10Z');
  await t.tick();
  assert.equal(t.runs.length, 2);
});

test('running a job that is already running is a conflict, not an internal error', async () => {
  const { isRubyError } = await import('../contracts/index.ts');
  const t = setup([heartbeat()]);
  const first = t.scheduler.runNow('hb');
  await assert.rejects(t.scheduler.runNow('hb'), (e) => isRubyError(e, 'conflict'));
  await assert.rejects(t.scheduler.runNow('nope'), (e) => isRubyError(e, 'invalid_input'));
  await first;
});
