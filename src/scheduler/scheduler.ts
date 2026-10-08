import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { nextRun, parseCron, zonedParts, type JobConfig } from '../config/index.ts';
import { billedTokens, errorMessage, isGarnetError, GarnetError, type TaskRecord, type TaskStatus } from '../contracts/index.ts';
import { resolveInWorkspace, type Policy } from '../policy/index.ts';
import type { JobRunStatus, JobStore } from '../store/index.ts';
import type { FetchResponse } from '../tools/index.ts';

export const NOTHING = 'NOTHING_TO_REPORT';
/** OpenClaw's heartbeat acknowledgement; imported checklists still ask for it. */
export const HEARTBEAT_OK = 'HEARTBEAT_OK';
/** Text left beside HEARTBEAT_OK up to this length still counts as "nothing to report" (OpenClaw's default ackMaxChars). */
const ACK_MAX_CHARS = 300;
const FAILURE_THRESHOLD = 3;
/** Abort reason for runs cancelled because Garnet is shutting down (not the job's fault). */
const SHUTDOWN = 'shutdown';
/** Abort reason for runs whose job was deleted while they ran. */
const DELETED = 'deleted';
/** Longest script output sent to a chat. */
const MAX_SCRIPT_MESSAGE = 3500;
/** Most bytes of a watched file that a `file_changed` pre-check reads (the file's size is hashed too). */
const MAX_CHECK_FILE_BYTES = 5 * 1024 * 1024;
/** Untrusted-source name for output of a script that could reach the network (same wording as the command tools). */
export const NETWORKED_SCRIPT_SOURCE = 'command with network access';

export type RunJob = (job: JobConfig, text: string, signal: AbortSignal) => Promise<{ task: TaskRecord; text: string }>;
/** `taint`: untrusted sources the text itself carries (beyond what the job inherited), for the receiving chat's containment. */
export type Notify = (job: JobConfig, text: string, extra?: { taint?: readonly string[] }) => void;
export type CheckFn = (job: JobConfig, signal: AbortSignal) => Promise<string>;
/** Runs a script job's command in the sandbox. Absent when exec is denied. */
export type RunScript = (
  job: JobConfig,
  signal: AbortSignal,
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean }>;

export type SchedulerDeps = {
  /** The jobs to schedule, re-read on every tick (stored jobs can change while Garnet runs). */
  jobs: JobConfig[] | (() => JobConfig[]);
  store: JobStore;
  run: RunJob;
  notify: Notify;
  workspace: string;
  /** Script jobs fail with a clear error without it. */
  runScript?: RunScript | null;
  enabled?: boolean;
  tickSeconds?: number;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Override the built-in pre-checks (tests). */
  check?: CheckFn;
  /**
   * The SSRF-guarded client for `url_changed` pre-checks (response size and time are bounded by its own options).
   * Without it a `url_changed` check fails.
   */
  fetcher?: { fetch(url: string, req?: { signal?: AbortSignal }): Promise<FetchResponse> };
  /**
   * The job's effective policy (the owner's intersected with its grant). Built-in pre-checks need `net.fetch`
   * (`url_changed`) or `fs.read` (`file_changed`) to be allowed for it; `ask` counts as denied because nobody is
   * there to answer. Without it the built-in pre-checks fail closed.
   */
  policyFor?: (job: JobConfig) => Policy;
  /** Whether the script sandbox can reach the network: its output is then untrusted text (like a networked `run_command`). */
  scriptNetworked?: boolean;
  /** Time zone for jobs without their own `timezone` (the owner's). Defaults to the host zone. */
  timeZone?: string;
};

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What one run did, before the shared bookkeeping (failure counting, pausing, notifying). */
type Outcome = {
  status: JobRunStatus;
  failed: boolean;
  taskId?: string;
  tokens?: number;
  note?: string;
  /** Text for the owner, or null to stay quiet. */
  message: string | null;
  /** New value for the job's change-detection state, saved only on success. */
  checkValue?: string | null;
  /** Error reason used in the "paused" notice. */
  reason?: string;
  /** Untrusted sources the message text carries, merged into the notification's taint. */
  taint?: string[];
};

