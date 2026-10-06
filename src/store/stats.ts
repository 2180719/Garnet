import { costOf, sumCost, type Pricing, type Usage } from '../contracts/index.ts';
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
  usageByDay(days: number, pricing?: Pricing): DayUsage[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT started_at, usage, model_calls FROM tasks WHERE started_at > ? ORDER BY started_at').all(since) as { started_at: string; usage: string; model_calls: number }[];
    const byDay = new Map<string, DayUsage>();
    for (const r of rows) {
      const day = r.started_at.slice(0, 10);
      const d = byDay.get(day) ?? { day, tasks: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unknown: 0, costUsd: null, costUnknownTasks: 0 };
      const u = JSON.parse(r.usage) as Usage;
      d.tasks += 1;
      if (r.model_calls > 0) {
        const c = costOf(u, pricing);
        if (c === null) d.costUnknownTasks += 1;
        else d.costUsd = (d.costUsd ?? 0) + c;
      }
      if (u.inputTokens === null && u.outputTokens === null) d.unknown += 1;
      d.inputTokens += u.inputTokens ?? 0;
      d.outputTokens += u.outputTokens ?? 0;
      d.cacheReadTokens += u.cacheReadTokens ?? 0;
      d.cacheWriteTokens += u.cacheWriteTokens ?? 0;
      byDay.set(day, d);
    }
    return [...byDay.values()];
  }

  /**
   * Cost since `sinceIso`: `known` sums the records whose cost is known (null when none is), `unknown` counts
   * finished model-calling tasks and spend records whose cost cannot be known (never counted as $0).
   * Running tasks are in `known` when priced but never in `unknown` (their usage is still arriving).
   * Counts task usage plus `model_spend` (compaction outside a task). Model calls still not counted:
   * the media describer and transcription, which report no usage to the store.
   */
  costSince(sinceIso: string, pricing: Pricing | undefined): { known: number | null; unknown: number } {
    let known: number | null = null;
    let unknown = 0;
    const add = (usage: string, settled: boolean) => {
      const c = pricing ? costOf(JSON.parse(usage) as Usage, pricing) : null;
      if (c === null) {
        if (settled) unknown += 1;
      } else known = (known ?? 0) + c;
    };
    for (const r of this.db.prepare('SELECT usage, ended_at FROM tasks WHERE started_at >= ? AND model_calls > 0').all(sinceIso) as { usage: string; ended_at: string | null }[]) add(r.usage, r.ended_at !== null);
    for (const r of this.db.prepare('SELECT usage FROM model_spend WHERE at >= ?').all(sinceIso) as { usage: string }[]) add(r.usage, true);
    return { known, unknown };
  }

  /** Known cost since `sinceIso` (unknown records are skipped, not counted as $0). Null with no pricing or no known record. */
  knownCostSince(sinceIso: string, pricing: Pricing | undefined): number | null {
    return this.costSince(sinceIso, pricing).known;
  }

  /** Records model usage that belongs to no task (manual compaction). */
  recordSpend(usage: Usage): void {
    this.db.prepare('INSERT INTO model_spend (at, usage) VALUES (?, ?)').run(new Date().toISOString(), JSON.stringify(usage));
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMetaOnce(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Sessions, newest activity first, with the conversation they belong to and their tasks' status and token totals. */
  sessionPage(opts: { limit: number; offset: number; q?: string; pricing?: Pricing | undefined }): { items: SessionSummary[]; total: number } {
    const conv = `COALESCE((SELECT MIN(key) FROM conversations WHERE session_id = s.id),
      (SELECT channel || ':' || account || ':' || chat_id FROM inbox WHERE session_id = s.id ORDER BY received_at DESC LIMIT 1))`;
    const args: string[] = [];
    let where = '';
    if (opts.q) {
      const like = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
      where = `WHERE s.id LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\' OR ${conv} LIKE ? ESCAPE '\\'`;
      args.push(like, like, like);
    }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s ${where}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.created_at, s.updated_at, ${conv} AS conversation,
                EXISTS (SELECT 1 FROM conversations WHERE session_id = s.id) AS bound,
                (SELECT COUNT(*) FROM events WHERE session_id = s.id) AS events,
                EXISTS (SELECT 1 FROM events WHERE session_id = s.id AND type = 'tainted') AS tainted
         FROM sessions s ${where} ORDER BY s.updated_at DESC, s.id LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset) as Record<string, string | number | null>[];
    const tasks = this.db.prepare('SELECT status, usage, model_calls FROM tasks WHERE session_id = ? ORDER BY started_at, rowid');
    const items = rows.map((r): SessionSummary => {
      const ts = tasks.all(r.id as string) as { status: string; usage: string; model_calls: number }[];
      const usage: Usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null };
      for (const t of ts) {
        const u = JSON.parse(t.usage) as Usage;
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
          if (u[k] !== null) usage[k] = (usage[k] ?? 0) + u[k];
        }
      }
      return {
        id: r.id as string,
        title: (r.title as string | null) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
        conversation: (r.conversation as string | null) ?? null,
        bound: r.bound === 1,
        events: r.events as number,
        tainted: r.tainted === 1,
        tasks: ts.length,
        taskStatus: ts.at(-1)?.status ?? null,
        usage,
        costUsd: sumCost(ts.filter((t) => t.model_calls > 0).map((t) => costOf(JSON.parse(t.usage) as Usage, opts.pricing))),
      };
    });
    return { items, total };
  }

  /** Failed or budget-exhausted tasks and failed or uncertain deliveries, newest first. `kind` and `status` narrow the list. */
  failurePage(opts: { limit: number; offset: number; kind?: string; status?: string }): { items: FailureRow[]; total: number } {
    const parts: string[] = [];
    if (opts.kind !== 'outbox') parts.push("SELECT 'task' AS kind, id, status, COALESCE(ended_at, started_at) AS at, reason AS detail, session_id AS ref FROM tasks WHERE status IN ('failed', 'budget_exhausted')");
    if (opts.kind !== 'task') parts.push("SELECT 'outbox' AS kind, delivery_id AS id, status, COALESCE(sent_at, created_at) AS at, last_error AS detail, channel || ':' || account || ':' || chat_id AS ref FROM outbox WHERE status IN ('failed', 'uncertain')");
    const source = `(${parts.join(' UNION ALL ')})`;
    const args: string[] = [];
    let where = '';
    if (opts.status) { where = 'WHERE status = ?'; args.push(opts.status); }
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${source} ${where}`).get(...args) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM ${source} ${where} ORDER BY at DESC, id LIMIT ? OFFSET ?`).all(...args, opts.limit, opts.offset) as Record<string, string | null>[];
    return { total, items: rows.map((r) => ({ kind: r.kind as 'task' | 'outbox', id: r.id!, status: r.status!, at: r.at!, detail: r.detail ?? null, ref: r.ref ?? null })) };
  }
}

export type DayUsage = {
  day: string;
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unknown: number;
  /** Sum of the known task costs; null when none is known (no pricing, or no usage reported). */
  costUsd: number | null;
  /** Model-calling tasks whose cost is unknown, so `costUsd` is a lower bound when above 0. */
  costUnknownTasks: number;
};

export type SessionSummary = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** Conversation key (`telegram:acct:chat`, `route:name`, `job:id`, ...), or the last chat that used a session no longer bound. */
  conversation: string | null;
  /** False for a session replaced by `/new` or unlinked. */
  bound: boolean;
  events: number;
  /** The session has read untrusted content (a `tainted` event), so risky actions ask first. */
  tainted: boolean;
  tasks: number;
  taskStatus: string | null;
  usage: Usage;
  /** USD for the session's tasks; null if unknown. */
  costUsd: number | null;
};
export type FailureRow = { kind: 'task' | 'outbox'; id: string; status: string; at: string; detail: string | null; ref: string | null };
