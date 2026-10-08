import { textOf, type SessionEvent } from '../contracts/index.ts';
import { transaction, type Db } from './db.ts';
import type { SessionStore } from './sessions.ts';

const MAX_INDEXED_CHARS = 20_000;

export type SearchHit = {
  sessionId: string;
  title: string | null;
  seq: number;
  at: string;
  role: 'user' | 'assistant';
  /** The match with the hit words in [brackets]. */
  snippet: string;
  /** True when the hit's session read untrusted content at some point, so its text may carry it. */
  tainted: boolean;
};

/**
 * Full-text search over what was said in past sessions (user and assistant text; never tool output). The index is
 * derived from the event log and can be dropped at any time: it is built on first use and brought up to date
 * incrementally, and any failure (including an SQLite build without FTS5) disables it instead of failing a turn.
 * It lives in two ordinary tables created here, not in a migration, so a problem with it can never block opening
 * the database.
 */
export class SearchIndex {
  private readonly db: Db;
  private readonly sessions: SessionStore;
  private ready: boolean | null = null;

  constructor(db: Db, sessions: SessionStore) {
    this.db = db;
    this.sessions = sessions;
  }

  /** Creates the tables on first use; false when this SQLite has no FTS5. */
  private init(): boolean {
    if (this.ready !== null) return this.ready;
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(session_id UNINDEXED, seq UNINDEXED, at UNINDEXED, role UNINDEXED, text, tokenize = 'porter unicode61');
        CREATE TABLE IF NOT EXISTS search_progress (session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL);
      `);
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  /** Drops the index; the next search rebuilds it from the event log. */
  reset(): void {
    this.db.exec('DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_progress;');
    this.ready = null;
  }

  /** Indexes events added since the last call, for the given sessions. */
  private sync(sessionIds: readonly string[]): void {
    const progress = this.db.prepare('SELECT last_seq FROM search_progress WHERE session_id = ?');
    const insert = this.db.prepare('INSERT INTO search_fts (session_id, seq, at, role, text) VALUES (?, ?, ?, ?, ?)');
    const save = this.db.prepare('INSERT INTO search_progress (session_id, last_seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq');
    for (const id of sessionIds) {
      if (this.sessions.lastSeq(id) <= ((progress.get(id) as { last_seq: number } | undefined)?.last_seq ?? 0)) continue;
      // Read the position inside the transaction, so two processes on one database cannot both index the same events.
      transaction(this.db, () => {
        const last = (progress.get(id) as { last_seq: number } | undefined)?.last_seq ?? 0;
        const events = this.sessions.events(id, last);
        for (const e of events) {
          const row = indexable(e);
          if (row) insert.run(id, e.seq, e.at, row.role, row.text);
        }
        if (events.length) save.run(id, events.at(-1)!.seq);
      });
    }
  }

  /**
   * Best matches for `query` among `sessionIds`, best first. Every word must appear; words match by stem ("run"
   * finds "running"). Returns null when the index is unavailable.
   */
  search(sessionIds: readonly string[], query: string, opts: { limit: number; sinceIso?: string }): SearchHit[] | null {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return [];
    if (!this.init()) return null;
    try {
      this.sync(sessionIds);
      const match = terms.map((t) => `"${t}"`).join(' ');
      const marks = sessionIds.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT session_id, seq, at, role, snippet(search_fts, 4, '[', ']', '…', 14) AS snippet
           FROM search_fts WHERE search_fts MATCH ? AND session_id IN (${marks}) ${opts.sinceIso ? 'AND at >= ?' : ''}
           ORDER BY bm25(search_fts) LIMIT ?`,
        )
        .all(match, ...sessionIds, ...(opts.sinceIso ? [opts.sinceIso] : []), opts.limit) as { session_id: string; seq: number; at: string; role: 'user' | 'assistant'; snippet: string }[];
      const tainted = this.db.prepare("SELECT 1 FROM events WHERE session_id = ? AND type = 'tainted' LIMIT 1");
      return rows.map((r) => ({
        sessionId: r.session_id,
        title: this.sessions.getSession(r.session_id)?.title ?? null,
        seq: r.seq,
        at: r.at,
        role: r.role,
        snippet: r.snippet,
        tainted: tainted.get(r.session_id) !== undefined,
      }));
    } catch {
      // A damaged index must not fail the turn: drop it so the next search rebuilds it, and say it is unavailable now.
      try {
        this.reset();
      } catch {
        // nothing more to do
      }
      return null;
    }
  }
}

function indexable(e: SessionEvent): { role: 'user' | 'assistant'; text: string } | null {
  if (e.type !== 'user_message' && e.type !== 'assistant_message') return null;
  // Notes the system wrote into the log (approval continuations, notifications) are not the user's words.
  if (e.type === 'user_message' && (e.source === 'approval' || e.source === 'notification')) return null;
  const attached = e.message.content.flatMap((b) => (b.type === 'attachment' && b.text ? [b.text] : []));
  const text = [textOf(e.message), ...attached].join('\n').trim().slice(0, MAX_INDEXED_CHARS);
  return text ? { role: e.type === 'user_message' ? 'user' : 'assistant', text } : null;
}