/**
 * Whether a reply means "nothing to report": `NOTHING_TO_REPORT` as the whole
 * reply or its end, or `HEARTBEAT_OK` at its start or end with at most a short
 * remark beside it. Returns the text to send otherwise (an acknowledgement
 * token around a longer report is removed).
 */
export function quietReply(reply: string): { nothing: boolean; text: string } {
  const t = reply.trim();
  if (t === NOTHING || t.endsWith(NOTHING)) return { nothing: true, text: t };
  // The token may be wrapped in markdown (**HEARTBEAT_OK**) or followed by punctuation.
  const lead = /^[\s*_`]*HEARTBEAT_OK[\s*_`.!]*/;
  const trail = /[\s*_`]*HEARTBEAT_OK[\s*_`.!]*$/;
  if (!lead.test(t) && !trail.test(t)) return { nothing: false, text: t };
  const rest = t.replace(lead, '').replace(trail, '').trim();
  if (rest.length <= ACK_MAX_CHARS) return { nothing: true, text: t };
  return { nothing: false, text: rest };
}

/**
 * Enqueues cron jobs, heartbeats, one-shot reminders and script-only jobs.
 * Disabled jobs, paused jobs, unchanged pre-checks and exhausted daily budgets
 * never call the model; message and script jobs never do.
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

  private jobs(): JobConfig[] {
    return typeof this.deps.jobs === 'function' ? this.deps.jobs() : this.deps.jobs;
  }

  private zone(job: JobConfig): string {
    return job.timezone ?? this.deps.timeZone ?? hostZone();
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
    for (const c of this.running.values()) c.abort(SHUTDOWN);
    await Promise.allSettled([...this.inflight]);
  }

  /** Starts every due job; returns once they have all been started (not finished). */
  async tick(): Promise<void> {
    let jobs: JobConfig[];
    try {
      jobs = this.jobs();
    } catch (e) {
      this.log('error', `could not load jobs: ${errorMessage(e)}`);
      return;
    }
    // A job deleted while it runs (from chat, the CLI or the dashboard) is stopped.
    const ids = new Set(jobs.map((j) => j.id));
    for (const id of this.running.keys()) if (!ids.has(id)) this.cancel(id);
    if (this.deps.enabled === false) return;
    for (const job of jobs) {
      if (!job.enabled || this.running.has(job.id)) continue;
      const state = this.deps.store.state(job.id);
      if (state.paused) continue;
      const due = this.dueOccurrence(job, state.lastScheduledFor);
      if (!due) continue;
      state.lastScheduledFor = due.at.toISOString();
      this.deps.store.saveState(state);
      if (due.missed && !job.catchUp) {
        this.deps.store.claim(`${job.id}@${due.at.toISOString()}`, job.id, due.at.toISOString(), 'missed', 'Missed while Garnet was not running; catch-up is off.');
        continue;
      }
      void this.launch(job, due.at, due.missed ? 'late' : '');
    }
  }

  /** Runs a job now, outside its schedule (CLI, dashboard). */
  runNow(jobId: string): Promise<void> {
    const job = this.jobs().find((j) => j.id === jobId);
    if (!job) return Promise.reject(new GarnetError('invalid_input', `No job "${jobId}"`));
    if (this.running.has(job.id)) return Promise.reject(new GarnetError('conflict', `Job "${jobId}" is already running`));
    return this.launch(job, this.now(), '', 'manual');
  }

  resume(jobId: string): void {
    const state = this.deps.store.state(jobId);
    this.deps.store.saveState({ ...state, paused: false, consecutiveFailures: 0 });
  }

  /** Stops a running occurrence because its job was deleted. Returns whether one was running. */
  cancel(jobId: string): boolean {
    const c = this.running.get(jobId);
    c?.abort(DELETED);
    return !!c;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /** Latest occurrence that is due and not yet scheduled. On first sight of a job, starts from now (no backfill). */
  private dueOccurrence(job: JobConfig, last: string | null): { at: Date; missed: boolean } | null {
    const now = this.now();
    const tick = (this.deps.tickSeconds ?? 30) * 1000;
    if (job.kind === 'once') {
      const at = new Date(job.at!);
      if (last && new Date(last) >= at) return null;
      if (!last) {
        // First sight (a config job): a time that had already passed is recorded, never run late.
        if (at.getTime() < now.getTime() - 2 * tick) {
          this.deps.store.saveState({ ...this.deps.store.state(job.id), lastScheduledFor: at.toISOString() });
          this.deps.store.claim(`${job.id}@${at.toISOString()}`, job.id, at.toISOString(), 'missed', 'Its time had already passed when Garnet first saw it.');
          return null;
        }
      }
      if (at > now) return null;
      return { at, missed: now.getTime() - at.getTime() > 2 * tick };
    }
    if (!last) {
      // Remember "now" as the starting point so the first occurrence after it runs.
      this.deps.store.saveState({ ...this.deps.store.state(job.id), lastScheduledFor: now.toISOString() });
      return null;
    }
    if (job.kind === 'heartbeat') {
      const every = job.everyMinutes! * 60_000;
      const slot = Math.floor(now.getTime() / every) * every;
      if (slot <= new Date(last).getTime()) return null;
      return { at: new Date(slot), missed: now.getTime() - slot > 2 * tick };
    }
    const cron = parseCron(job.cron!);
    const zone = this.zone(job);
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

  private launch(job: JobConfig, at: Date, late: '' | 'late', suffix = ''): Promise<void> {
    const occurrenceId = `${job.id}@${at.toISOString()}${suffix ? `#${suffix}` : ''}`;
    if (!this.deps.store.claim(occurrenceId, job.id, at.toISOString())) return Promise.resolve();
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const p = this.execute(job, at, occurrenceId, controller, late === 'late').finally(() => {
      this.running.delete(job.id);
      this.inflight.delete(p);
    });
    this.inflight.add(p);
    return p;
  }

  private async execute(job: JobConfig, at: Date, occurrenceId: string, controller: AbortController, late: boolean): Promise<void> {
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
    const stopped = (fields: { taskId?: string; tokens?: number } = {}): boolean => {
      const reason = controller.signal.reason;
      if (reason === SHUTDOWN) finish('interrupted', { ...fields, note: 'Stopped because Garnet shut down.' });
      else if (reason === DELETED) finish('cancelled', { ...fields, note: 'The job was deleted while it ran.' });
      // A restart or a deletion is not a job failure: record it, but do not count it towards pausing or message the owner.
      return reason === SHUTDOWN || reason === DELETED;
    };
    try {
      let newCheckValue: string | null = null;
      if (job.check) {
        newCheckValue = await (this.deps.check ?? this.builtinCheck)(job, controller.signal);
        if (newCheckValue === state.checkValue) {
          finish('skipped_unchanged', { note: 'Pre-check unchanged; the model was not called.' });
          return;
        }
      }
      const outcome = job.message !== undefined
        ? this.messageOutcome(job, at, late)
        : job.script
          ? await this.scriptOutcome(job, state.checkValue, controller.signal)
          : await this.agentOutcome(job, at, late, controller.signal, newCheckValue);
      if (outcome.status === 'cancelled' && stopped({ ...(outcome.taskId ? { taskId: outcome.taskId } : {}), tokens: outcome.tokens ?? 0 })) return;
      finish(outcome.status, { ...(outcome.taskId ? { taskId: outcome.taskId } : {}), tokens: outcome.tokens ?? 0, ...(outcome.note ? { note: outcome.note } : {}) });
      const fresh = store.state(job.id);
      fresh.consecutiveFailures = outcome.failed ? fresh.consecutiveFailures + 1 : 0;
      if (!outcome.failed && outcome.checkValue !== undefined) fresh.checkValue = outcome.checkValue;
      if (fresh.consecutiveFailures >= FAILURE_THRESHOLD) {
        fresh.paused = true;
        this.notify(job, `Job "${job.id}" failed ${FAILURE_THRESHOLD} times in a row and is paused. Last error: ${outcome.reason ?? 'unknown'}. Resume with: garnet jobs resume ${job.id}`, outcome.taint);
      }
      store.saveState(fresh);
      if (outcome.message !== null) this.notify(job, outcome.message, outcome.taint);
    } catch (e) {
      // Only an abort counts as stopped: a genuine error that races a shutdown is still a failure.
      const aborted = e === controller.signal.reason || (e as Error)?.name === 'AbortError' || isGarnetError(e, 'cancelled');
      if (aborted && stopped()) return;
      finish('failed', { note: errorMessage(e) });
      const fresh = store.state(job.id);
      fresh.consecutiveFailures += 1;
      if (fresh.consecutiveFailures >= FAILURE_THRESHOLD) {
        fresh.paused = true;
        this.notify(job, `Job "${job.id}" failed ${FAILURE_THRESHOLD} times in a row and is paused. Last error: ${errorMessage(e)}. Resume with: garnet jobs resume ${job.id}`);
      }
      store.saveState(fresh);
      this.log('error', `job ${job.id}: ${errorMessage(e)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private when(job: JobConfig, at: Date): string {
    const zone = this.zone(job);
    const p = zonedParts(at, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${zone}`;
  }

  /** A fixed reminder: sent as is, never calls the model. */
  private messageOutcome(job: JobConfig, at: Date, late: boolean): Outcome {
    const lateNote = late ? ` (due ${this.when(job, at)}; Garnet was not running then)` : '';
    return { status: 'completed', failed: false, note: 'Message sent.', message: `⏰ ${job.message}${lateNote}` };
  }

  /** A script-only job: runs the command, never calls the model, sends non-empty (and, for on_change, new) output. */
  private async scriptOutcome(job: JobConfig, lastHash: string | null, signal: AbortSignal): Promise<Outcome> {
    if (!this.deps.runScript) {
      const reason = 'Script jobs need the exec permission (allow or ask) in config.json; it is deny.';
      return { status: 'failed', failed: true, note: reason, reason, message: `[${job.id}] ${reason}` };
    }
    const r = await this.deps.runScript(job, signal);
    // Output (and error text) of a networked script may come from remote servers: mark the notification untrusted.
    const taint = this.deps.scriptNetworked ? { taint: [NETWORKED_SCRIPT_SOURCE] } : {};
    if (r.cancelled || signal.aborted) return { status: 'cancelled', failed: true, note: 'Cancelled.', reason: 'cancelled', message: null };
    if (r.timedOut || r.exitCode !== 0) {
      const why = r.timedOut ? `timed out after ${job.script!.timeoutSeconds}s` : `exit code ${r.exitCode ?? 'none (killed)'}`;
      const detail = (r.stderr.trim() || r.stdout.trim()).slice(-500);
      const reason = `the script failed (${why})${detail ? `: ${detail}` : ''}`;
      return { status: 'failed', failed: true, note: reason, reason, message: `[${job.id}] The script failed (${why}).${detail ? `\n${detail}` : ''}`, ...taint };
    }
    const out = r.stdout.trim();
    if (!out) return { status: 'completed', failed: false, note: 'No output; nothing sent.', message: null, checkValue: null };
    const hash = createHash('sha256').update(out).digest('hex');
    if (job.notifyWhen === 'on_change' && hash === lastHash) {
      return { status: 'skipped_unchanged', failed: false, note: 'Output unchanged; nothing sent.', message: null };
    }
    const text = out.length > MAX_SCRIPT_MESSAGE ? `${out.slice(0, MAX_SCRIPT_MESSAGE)}\n… (${out.length - MAX_SCRIPT_MESSAGE} more characters)` : out;
    return { status: 'completed', failed: false, note: 'Output sent.', message: `[${job.id}] ${text}`, checkValue: hash, ...taint };
  }

  /** A normal job: runs the agent with the job's instructions. */
  private async agentOutcome(job: JobConfig, at: Date, late: boolean, signal: AbortSignal, newCheckValue: string | null): Promise<Outcome> {
    const text = [
      `[Scheduled job "${job.id}" for ${this.when(job, at)}.${late ? ' It runs late because Garnet was not running at that time.' : ''}${job.check ? ' Its pre-check detected a change.' : ''}]`,
      job.instructions,
      job.notifyWhen === 'on_change' ? `If nothing needs your owner's attention, reply with exactly ${NOTHING}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const { task, text: reply } = await this.deps.run(job, text, signal);
    const tokens = billedTokens(task.usage);
    if (task.status === 'cancelled' && (signal.reason === SHUTDOWN || signal.reason === DELETED)) {
      return { status: 'cancelled', failed: false, taskId: task.id, tokens, message: null };
    }
    const failed = task.status === 'failed' || task.status === 'cancelled';
    const q = quietReply(reply);
    // Completed runs with nothing to report stay quiet unless the job asks for every result.
    const quiet = task.status === 'completed' && job.notifyWhen !== 'always' && q.nothing;
    return {
      status: task.status as TaskStatus as JobRunStatus,
      failed,
      taskId: task.id,
      tokens,
      ...(task.reason ? { note: task.reason, reason: task.reason } : {}),
      message: quiet ? null : `[${job.id}] ${task.status === 'completed' ? q.text : reply}`,
      ...(newCheckValue !== null ? { checkValue: newCheckValue } : {}),
    };
  }

  private notify(job: JobConfig, text: string, taint?: readonly string[]): void {
    try {
      this.deps.notify(job, text, taint?.length ? { taint } : undefined);
    } catch (e) {
      this.log('warn', `notify for ${job.id} failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Built-in pre-checks, run under the job's effective policy like the agent's own tools would be: `file_changed`
   * needs `fs.read` and `url_changed` needs `net.fetch`. Nobody can approve a pre-check, so `ask` is a refusal too.
   * A refused or failed check fails the run (and is counted towards pausing); it never reads or fetches anyway.
   */
  private readonly builtinCheck: CheckFn = async (job, signal) => {
    const check = job.check!;
    const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
    if (check.type === 'file_changed') {
      const file = resolveInWorkspace(this.deps.workspace, check.path);
      this.requireAllowed(job, 'fs.read', file);
      return hash(await readBounded(file));
    }
    this.requireAllowed(job, 'net.fetch', check.url);
    if (!this.deps.fetcher) throw new GarnetError('denied', `Pre-check for job "${job.id}" refused: no guarded HTTP client is configured.`);
    const res = await this.deps.fetcher.fetch(check.url, { signal });
    return hash(`${res.status}\n${res.truncated ? 'truncated\n' : ''}`.concat(res.body.toString('utf8')));
  };

  private requireAllowed(job: JobConfig, capability: 'fs.read' | 'net.fetch', target: string): void {
    const policy = this.deps.policyFor?.(job);
    const decision = policy?.check(capability, { targets: [target] });
    if (decision?.verdict === 'allow') return;
    const why = decision ? (decision.verdict === 'ask' ? `${capability} needs approval, and a pre-check cannot ask` : decision.reason) : 'no policy is configured';
    throw new GarnetError('denied', `Pre-check for job "${job.id}" refused: ${why}. Grant ${capability} to the job (and allow it globally) or remove the check.`);
  }
}

/** A file's size plus its first `MAX_CHECK_FILE_BYTES`, or a marker when it cannot be read (missing, a directory, ...). */
async function readBounded(file: string): Promise<Buffer> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const buf = Buffer.alloc(Math.min(size, MAX_CHECK_FILE_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return Buffer.concat([Buffer.from(`${size}\n`), buf.subarray(0, bytesRead)]);
    } finally {
      await handle.close();
    }
  } catch {
    return Buffer.from('<missing>');
  }
}
