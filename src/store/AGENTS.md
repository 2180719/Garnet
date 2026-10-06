# store

SQLite persistence through `node:sqlite` (WAL mode, foreign keys on).

- WAL growth: automatic checkpoints every 1000 pages, and `journal_size_limit` (16 MiB) truncates the `-wal` file after a burst. Checkpoints can only finish when no read transaction is open: read rows with `get()`/`all()`, never leave an `iterate()` unfinished or a `BEGIN` open across an `await`.
- Migrations re-read the schema version inside their write transaction, so concurrent openers (service and CLI) are safe.
- `claimDue` delivers in order per chat: a message waits while an older one to the same chat is pending or sending.

- Public API: `openDb`, `transaction`, `SessionStore` (sessions, append-only events, tasks, `unfinishedTasks` for recovery).
- Dashboard read queries (`StatsStore.sessionPage`/`failurePage`, `KeyStore.auditPage`, `GatewayStore.conversationPage`, `SessionStore.eventsPage`) page with `limit`/`offset` or `afterSeq` and return totals.
- Schema changes: append a new entry to `MIGRATIONS` in `db.ts`. Never edit a released migration.
- Event sequence numbers are assigned inside a transaction; callers never choose them.
- Must not: interpret event payloads beyond storing them, or call models or tools.
