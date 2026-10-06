import { nowIso } from '../contracts/index.ts';
import { transaction, type Db } from './db.ts';

export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ApprovalRow = {
  code: string;
  sessionId: string;
  callId: string;
  tool: string;
  capability: string;
  summary: string;
  inputHash: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  usedAt: string | null;
};

type Row = Record<string, string | null>;
const from = (r: Row): ApprovalRow => ({
  code: r.code!,
  sessionId: r.session_id!,
  callId: r.call_id!,
  tool: r.tool!,
  capability: r.capability!,
  summary: r.summary!,
  inputHash: r.input_hash!,
  status: r.status as ApprovalStatus,
  createdAt: r.created_at!,
  expiresAt: r.expires_at!,
  decidedAt: r.decided_at ?? null,
  usedAt: r.used_at ?? null,
});

/** Persisted approval requests. An approval is a single-use grant for one exact operation. */
export class ApprovalStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(a: Omit<ApprovalRow, 'status' | 'decidedAt' | 'usedAt' | 'createdAt'>): ApprovalRow {
    this.db
      .prepare(
        `INSERT INTO approvals (code, session_id, call_id, tool, capability, summary, input_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(a.code, a.sessionId, a.callId, a.tool, a.capability, a.summary, a.inputHash, nowIso(), a.expiresAt);
    return this.get(a.code)!;
  }

  get(code: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE code = ?').get(code.toUpperCase()) as Row | undefined;
    return r && from(r);
  }

  pending(sessionId?: string, now: string = nowIso()): ApprovalRow[] {
    const rows = sessionId
      ? this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND session_id = ? AND expires_at > ? ORDER BY created_at").all(sessionId, now)
      : this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at").all(now);
    return (rows as Row[]).map(from);
  }

  /** Decides a pending, unexpired approval. Returns null if there is none. */
  decide(code: string, status: 'approved' | 'denied', now: string = nowIso()): ApprovalRow | null {
    const changed = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE code = ? AND status = 'pending' AND expires_at > ?")
      .run(status, now, code.toUpperCase(), now).changes;
    return changed ? this.get(code)! : null;
  }

  /** Consumes an approved, unused, unexpired grant for exactly this operation. */
  consumeGrant(sessionId: string, tool: string, inputHash: string, now: string = nowIso()): boolean {
    return transaction(this.db, () => {
      const r = this.db
        .prepare(
          "SELECT code FROM approvals WHERE session_id = ? AND tool = ? AND input_hash = ? AND status = 'approved' AND used_at IS NULL AND expires_at > ? ORDER BY decided_at LIMIT 1",
        )
        .get(sessionId, tool, inputHash, now) as { code: string } | undefined;
      if (!r) return false;
      this.db.prepare('UPDATE approvals SET used_at = ? WHERE code = ?').run(now, r.code);
      return true;
    });
  }
}
