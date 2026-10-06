// The set of jobs: owner-written ones from config.json plus jobs stored in the
// database (created from chat with the schedule tool, or from the CLI or
// dashboard). Validation, provenance and limits live here so the tool, CLI and
// dashboard all apply the same rules.
import { jobSchema, type JobConfig } from '../config/index.ts';
import { RubyError } from '../contracts/index.ts';
import type { JobRun, JobState, JobStore } from '../store/index.ts';
import { minGapMinutes, nextRunOf } from './when.ts';

/** Who created a stored job, and from where. Config jobs have origin `config`. */
export type JobOrigin =
  | { by: 'config' }
  /** Created by Ruby with the schedule tool. `conversation` is the chat it was created in, when there was one. */
  | { by: 'agent'; sessionId: string; conversation: string | null; at: string }
  | { by: 'owner'; via: 'cli' | 'dashboard'; at: string };

export type JobEntry = {
  job: JobConfig;
  origin: JobOrigin;
  /** Owner time zone applied to this job (its own `timezone`, else the owner's). */
  zone: string;
  state: JobState;
  /** Next due time; null when disabled, paused, or a once job that already ran. */
  next: Date | null;
  /** A once job whose time has come and gone. */
  done: boolean;
  lastRun: JobRun | null;
};

export type JobBookDeps = {
  /** Jobs from config.json (read-only here). */
  configJobs: JobConfig[];
  store: JobStore;
  /** Owner time zone (config `timezone`, else the host's). */
  timezone: string;
  /** Cap on stored jobs created by Ruby. */
  maxAgentJobs: number;
  now?: () => Date;
};

/** Minimum minutes between runs for jobs Ruby creates. */
export const MIN_AGENT_GAP_MINUTES = 5;
/** Once jobs that ran are kept this long, then dropped from the list. */
const DONE_RETENTION_MS = 30 * 86_400_000;

export class JobBook {
  private readonly deps: JobBookDeps;
  private readonly now: () => Date;
  private readonly removedListeners: ((id: string) => void)[] = [];

  constructor(deps: JobBookDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Called after a stored job is removed, so a running occurrence can be stopped. */
  onRemoved(fn: (id: string) => void): void {
    this.removedListeners.push(fn);
  }

  get timezone(): string {
    return this.deps.timezone;
  }

  zoneOf(job: JobConfig): string {
    return job.timezone ?? this.deps.timezone;
  }

  /** Stored jobs that parse, with their origin. Invalid rows are skipped (and reported by `problems`). */
  private stored(): { job: JobConfig; origin: JobOrigin }[] {
    const configIds = new Set(this.deps.configJobs.map((j) => j.id));
    const out: { job: JobConfig; origin: JobOrigin }[] = [];
    for (const row of this.deps.store.definitions()) {
      if (configIds.has(row.id)) continue; // config.json wins on a name clash
      const parsed = jobSchema.safeParse(row.definition);
      if (!parsed.success || parsed.data.id !== row.id) continue;
      out.push({ job: parsed.data, origin: row.createdBy as JobOrigin });
    }
    return out;
  }

  /** Stored jobs that cannot be scheduled, with the reason (shown by the CLI and dashboard). */
  problems(): { id: string; problem: string }[] {
    const configIds = new Set(this.deps.configJobs.map((j) => j.id));
    return this.deps.store.definitions().flatMap((row) => {
      if (configIds.has(row.id)) return [{ id: row.id, problem: 'A job in config.json has the same name, so this one is ignored.' }];
      const parsed = jobSchema.safeParse(row.definition);
      return parsed.success ? [] : [{ id: row.id, problem: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }];
    });
  }

  /** Every schedulable job (for the scheduler). */
  jobs(): JobConfig[] {
    return [...this.deps.configJobs, ...this.stored().map((s) => s.job)];
  }

  find(id: string): { job: JobConfig; origin: JobOrigin } | undefined {
    const fromConfig = this.deps.configJobs.find((j) => j.id === id);
    if (fromConfig) return { job: fromConfig, origin: { by: 'config' } };
    return this.stored().find((s) => s.job.id === id);
  }

  /** Every job with its state and next run. Once jobs that ran more than 30 days ago are pruned. */
  list(): JobEntry[] {
    const now = this.now();
    const entries: JobEntry[] = [];
    for (const { job, origin } of [...this.deps.configJobs.map((job) => ({ job, origin: { by: 'config' } as JobOrigin })), ...this.stored()]) {
      const entry = this.entry(job, origin, now);
      if (entry.done && origin.by !== 'config' && entry.lastRun && now.getTime() - new Date(entry.lastRun.startedAt).getTime() > DONE_RETENTION_MS) {
        this.deps.store.deleteDefinition(job.id);
        continue;
      }
      entries.push(entry);
    }
    return entries;
  }

  entry(job: JobConfig, origin: JobOrigin, now = this.now()): JobEntry {
    const state = this.deps.store.state(job.id);
    const zone = this.zoneOf(job);
    const raw = nextRunOf(job, state.lastScheduledFor, now, zone);
    const done = job.kind === 'once' && raw === null;
    return { job, origin, zone, state, next: !job.enabled || state.paused ? null : raw, done, lastRun: this.deps.store.runs(job.id, 1)[0] ?? null };
  }

  /** Stored jobs created by Ruby (counted against `maxAgentJobs`; finished once jobs do not count). */
  agentJobCount(): number {
    const now = this.now();
    return this.stored().filter((s) => s.origin.by === 'agent' && !this.entry(s.job, s.origin, now).done).length;
  }

  /** A free job id based on `base` ("water-plants", "water-plants-2", …). */
  freeId(base: string): string {
    const slug = base.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/, '') || 'job';
    const taken = new Set([...this.deps.configJobs.map((j) => j.id), ...this.deps.store.definitions().map((d) => d.id)]);
    if (!taken.has(slug)) return slug;
    for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
  }

