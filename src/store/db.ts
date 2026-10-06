import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Schema migrations, applied in order and recorded in `schema_version`.
 * Never edit a released migration; append a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    status TEXT NOT NULL,
    usage TEXT NOT NULL,
    model_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reason TEXT
  );
  CREATE INDEX tasks_by_session ON tasks(session_id, started_at);
  `,
  `
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    account TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    is_private INTEGER NOT NULL,
    text TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    task_id TEXT,
    UNIQUE (channel, account, chat_id, external_id)
  );
  CREATE INDEX inbox_by_status ON inbox(status, received_at);
  CREATE TABLE outbox (
    delivery_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    account TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE INDEX outbox_due ON outbox(status, next_attempt_at);
  CREATE TABLE identities (
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel, sender_id)
  );
  CREATE TABLE pairing_codes (
    code TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    account TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    chat_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE conversations (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT
  );
  CREATE TABLE api_audit (
    at TEXT NOT NULL,
    key_id TEXT,
    ip TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL
  );
  CREATE INDEX api_audit_by_time ON api_audit(at);
  `,
  `
  CREATE TABLE approvals (
    code TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    capability TEXT NOT NULL,
    summary TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    used_at TEXT
  );
  CREATE INDEX approvals_by_session ON approvals(session_id, status);
  CREATE TABLE job_runs (
    occurrence_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    task_id TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE INDEX job_runs_by_job ON job_runs(job_id, started_at);
  CREATE TABLE job_state (
    job_id TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    check_value TEXT,
    last_scheduled_for TEXT
  );
  `,
  `
  CREATE TABLE achievements (
    id TEXT PRIMARY KEY,
    unlocked_at TEXT NOT NULL
  );
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE INDEX outbox_by_chat ON outbox(channel, account, chat_id, status);
  `,
  `
  ALTER TABLE inbox ADD COLUMN attachments TEXT;
  ALTER TABLE outbox ADD COLUMN attachments TEXT;
  CREATE INDEX inbox_by_session ON inbox(session_id);
  `,
  `
  -- Jobs created from chat (schedule tool), CLI or dashboard; config.json jobs stay in config.
  CREATE TABLE agent_jobs (
    id TEXT PRIMARY KEY,
    definition TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- Messages Garnet sent on its own (send_message), for rate limits and audit.
  CREATE TABLE sent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    account TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL
  );
  CREATE INDEX sent_messages_by_time ON sent_messages(sent_at);
  `,
];

export type Db = DatabaseSync;

/**
 * The WAL is truncated back to this size whenever a checkpoint resets it, so a
 * burst of writes (an import, a long session) does not leave a huge -wal file
 * behind for good. Automatic checkpoints (every 1000 pages, SQLite's default,
 * set explicitly) keep it from growing in normal use; they can complete because
 * Garnet never holds a read transaction open (rows are read with get()/all(),
 * never with a lingering iterate()).
 */
export const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Opens (or creates) the database, enables WAL and foreign keys, and runs pending migrations. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(
    `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA wal_autocheckpoint = 1000; PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`,
  );
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  // The version is re-read inside each write transaction, so two processes opening the
  // database at once (the service and a CLI command after an upgrade) never apply a migration twice.
  const migrateOne = (): boolean =>
    transaction(db, () => {
      const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
      const version = row?.version ?? 0;
      if (version >= MIGRATIONS.length) return false;
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      return true;
    });
  while (migrateOne());
  return db;
}

/** Runs `fn` in an IMMEDIATE transaction, rolling back on any error. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Writes a consistent copy of the database to `target` (safe while Garnet is running). */
export function backupDb(db: Db, target: string): void {
  db.prepare('VACUUM INTO ?').run(target);
}
