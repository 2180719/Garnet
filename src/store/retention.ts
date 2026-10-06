import type { Db } from './db.ts';

/** Per table, rows older than this many days are deleted. 0 keeps that table forever. */
export type RetentionDays = {
  inbox: number;
  outbox: number;
  sentMessages: number;
  jobRuns: number;
  approvals: number;
};

export type RetentionResult = Record<keyof RetentionDays, number>;

const DAY_MS = 86_400_000;
const MEDIA_ID = /med_[a-f0-9]{32}/g;

/**
 * Deletes old, finished operational rows. Never touches the session event log
 * (append-only), and never deletes anything still in flight: pending,
 * processing or interrupted inbox rows, pending, sending or uncertain outbox
 * rows, running or waiting job runs, and approvals that are not yet expired.
 */
export function pruneOperationalRows(db: Db, days: RetentionDays, now: number = Date.now()): RetentionResult {
  const cutoff = (n: number): string => new Date(now - n * DAY_MS).toISOString();
  const run = (n: number, sql: string): number => (n > 0 ? Number(db.prepare(sql).run(cutoff(n)).changes) : 0);
  return {
    inbox: run(days.inbox, "DELETE FROM inbox WHERE status IN ('done', 'ignored') AND received_at < ?"),
    outbox: run(days.outbox, "DELETE FROM outbox WHERE status IN ('sent', 'failed') AND COALESCE(sent_at, created_at) < ?"),
    sentMessages: run(days.sentMessages, 'DELETE FROM sent_messages WHERE sent_at < ?'),
    // The newest run of each job stays, so "last run" survives for rarely firing jobs.
    jobRuns: run(
      days.jobRuns,
      `DELETE FROM job_runs
       WHERE status NOT IN ('running', 'waiting_for_user', 'waiting_for_approval')
         AND started_at < ?
         AND occurrence_id NOT IN (SELECT occurrence_id FROM job_runs r WHERE r.started_at = (SELECT MAX(started_at) FROM job_runs WHERE job_id = r.job_id))`,
    ),
    // An approval is deleted only once it has expired, so a granted but unused approval is never lost early.
    approvals: run(days.approvals, 'DELETE FROM approvals WHERE expires_at < ?'),
  };
}

/**
 * Media ids still referenced anywhere: session events, and inbox or outbox
 * rows (a pending delivery needs its file). Found by scanning the stored JSON
 * for `med_<hex>` ids, so it needs no knowledge of event shapes.
 */
export function mediaIdsInUse(db: Db): Set<string> {
  const ids = new Set<string>();
  const scan = (sql: string): void => {
    for (const row of db.prepare(sql).all() as { p: string }[]) {
      for (const m of row.p.matchAll(MEDIA_ID)) ids.add(m[0]);
    }
  };
  scan("SELECT payload AS p FROM events WHERE payload LIKE '%med\\_%' ESCAPE '\\'");
  scan('SELECT attachments AS p FROM inbox WHERE attachments IS NOT NULL');
  scan('SELECT attachments AS p FROM outbox WHERE attachments IS NOT NULL');
  return ids;
}
