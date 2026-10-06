import { newId, nowIso, type InboundMessage, type OutboundMessage } from '../contracts/index.ts';
import { transaction, type Db } from './db.ts';

export type InboxStatus = 'pending' | 'processing' | 'done' | 'ignored' | 'interrupted';
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';

export type InboxRow = InboundMessage & { id: string; status: InboxStatus; sessionId: string | null; taskId: string | null };
export type OutboxRow = OutboundMessage & {
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};
export type Identity = { channel: string; senderId: string; displayName: string | null; role: 'owner'; createdAt: string };
export type PairingCode = {
  code: string;
  channel: string;
  account: string;
  senderId: string;
  senderName: string | null;
  chatId: string;
  createdAt: string;
  expiresAt: string;
};

type Row = Record<string, string | number | null>;

const inboxFrom = (r: Row): InboxRow => ({
  id: r.id as string,
  channel: r.channel as string,
  account: r.account as string,
  chatId: r.chat_id as string,
  externalId: r.external_id as string,
  sender: { id: r.sender_id as string, ...(r.sender_name ? { displayName: r.sender_name as string } : {}) },
  isPrivate: r.is_private === 1,
  text: r.text as string,
  receivedAt: r.received_at as string,
  status: r.status as InboxStatus,
  sessionId: (r.session_id as string | null) ?? null,
  taskId: (r.task_id as string | null) ?? null,
});

const outboxFrom = (r: Row): OutboxRow => ({
  deliveryId: r.delivery_id as string,
  channel: r.channel as string,
  account: r.account as string,
  chatId: r.chat_id as string,
  text: r.text as string,
  ...(r.reply_to ? { replyToExternalId: r.reply_to as string } : {}),
  status: r.status as OutboxStatus,
  attempts: r.attempts as number,
  nextAttemptAt: r.next_attempt_at as string,
  lastError: (r.last_error as string | null) ?? null,
  createdAt: r.created_at as string,
  sentAt: (r.sent_at as string | null) ?? null,
});

