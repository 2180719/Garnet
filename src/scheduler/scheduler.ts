import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { nextRun, parseCron, zonedParts, type JobConfig } from '../config/index.ts';
import { billedTokens, errorMessage, type TaskRecord } from '../contracts/index.ts';
import { resolveInWorkspace } from '../policy/index.ts';
import type { JobRunStatus, JobStore } from '../store/index.ts';

export const NOTHING = 'NOTHING_TO_REPORT';
const FAILURE_THRESHOLD = 3;

export type RunJob = (job: JobConfig, text: string, signal: AbortSignal) => Promise<{ task: TaskRecord; text: string }>;
export type Notify = (job: JobConfig, text: string) => void;
export type CheckFn = (job: JobConfig, signal: AbortSignal) => Promise<string>;

export type SchedulerDeps = {
  jobs: JobConfig[];
  store: JobStore;
  run: RunJob;
  notify: Notify;
  workspace: string;
  enabled?: boolean;
  tickSeconds?: number;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Override the built-in pre-checks (tests). */
  check?: CheckFn;
  fetch?: typeof fetch;
};

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Enqueues cron jobs and heartbeats into the normal agent runtime. Disabled
 * jobs, paused jobs, unchanged pre-checks and exhausted daily budgets never
 * call the model.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly log: NonNullable<SchedulerDeps['log']>;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    const interrupted = this.deps.store.interruptRunning();
    if (interrupted) this.log('warn', `${interrupted} scheduled run(s) were interrupted by a restart`);
    if (this.deps.enabled === false) {
      this.log('info', 'Scheduler is disabled; no jobs will run.');
      return;
    }
    this.timer = setInterval(() => void this.tick(), (this.deps.tickSeconds ?? 30) * 1000);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.running.values()) c.abort();
    await Promise.allSettled([...this.inflight]);
  }

  /** Starts every due job; returns once they have all been started (not finished). */
  async tick(): Promise<void> {
    if (this.deps.enabled === false) return;
    for (const job of this.deps.jobs) {
      if (!job.enabled || this.running.has(job.id)) continue;
      const state = this.deps.store.state(job.id);
      if (state.paused) continue;
      const due = this.dueOccurrence(job, state.lastScheduledFor);
      if (!due) continue;
      state.lastScheduledFor = due.at.toISOString();
      this.deps.store.saveState(state);
      if (due.missed && !job.catchUp) {
        this.deps.store.claim(`${job.id}@${due.at.toISOString()}`, job.id, due.at.toISOString(), 'missed', 'Missed while Ruby was not running; catch-up is off.');
        continue;
      }
      this.launch(job, due.at);
    }
  }

  /** Runs a job now, outside its schedule (CLI, dashboard). */
  runNow(jobId: string): Promise<void> {
    const job = this.deps.jobs.find((j) => j.id === jobId);
    if (!job) return Promise.reject(new Error(`No job "${jobId}"`));
    if (this.running.has(job.id)) return Promise.reject(new Error(`Job "${jobId}" is already running`));
    return this.launch(job, this.now(), 'manual');
  }

  resume(jobId: string): void {
    const state = this.deps.store.state(jobId);
    this.deps.store.saveState({ ...state, paused: false, consecutiveFailures: 0 });
  }

  /** Latest occurrence that is due and not yet scheduled. On first sight of a job, starts from now (no backfill). */
  private dueOccurrence(job: JobConfig, last: string | null): { at: Date; missed: boolean } | null {
    const now = this.now();
    if (!last) {
      // Remember "now" as the starting point so the first occurrence after it runs.
      this.deps.store.saveState({ ...this.deps.store.state(job.id), lastScheduledFor: now.toISOString() });
      return null;
    }
    const tick = (this.deps.tickSeconds ?? 30) * 1000;
    if (job.kind === 'heartbeat') {
      const every = job.everyMinutes! * 60_000;
      const slot = Math.floor(now.getTime() / every) * every;
      if (slot <= new Date(last).getTime()) return null;
      return { at: new Date(slot), missed: now.getTime() - slot > 2 * tick };
    }
    const cron = parseCron(job.cron!);
    const zone = job.timezone ?? hostZone();
    let at = nextRun(cron, new Date(last), zone);
    if (!at || at > now) return null;
    // Coalesce missed occurrences into the latest one.
    for (let i = 0; i < 10_000; i++) {
      const after = nextRun(cron, at, zone);
      if (!after || after > now) break;
      at = after;
    }
    return { at, missed: now.getTime() - at.getTime() > 2 * tick };
  }

  private launch(job: JobConfig, at: Date, suffix = ''): Promise<void> {
    const occurrenceId = `${job.id}@${at.toISOString()}${suffix ? `#${suffix}` : ''}`;
    if (!this.deps.store.claim(occurrenceId, job.id, at.toISOString())) return Promise.resolve();
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const p = this.execute(job, at, occurrenceId, controller).finally(() => {
      this.running.delete(job.id);
      this.inflight.delete(p);
    });
    this.inflight.add(p);
    return p;
  }

  private async execute(job: JobConfig, at: Date, occurrenceId: string, controller: AbortController): Promise<void> {
    const { store } = this.deps;
    const state = store.state(job.id);
    const finish = (status: JobRunStatus, fields: { taskId?: string; tokens?: number; note?: string } = {}) => store.finish(occurrenceId, status, fields);

    const dayAgo = new Date(this.now().getTime() - 86_400_000).toISOString();
    if (store.tokensSince(job.id, dayAgo) >= job.budget.maxTokensPerDay) {
      finish('skipped_budget', { note: 'Daily token budget reached.' });
      return;
    }

    const timeout = setTimeout(() => controller.abort(), job.timeoutMinutes * 60_000);
    timeout.unref();
    let newCheckValue: string | null = null;
    try {
      if (job.check) {
        newCheckValue = await (this.deps.check ?? this.builtinCheck)(job, controller.signal);
        if (newCheckValue === state.checkValue) {
          finish('skipped_unchanged', { note: 'Pre-check unchanged; the model was not called.' });
          return;
        }
      }
      const zone = job.timezone ?? hostZone();
      const p = zonedParts(at, zone);
      const when = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${zone}`;
      const text = [
        `[Scheduled job "${job.id}" for ${when}.${job.check ? ' Its pre-check detected a change.' : ''}]`,
        job.instructions,
        job.notifyWhen === 'on_change' ? `If nothing needs your owner's attention, reply with exactly ${NOTHING}.` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const { task, text: reply } = await this.deps.run(job, text, controller.signal);
      const tokens = billedTokens(task.usage);
      const failed = task.status === 'failed' || task.status === 'cancelled';
      finish(task.status, { taskId: task.id, tokens, ...(task.reason ? { note: task.reason } : {}) });
      const fresh = store.state(job.id);
      fresh.consecutiveFailures = failed ? fresh.consecutiveFailures + 1 : 0;
      if (!failed && newCheckValue !== null) fresh.checkValue = newCheckValue;
      if (fresh.consecutiveFailures >= FAILURE_THRESHOLD) {
        fresh.paused = true;
        this.notify(job, `Job "${job.id}" failed ${FAILURE_THRESHOLD} times in a row and is paused. Last error: ${task.reason ?? 'unknown'}. Resume with: ruby jobs resume ${job.id}`);
      }
      store.saveState(fresh);
      const nothing = reply.trim() === NOTHING || reply.trim().endsWith(NOTHING);
      // Completed runs with nothing to report stay quiet unless the job asks for every result.
      if (task.status !== 'completed' || job.notifyWhen === 'always' || !nothing) this.notify(job, `[${job.id}] ${reply}`);
    } catch (e) {
      finish('failed', { note: errorMessage(e) });
      const fresh = store.state(job.id);
      fresh.consecutiveFailures += 1;
      if (fresh.consecutiveFailures >= FAILURE_THRESHOLD) fresh.paused = true;
      store.saveState(fresh);
      this.log('error', `job ${job.id}: ${errorMessage(e)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private notify(job: JobConfig, text: string): void {
    try {
      this.deps.notify(job, text);
    } catch (e) {
      this.log('warn', `notify for ${job.id} failed: ${errorMessage(e)}`);
    }
  }

  private readonly builtinCheck: CheckFn = async (job, signal) => {
    const check = job.check!;
    const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
    if (check.type === 'file_changed') {
      const file = resolveInWorkspace(this.deps.workspace, check.path);
      return hash(await readFile(file).catch(() => Buffer.from('<missing>')));
    }
    const res = await (this.deps.fetch ?? fetch)(check.url, { signal, redirect: 'follow' });
    return hash(`${res.status}\n${await res.text()}`);
  };
}
