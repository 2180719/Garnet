import type { Usage } from '../contracts/index.ts';
import type { Db } from './db.ts';

/** Read-only aggregate queries for the dashboard and achievements. */
export class StatsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private count(sql: string, ...args: (string | number)[]): number {
    return (this.db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;
  }

  counts() {
    return {
      tasksCompleted: this.count("SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed'"),
      tasksTotal: this.count('SELECT COUNT(*) AS n FROM tasks'),
      toolCalls: this.count('SELECT SUM(tool_calls) AS n FROM tasks'),
      sessions: this.count('SELECT COUNT(*) AS n FROM sessions'),
      identities: this.count('SELECT COUNT(*) AS n FROM identities'),
      approvalsDecided: this.count("SELECT COUNT(*) AS n FROM approvals WHERE status != 'pending'"),
      jobRuns: this.count("SELECT COUNT(*) AS n FROM job_runs WHERE status NOT IN ('missed', 'skipped_budget')"),
      quietRuns: this.count("SELECT COUNT(*) AS n FROM job_runs WHERE status = 'skipped_unchanged'"),
      compactions: this.count("SELECT COUNT(*) AS n FROM events WHERE type = 'checkpoint'"),
      apiKeys: this.count('SELECT COUNT(*) AS n FROM api_keys'),
      outboxFailed: this.count("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('failed', 'uncertain')"),
    };
  }

  /** End times of recent completed tasks (for time-of-day achievements). */
  recentTaskEnds(limit = 1000): string[] {
    return (this.db.prepare("SELECT ended_at FROM tasks WHERE status = 'completed' AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?").all(limit) as { ended_at: string }[]).map((r) => r.ended_at);
  }

  /** Tokens per UTC day for the last `days` days. */
  usageByDay(days: number): { day: string; tasks: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; unknown: number }[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT started_at, usage FROM tasks WHERE started_at > ? ORDER BY started_at').all(since) as { started_at: string; usage: string }[];
    const byDay = new Map<string, { day: string; tasks: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; unknown: number }>();
    for (const r of rows) {
      const day = r.started_at.slice(0, 10);
      const d = byDay.get(day) ?? { day, tasks: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unknown: 0 };
      const u = JSON.parse(r.usage) as Usage;
      d.tasks += 1;
      if (u.inputTokens === null && u.outputTokens === null) d.unknown += 1;
      d.inputTokens += u.inputTokens ?? 0;
      d.outputTokens += u.outputTokens ?? 0;
      d.cacheReadTokens += u.cacheReadTokens ?? 0;
      d.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      byDay.set(day, d);
    }
    return [...byDay.values()];
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMetaOnce(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
}