/** Durable gateway state: inbox, outbox, identities, pairing codes and conversation bindings. */
export class GatewayStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Persists an inbound message. Returns null when it was already received (duplicate delivery). */
  receive(m: InboundMessage): InboxRow | null {
    const id = newId('in');
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox (id, channel, account, chat_id, external_id, sender_id, sender_name, is_private, text, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(id, m.channel, m.account, m.chatId, m.externalId, m.sender.id, m.sender.displayName ?? null, m.isPrivate ? 1 : 0, m.text, m.receivedAt);
    return result.changes === 0 ? null : this.inbox(id)!;
  }

  inbox(id: string): InboxRow | undefined {
    const r = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row | undefined;
    return r && inboxFrom(r);
  }

  inboxByStatus(status: InboxStatus): InboxRow[] {
    return (this.db.prepare('SELECT * FROM inbox WHERE status = ? ORDER BY received_at, rowid').all(status) as Row[]).map(inboxFrom);
  }

  setInbox(id: string, status: InboxStatus, link: { sessionId?: string; taskId?: string } = {}): void {
    this.db
      .prepare('UPDATE inbox SET status = ?, session_id = COALESCE(?, session_id), task_id = COALESCE(?, task_id) WHERE id = ?')
      .run(status, link.sessionId ?? null, link.taskId ?? null, id);
  }

  enqueue(m: Omit<OutboundMessage, 'deliveryId'>): OutboxRow {
    const deliveryId = newId('out');
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO outbox (delivery_id, channel, account, chat_id, text, reply_to, status, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(deliveryId, m.channel, m.account, m.chatId, m.text, m.replyToExternalId ?? null, at, at);
    return this.outbox(deliveryId)!;
  }

  outbox(deliveryId: string): OutboxRow | undefined {
    const r = this.db.prepare('SELECT * FROM outbox WHERE delivery_id = ?').get(deliveryId) as Row | undefined;
    return r && outboxFrom(r);
  }

  /**
   * Atomically claims due deliveries by moving them to `sending`. Delivery is
   * in order per chat: a message is claimed only when no older message to the
   * same chat is still pending or sending (e.g. waiting out a rate limit), so a
   * later reply can never overtake an earlier one. At most one per chat per call.
   */
  claimDue(now: string, limit = 20): OutboxRow[] {
    return transaction(this.db, () => {
      const rows = (this.db
        .prepare(
          `SELECT * FROM outbox o WHERE o.status = 'pending' AND o.next_attempt_at <= ?
             AND NOT EXISTS (SELECT 1 FROM outbox e WHERE e.channel = o.channel AND e.account = o.account AND e.chat_id = o.chat_id
                             AND e.status IN ('pending', 'sending') AND e.rowid < o.rowid)
           ORDER BY o.rowid LIMIT ?`,
        )
        .all(now, limit) as Row[]).map(outboxFrom);
      const claim = this.db.prepare("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE delivery_id = ?");
      for (const r of rows) claim.run(r.deliveryId);
      return rows.map((r) => ({ ...r, status: 'sending' as const, attempts: r.attempts + 1 }));
    });
  }

  markSent(deliveryId: string): void {
    this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE delivery_id = ?").run(nowIso(), deliveryId);
  }

  markRetry(deliveryId: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare("UPDATE outbox SET status = 'pending', last_error = ?, next_attempt_at = ? WHERE delivery_id = ?")
      .run(error, nextAttemptAt, deliveryId);
  }

  markOutbox(deliveryId: string, status: 'failed' | 'uncertain', error: string): void {
    this.db.prepare('UPDATE outbox SET status = ?, last_error = ? WHERE delivery_id = ?').run(status, error, deliveryId);
  }

  outboxByStatus(status: OutboxStatus): OutboxRow[] {
    return (this.db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY rowid').all(status) as Row[]).map(outboxFrom);
  }

  /** Number of outbox rows per status (for health checks, without loading the rows). */
  outboxCounts(): Record<OutboxStatus, number> {
    const counts: Record<OutboxStatus, number> = { pending: 0, sending: 0, sent: 0, failed: 0, uncertain: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all() as { status: OutboxStatus; n: number }[]) counts[r.status] = r.n;
    return counts;
  }

  identity(channel: string, senderId: string): Identity | undefined {
    const r = this.db.prepare('SELECT * FROM identities WHERE channel = ? AND sender_id = ?').get(channel, senderId) as Row | undefined;
    return r && { channel, senderId, displayName: (r.display_name as string | null) ?? null, role: 'owner', createdAt: r.created_at as string };
  }

  identities(): Identity[] {
    return (this.db.prepare('SELECT * FROM identities ORDER BY created_at').all() as Row[]).map((r) => ({
      channel: r.channel as string,
      senderId: r.sender_id as string,
      displayName: (r.display_name as string | null) ?? null,
      role: 'owner' as const,
      createdAt: r.created_at as string,
    }));
  }

  addIdentity(channel: string, senderId: string, displayName: string | null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO identities (channel, sender_id, display_name, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
      .run(channel, senderId, displayName, nowIso());
  }

  removeIdentity(channel: string, senderId: string): boolean {
    return this.db.prepare('DELETE FROM identities WHERE channel = ? AND sender_id = ?').run(channel, senderId).changes > 0;
  }

  /** The live pairing code for a sender, if any. */
  pairingFor(channel: string, senderId: string, now: string): PairingCode | undefined {
    const r = this.db
      .prepare('SELECT * FROM pairing_codes WHERE channel = ? AND sender_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .get(channel, senderId, now) as Row | undefined;
    return r && pairingFrom(r);
  }

  /** Whether a pairing code exists, expired or not (codes are primary keys, so a new one must be unused). */
  hasPairingCode(code: string): boolean {
    return this.db.prepare('SELECT 1 FROM pairing_codes WHERE code = ?').get(code.toUpperCase()) !== undefined;
  }

  /** Deletes expired pairing codes (they can no longer be approved). Returns how many. */
  pruneExpiredPairings(now: string): number {
    return Number(this.db.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').run(now).changes);
  }

  addPairing(p: PairingCode): void {
    this.db
      .prepare('INSERT INTO pairing_codes (code, channel, account, sender_id, sender_name, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.code, p.channel, p.account, p.senderId, p.senderName, p.chatId, p.createdAt, p.expiresAt);
  }

  pairings(now: string): PairingCode[] {
    return (this.db.prepare('SELECT * FROM pairing_codes WHERE expires_at > ? ORDER BY created_at').all(now) as Row[]).map(pairingFrom);
  }

  /** Deletes a pending pairing request (deny). Returns false when it does not exist. */
  removePairing(code: string): boolean {
    return this.db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code.toUpperCase()).changes > 0;
  }

  /** Consumes a pairing code: the sender becomes an owner identity. */
  approvePairing(code: string, now: string): PairingCode | null {
    return transaction(this.db, () => {
      const r = this.db.prepare('SELECT * FROM pairing_codes WHERE code = ? AND expires_at > ?').get(code.toUpperCase(), now) as Row | undefined;
      if (!r) return null;
      const p = pairingFrom(r);
      this.addIdentity(p.channel, p.senderId, p.senderName);
      this.db.prepare('DELETE FROM pairing_codes WHERE channel = ? AND sender_id = ?').run(p.channel, p.senderId);
      return p;
    });
  }

  conversation(key: string): string | undefined {
    const r = this.db.prepare('SELECT session_id FROM conversations WHERE key = ?').get(key) as { session_id: string } | undefined;
    return r?.session_id;
  }

  /** The conversation currently bound to a session, if any. */
  keyForSession(sessionId: string): string | undefined {
    const r = this.db.prepare('SELECT key FROM conversations WHERE session_id = ?').get(sessionId) as { key: string } | undefined;
    return r?.key;
  }

  bindConversation(key: string, sessionId: string): void {
    this.db
      .prepare('INSERT INTO conversations (key, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at')
      .run(key, sessionId, nowIso());
  }
  /** Conversation bindings, most recently active first, with the session's title and event count. */
  conversationPage(limit: number, offset: number): { items: { key: string; sessionId: string; updatedAt: string; title: string | null; events: number }[]; total: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
    const rows = this.db
      .prepare(
        `SELECT c.key, c.session_id, c.updated_at, s.title,
                (SELECT COUNT(*) FROM events e WHERE e.session_id = c.session_id) AS events
         FROM conversations c JOIN sessions s ON s.id = c.session_id
         ORDER BY c.updated_at DESC, c.key LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Row[];
    return {
      total,
      items: rows.map((r) => ({ key: r.key as string, sessionId: r.session_id as string, updatedAt: r.updated_at as string, title: (r.title as string | null) ?? null, events: r.events as number })),
    };
  }

  /** Forgets a conversation binding. The session and its events stay; the next message starts a fresh session. */
  removeConversation(key: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE key = ?').run(key).changes > 0;
  }
}

const pairingFrom = (r: Row): PairingCode => ({
  code: r.code as string,
  channel: r.channel as string,
  account: r.account as string,
  senderId: r.sender_id as string,
  senderName: (r.sender_name as string | null) ?? null,
  chatId: r.chat_id as string,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
});
