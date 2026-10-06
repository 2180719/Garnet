// Failure injection: scheduler crashes, failing runs and pausing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, type JobConfig } from '../src/config/index.ts';
import type { TaskRecord } from '../src/contracts/index.ts';
import { NOTHING, Scheduler } from '../src/scheduler/index.ts';
import { JobStore, openDb } from '../src/store/index.ts';
import { tempDir } from './helpers.ts';

const jobs: JobConfig[] = parseConfig({ version: 1, jobs: [{ id: 'hb', kind: 'heartbeat', everyMinutes: 30, instructions: 'Check things.' }] }).jobs;
const SLOT = 30 * 60_000;

const task = (status: TaskRecord['status'], reason: string | null = null): TaskRecord => ({
  id: `t_${status}`, sessionId: 's', status, reason, modelCalls: 1, toolCalls: 0, startedAt: '', endedAt: '',
  usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
});

type Outcome = 'ok' | 'failed' | 'throw' | 'hang';

function build(db: ReturnType<typeof openDb>, outcomes: Outcome[], startAt = new Date('2026-10-05T10:00:10Z')) {
  let now = startAt;
  const store = new JobStore(db);
  const notes: string[] = [];
  let runs = 0;
  const scheduler = new Scheduler({
    jobs, store, workspace: tempDir(), tickSeconds: 30, now: () => now,
    run: async () => {
      const outcome = outcomes[runs++] ?? 'ok';
      if (outcome === 'throw') throw new Error('model provider exploded');
      if (outcome === 'hang') return new Promise<never>(() => {}); // the process dies mid-run
      return { task: outcome === 'failed' ? task('failed', 'model unavailable') : task('completed'), text: NOTHING };
    },
    notify: (_job, text) => notes.push(text),
  });
  return { store, notes, scheduler, runs: () => runs, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

/** Starts due jobs and waits for them to finish. */
const tick = async (s: ReturnType<typeof build>) => {
  await s.scheduler.tick();
  await s.scheduler.stop();
};

test('a run that crashes mid-occurrence is marked interrupted after restart and the slot does not run twice', async () => {
  const file = `${tempDir()}/ruby.db`;
  const first = build(openDb(file), ['hang']);
  await first.scheduler.tick(); // baseline
  first.advance(SLOT);
  await first.scheduler.tick(); // starts the 10:30 occurrence; the run never returns
  assert.equal(first.runs(), 1);
  assert.equal(first.store.runs('hb')[0]!.status, 'running');
  const slot = first.store.runs('hb')[0]!.scheduledFor;
  // crash: the database handle is simply abandoned
  const second = build(openDb(file), [], new Date(Date.parse('2026-10-05T10:30:10Z')));
  second.scheduler.start(); // interrupts leftovers, then ticks
  await second.scheduler.stop();
  await tick(second);
  assert.equal(second.runs(), 0, 'the interrupted occurrence is not replayed');
  const runs = second.store.runs('hb');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'interrupted');
  assert.equal(runs[0]!.scheduledFor, slot);
  assert.equal(second.store.state('hb').consecutiveFailures, 0, 'a crash is not counted as a job failure');

  // The next slot proceeds normally.
  second.advance(SLOT);
  await tick(second);
  assert.equal(second.runs(), 1);
  assert.equal(second.store.runs('hb').length, 2);
});

test('the same occurrence cannot be claimed twice, even by a second process on the same database', async () => {
  const file = `${tempDir()}/ruby.db`;
  const a = build(openDb(file), []);
  const b = build(openDb(file), []);
  await tick(a); // baselines
  await tick(b);
  a.advance(SLOT);
  b.advance(SLOT);
  await Promise.all([tick(a), tick(b)]);
  assert.equal(a.runs() + b.runs(), 1, 'exactly one process ran the slot');
  assert.equal(a.store.runs('hb').length, 1);
});

test('three consecutive failed tasks pause the job, notify the owner once, and it stays paused across restart', async () => {
  const file = `${tempDir()}/ruby.db`;
  const t = build(openDb(file), ['failed', 'failed', 'failed', 'ok']);
  await tick(t);
  for (let i = 0; i < 4; i++) {
    t.advance(SLOT);
    await tick(t);
  }
  assert.equal(t.runs(), 3, 'no fourth run once paused');
  assert.equal(t.store.state('hb').paused, true);
  assert.equal(t.notes.filter((n) => /paused/.test(n)).length, 1);

  const restarted = build(openDb(file), []);
  restarted.advance(10 * SLOT);
  await tick(restarted);
  assert.equal(restarted.runs(), 0, 'pause survives a restart');
  restarted.scheduler.resume('hb');
  restarted.advance(SLOT);
  await tick(restarted);
  assert.equal(restarted.runs(), 1);
});

test('three consecutive runs that throw also pause the job and tell the owner', async () => {
  const t = build(openDb(':memory:'), ['throw', 'throw', 'throw', 'ok']);
  await tick(t);
  for (let i = 0; i < 4; i++) {
    t.advance(SLOT);
    await tick(t);
  }
  assert.equal(t.runs(), 3);
  assert.deepEqual(t.store.runs('hb').map((r) => r.status), ['failed', 'failed', 'failed']);
  assert.equal(t.store.state('hb').paused, true);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /paused.*model provider exploded.*ruby jobs resume hb/);
});

test('a success in between resets the failure count', async () => {
  const t = build(openDb(':memory:'), ['failed', 'failed', 'ok', 'failed', 'failed', 'ok']);
  await tick(t);
  for (let i = 0; i < 6; i++) {
    t.advance(SLOT);
    await tick(t);
  }
  assert.equal(t.runs(), 6);
  assert.equal(t.store.state('hb').paused, false);
  assert.equal(t.store.state('hb').consecutiveFailures, 0);
});

test('a failing run never overlaps itself while a slow run is still going', async () => {
  const t = build(openDb(':memory:'), ['hang']);
  await t.scheduler.tick();
  t.advance(SLOT);
  await t.scheduler.tick();
  t.advance(SLOT);
  await t.scheduler.tick(); // the first run is still in flight
  assert.equal(t.runs(), 1);
});
