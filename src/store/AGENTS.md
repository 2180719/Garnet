# store

SQLite persistence through `node:sqlite` (WAL mode, foreign keys on).

- Public API: `openDb`, `transaction`, `SessionStore` (sessions, append-only events, tasks, `unfinishedTasks` for recovery).
- Schema changes: append a new entry to `MIGRATIONS` in `db.ts`. Never edit a released migration.
- Event sequence numbers are assigned inside a transaction; callers never choose them.
- Must not: interpret event payloads beyond storing them, or call models or tools.
