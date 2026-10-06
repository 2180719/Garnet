import { nowIso } from '../contracts/index.ts';
import type { Db } from './db.ts';

export type JobRunStatus = 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'cancelled' | 'waiting_for_approval' | 'budget_exhausted' | 'skipped_unchanged' | 'skipped_budget' | 'missed' | 'interrupted';
export type JobRun = {
  occurrenceId: string;
  jobId: string;
  scheduledFor: string;
  status: JobRunStatus;
  startedAt: string;
  endedAt: string | null;
  taskId: string | null;
  tokens: number;
  note: string | null;
};
export type JobState = { jobId: string; consecutiveFailures: number; paused: boolean; checkValue: string | null; lastScheduledFor: string | null };

type Row = Record<string, string | number | null>;
const runFrom = (r: Row): JobRun => ({
  occurrenceId: r.occurrence_id as string,
  jobId: r.job_id as string,
  scheduledFor: r.scheduled_for as string,
  status: r.status as JobRunStatus,
  startedAt: r.started_at as string,
  endedAt: (r.ended_at as string | null) ?? null,
  taskId: (r.task_id as string | null) ?? null,
  tokens: r.tokens as number,
  note: (r.note as string | null) ?? null,
});

/** Run history and per-job state. Occurrence IDs make each scheduled slot run at most once, across restarts. */
export class JobStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Claims an occurrence. Returns false if it was already claimed (duplicate trigger or restart). */
  claim(occurrenceId: string, jobId: string, scheduledFor: string, status: JobRunStatus = 'running', note: string | null = null): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO job_runs (occurrence_id, job_id, scheduled_for, status, started_at, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(occurrenceId, jobId, scheduledFor, status, nowIso(), note);
    return r.changes > 0;
  }

  finish(occurrenceId: string, status: JobRunStatus, fields: { taskId?: string | null; tokens?: number; note?: string | null } = {}): void {
    this.db
      .prepare('UPDATE job_runs SET status = ?, ended_at = ?, task_id = COALESCE(?, task_id), tokens = ?, note = ? WHERE occurrence_id = ?')
      .run(status, nowIso(), fields.taskId ?? null, fields.tokens ?? 0, fields.note ?? null, occurrenceId);
  }

  runs(jobId: string, limit = 20): JobRun[] {
    return (this.db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?').all(jobId, limit) as Row[]).map(runFrom);
  }

  /** Marks runs left `running` by a crash as interrupted. */
  interruptRunning(): number {
    return Number(this.db.prepare("UPDATE job_runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(nowIso()).changes);
  }

  tokensSince(jobId: string, since: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(tokens), 0) AS n FROM job_runs WHERE job_id = ? AND started_at > ?').get(jobId, since) as { n: number };
    return r.n;
  }

  state(jobId: string): JobState {
    const r = this.db.prepare('SELECT * FROM job_state WHERE job_id = ?').get(jobId) as Row | undefined;
    return {
      jobId,
      consecutiveFailures: (r?.consecutive_failures as number) ?? 0,
      paused: r?.paused === 1,
      checkValue: (r?.check_value as string | null) ?? null,
      lastScheduledFor: (r?.last_scheduled_for as string | null) ?? null,
    };
  }

  saveState(s: JobState): void {
    this.db
      .prepare(
        `INSERT INTO job_state (job_id, consecutive_failures, paused, check_value, last_scheduled_for) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, paused = excluded.paused,
         check_value = excluded.check_value, last_scheduled_for = excluded.last_scheduled_for`,
      )
      .run(s.jobId, s.consecutiveFailures, s.paused ? 1 : 0, s.checkValue, s.lastScheduledFor);
  }
}