  /** Validates a job definition against the schema and Ruby's limits for jobs it creates. */
  validate(definition: unknown, origin: JobOrigin): JobConfig {
    const parsed = jobSchema.safeParse(definition);
    if (!parsed.success) {
      throw new RubyError('invalid_input', `Invalid job: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'job'}: ${i.message}`).join('; ')}`);
    }
    const job = parsed.data;
    const now = this.now();
    if (job.kind === 'once' && new Date(job.at!).getTime() <= now.getTime()) {
      throw new RubyError('invalid_input', `That time (${job.at}) is already in the past. Pick a time in the future.`);
    }
    if (job.check && job.script) throw new RubyError('invalid_input', 'A script job already decides what to send; it cannot also have a pre-check.');
    if (origin.by === 'agent') {
      const gap = minGapMinutes(job, now, this.zoneOf(job));
      if (gap < MIN_AGENT_GAP_MINUTES) throw new RubyError('invalid_input', `That schedule runs every ${gap} minute(s); jobs you create may run at most every ${MIN_AGENT_GAP_MINUTES} minutes.`);
      if (job.permissions['schedule.edit'] !== 'deny') throw new RubyError('denied', 'Scheduled jobs cannot create or change other jobs.');
    }
    return job;
  }

  /** Creates a stored job. Scheduling starts now: a recurring job's first run is its next slot. */
  create(definition: unknown, origin: Exclude<JobOrigin, { by: 'config' }>): JobEntry {
    const job = this.validate(definition, origin);
    if (origin.by === 'agent') {
      const max = this.deps.maxAgentJobs;
      if (max === 0) throw new RubyError('denied', 'Creating jobs from chat is turned off (scheduler.maxAgentJobs is 0).');
      if (this.agentJobCount() >= max) {
        throw new RubyError('denied', `There are already ${max} jobs created from chat (scheduler.maxAgentJobs). Delete one first, or ask the owner to raise the limit.`);
      }
    }
    if (this.deps.configJobs.some((j) => j.id === job.id) || !this.deps.store.insertDefinition(job.id, job, origin)) {
      throw new RubyError('conflict', `A job named "${job.id}" already exists.`);
    }
    // Start from now, so a restart right after creating it still catches up and nothing earlier is backfilled.
    this.deps.store.saveState({ jobId: job.id, consecutiveFailures: 0, paused: false, checkValue: null, lastScheduledFor: this.now().toISOString() });
    return this.entry(job, origin);
  }

  /** Replaces fields of a stored job. Config jobs are changed in config.json only. */
  update(id: string, patch: Partial<JobConfig>, editor: JobOrigin['by']): JobEntry {
    const found = this.find(id);
    if (!found) throw new RubyError('invalid_input', `No job "${id}".`);
    if (found.origin.by === 'config') throw new RubyError('denied', `"${id}" is defined in config.json; only the owner can change it there.`);
    const merged: Record<string, unknown> = { ...found.job, ...patch, id };
    // A new schedule or action replaces the old one entirely.
    const scheduleKeys = ['cron', 'everyMinutes', 'at'] as const;
    if (patch.kind !== undefined || scheduleKeys.some((k) => patch[k] !== undefined)) {
      for (const k of scheduleKeys) if (patch[k] === undefined) delete merged[k];
    }
    const actionKeys = ['instructions', 'message', 'script'] as const;
    if (actionKeys.some((k) => patch[k] !== undefined)) for (const k of actionKeys) if (patch[k] === undefined) delete merged[k];
    const job = this.validate(merged, editor === 'agent' ? { by: 'agent', sessionId: '', conversation: null, at: '' } : { by: 'owner', via: 'cli', at: '' });
    this.deps.store.updateDefinition(id, job);
    const state = this.deps.store.state(id);
    const rescheduled = scheduleKeys.some((k) => JSON.stringify(job[k]) !== JSON.stringify(found.job[k])) || job.kind !== found.job.kind || job.timezone !== found.job.timezone;
    const changedAction = actionKeys.some((k) => JSON.stringify(job[k]) !== JSON.stringify(found.job[k]));
    if (rescheduled || changedAction) {
      this.deps.store.saveState({
        ...state,
        ...(rescheduled ? { lastScheduledFor: this.now().toISOString() } : {}),
        ...(changedAction ? { checkValue: null } : {}),
      });
    }
    return this.entry(job, found.origin);
  }

  /** Deletes a stored job (its run history stays). A running occurrence is stopped. */
  remove(id: string): void {
    const found = this.find(id);
    if (!found) throw new RubyError('invalid_input', `No job "${id}".`);
    if (found.origin.by === 'config') throw new RubyError('denied', `"${id}" is defined in config.json; only the owner can remove it there.`);
    this.deps.store.deleteDefinition(id);
    for (const fn of this.removedListeners) fn(id);
  }

  pause(id: string): JobEntry {
    const found = this.find(id);
    if (!found) throw new RubyError('invalid_input', `No job "${id}".`);
    this.deps.store.saveState({ ...this.deps.store.state(id), paused: true });
    return this.entry(found.job, found.origin);
  }

  resume(id: string): JobEntry {
    const found = this.find(id);
    if (!found) throw new RubyError('invalid_input', `No job "${id}".`);
    this.deps.store.saveState({ ...this.deps.store.state(id), paused: false, consecutiveFailures: 0 });
    return this.entry(found.job, found.origin);
  }
}
