// Reads OpenClaw 2026.9.x shared state (~/.openclaw/state/openclaw.sqlite) READ-ONLY: automation
// jobs with their heartbeat scratch, and approved pairing senders. The schema is taken from
// OpenClaw's src/state/openclaw-state-schema.sql (2026.9.8). If the tables or columns differ,
// nothing is read and the caller warns.
import { DatabaseSync } from 'node:sqlite';
import type { OpenClawCronRow } from './jobs.ts';

export type OpenClawState = {
  jobs: OpenClawCronRow[];
  allow: { channel: string; account: string; entry: string }[];
  /** Problems the owner should know about (unknown schema, unreadable file). */
  problems: string[];
};

const NEEDED: Record<string, string[]> = {
  cron_jobs: ['store_key', 'job_id', 'name', 'enabled', 'payload_kind', 'job_json', 'sort_order'],
  cron_job_scratch: ['store_key', 'job_id', 'content'],
  channel_pairing_allow_entries: ['channel_key', 'account_id', 'entry', 'sort_order'],
};

export function readOpenClawState(file: string): OpenClawState {
  const state: OpenClawState = { jobs: [], allow: [], problems: [] };
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    state.problems.push(`could not open it read-only (${(e as Error).message})`);
    return state;
  }
  try {
    const has = (table: string): boolean => {
      const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      const missing = NEEDED[table]!.filter((c) => !cols.has(c));
      if (cols.size && missing.length) state.problems.push(`table ${table} has an unknown layout (missing ${missing.join(', ')})`);
      else if (!cols.size && table !== 'cron_job_scratch') state.problems.push(`it has no ${table} table (a different OpenClaw version?)`);
      return cols.size > 0 && missing.length === 0;
    };
    if (has('cron_jobs')) {
      const scratch = new Map<string, string>();
      if (has('cron_job_scratch')) {
        for (const r of db.prepare('SELECT store_key, job_id, content FROM cron_job_scratch WHERE content IS NOT NULL').all() as { store_key: string; job_id: string; content: string }[]) {
          scratch.set(`${r.store_key}\u0000${r.job_id}`, r.content);
        }
      }
      const rows = db.prepare('SELECT store_key, job_id, name, enabled, payload_kind, job_json FROM cron_jobs ORDER BY store_key, sort_order, job_id').all() as {
        store_key: string;
        job_id: string;
        name: string;
        enabled: number;
        payload_kind: string;
        job_json: string;
      }[];
      for (const r of rows) {
        let job: unknown = null;
        try {
          job = JSON.parse(r.job_json);
        } catch {
          state.problems.push(`job "${r.name}" has unreadable JSON and was skipped`);
          continue;
        }
        state.jobs.push({ name: r.name, enabled: r.enabled === 1, payloadKind: r.payload_kind, job, scratch: scratch.get(`${r.store_key}\u0000${r.job_id}`) ?? null });
      }
    }
    if (has('channel_pairing_allow_entries')) {
      const rows = db.prepare('SELECT channel_key, account_id, entry FROM channel_pairing_allow_entries ORDER BY channel_key, account_id, sort_order').all() as {
        channel_key: string;
        account_id: string;
        entry: string;
      }[];
      for (const r of rows) state.allow.push({ channel: r.channel_key, account: r.account_id, entry: r.entry });
    }
  } catch (e) {
    state.problems.push(`could not be read (${(e as Error).message})`);
  } finally {
    db.close();
  }
  return state;
}
