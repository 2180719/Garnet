import {
  newId,
  nowIso,
  type SessionEvent,
  type SessionEventPayload,
  type TaskRecord,
  type TaskStatus,
  type Usage,
} from '../contracts/index.ts';
import { transaction, type Db } from './db.ts';

export type SessionRow = { id: string; title: string | null; createdAt: string; updatedAt: string };

/** Persistence for sessions, their ordered event log, and tasks. The event log is append-only. */
export class SessionStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  createSession(title: string | null = null, id: string = newId('ses')): SessionRow {
    const at = nowIso();
    this.db.prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, at, at);
    return { id, title, createdAt: at, updatedAt: at };
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, string> | undefined;
    return r && { id: r.id!, title: r.title ?? null, createdAt: r.created_at!, updatedAt: r.updated_at! };
  }

  listSessions(limit = 50): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<string, string>[];
    return rows.map((r) => ({ id: r.id!, title: r.title ?? null, createdAt: r.created_at!, updatedAt: r.updated_at! }));
  }

  /** Appends an event with the next sequence number for its session. */
  append(sessionId: string, payload: SessionEventPayload): SessionEvent {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?').get(sessionId) as { seq: number };
      const event: SessionEvent = { ...payload, sessionId, seq: row.seq + 1, at: nowIso() };
      this.db
        .prepare('INSERT INTO events (session_id, seq, type, at, payload) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, event.seq, payload.type, event.at, JSON.stringify(payload));
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(event.at, sessionId);
      return event;
    });
  }

  events(sessionId: string, afterSeq = 0): SessionEvent[] {
    const rows = this.db
      .prepare('SELECT seq, at, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq')
      .all(sessionId, afterSeq) as { seq: number; at: string; payload: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as SessionEventPayload), sessionId, seq: r.seq, at: r.at }));
  }

  /** One page of a session's event log: up to `limit` events after `afterSeq`, plus the log's last sequence number. */
  eventsPage(sessionId: string, afterSeq: number, limit: number): { events: SessionEvent[]; lastSeq: number } {
    const rows = this.db
      .prepare('SELECT seq, at, payload FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(sessionId, afterSeq, limit) as { seq: number; at: string; payload: string }[];
    return {
      events: rows.map((r) => ({ ...(JSON.parse(r.payload) as SessionEventPayload), sessionId, seq: r.seq, at: r.at })),
      lastSeq: this.lastSeq(sessionId),
    };
  }

  lastSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?').get(sessionId) as { seq: number };
    return row.seq;
  }

  /** Fails tasks a crash left `running`, so they are never silently resumed. Returns them. */
  failInterrupted(reason: string): TaskRecord[] {
    const tasks = this.unfinishedTasks().filter((t) => t.status === 'running');
    for (const t of tasks) {
      t.status = 'failed';
      t.reason = reason;
      t.endedAt = nowIso();
      this.updateTask(t);
      this.append(t.sessionId, { type: 'task_status', taskId: t.id, status: 'failed', reason });
    }
    return tasks;
  }

  createTask(sessionId: string, usage: Usage): TaskRecord {
    const task: TaskRecord = {
      id: newId('task'),
      sessionId,
      status: 'running',
      usage,
      modelCalls: 0,
      toolCalls: 0,
      startedAt: nowIso(),
      endedAt: null,
      reason: null,
    };
    this.db
      .prepare('INSERT INTO tasks (id, session_id, status, usage, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(task.id, sessionId, task.status, JSON.stringify(usage), task.startedAt);
    return task;
  }

  updateTask(task: TaskRecord): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, usage = ?, model_calls = ?, tool_calls = ?, ended_at = ?, reason = ? WHERE id = ?')
      .run(task.status, JSON.stringify(task.usage), task.modelCalls, task.toolCalls, task.endedAt, task.reason, task.id);
  }

  getTask(id: string): TaskRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      status: r.status as TaskStatus,
      usage: JSON.parse(r.usage as string) as Usage,
      modelCalls: r.model_calls as number,
      toolCalls: r.tool_calls as number,
      startedAt: r.started_at as string,
      endedAt: (r.ended_at as string | null) ?? null,
      reason: (r.reason as string | null) ?? null,
    };
  }

  /** Tasks left non-terminal by a crash or restart. */
  unfinishedTasks(): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE status IN ('running','waiting_for_approval','waiting_for_user')")
      .all() as { id: string }[];
    return rows.map((r) => this.getTask(r.id)!);
  }
}
