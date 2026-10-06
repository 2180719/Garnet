import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { unknownUsage } from '../contracts/index.ts';
import { WAL_SIZE_LIMIT_BYTES } from './db.ts';
import { KeyStore, openDb, SessionStore, transaction } from './index.ts';

test('events append in order and survive reopening', () => {
  const file = join(tempDir(), 'ruby.db');
  let db = openDb(file);
  let store = new SessionStore(db);
  const s = store.createSession('t');
  for (const text of ['a', 'b', 'c']) {
    store.append(s.id, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text }] }, source: 'test' });
  }
  db.close();
  db = openDb(file); // migrations must be idempotent
  store = new SessionStore(db);
  const events = store.events(s.id);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(store.events(s.id, 2).map((e) => e.seq), [3]);
  db.close();
});

test('unfinished tasks are found for recovery', () => {
  const store = new SessionStore(openDb(':memory:'));
  const s = store.createSession();
  const done = store.createTask(s.id, unknownUsage());
  done.status = 'completed';
  store.updateTask(done);
  const open = store.createTask(s.id, unknownUsage());
  assert.deepEqual(store.unfinishedTasks().map((t) => t.id), [open.id]);
});

test('the API audit log is pruned by age and by row count', () => {
  const db = openDb(join(tempDir(), 'ruby.db'));
  const keys = new KeyStore(db);
  const insert = db.prepare('INSERT INTO api_audit (at, key_id, ip, method, path, status) VALUES (?, NULL, NULL, ?, ?, 200)');
  insert.run('2020-01-01T00:00:00.000Z', 'GET', '/old');
  for (let i = 0; i < 5; i++) insert.run(`2026-10-0${i + 1}T00:00:00.000Z`, 'GET', `/p${i}`);
  assert.equal(keys.pruneAudit('2026-01-01T00:00:00.000Z', 3), 3);
  assert.deepEqual(keys.auditLog().map((a) => a.path), ['/p4', '/p3', '/p2']);
  db.close();
});

test('the WAL is checkpointed and truncated after a burst of writes', () => {
  const file = join(tempDir(), 'ruby.db');
  const db = openDb(file);
  assert.deepEqual({ ...db.prepare('PRAGMA journal_size_limit').get() }, { journal_size_limit: WAL_SIZE_LIMIT_BYTES });
  assert.deepEqual({ ...db.prepare('PRAGMA wal_autocheckpoint').get() }, { wal_autocheckpoint: 1000 });
  const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const blob = 'x'.repeat(4000);
  transaction(db, () => {
    for (let i = 0; i < 6000; i++) insert.run(`k${i}`, blob); // ~24 MB in one transaction
  });
  const wal = () => statSync(`${file}-wal`).size;
  assert.ok(wal() > WAL_SIZE_LIMIT_BYTES, 'the burst grew the WAL past the limit');
  // Later small writes checkpoint (no reader holds the WAL) and restart the WAL, truncating it.
  for (let i = 0; i < 3; i++) db.prepare('DELETE FROM meta WHERE key = ?').run(`k${i}`);
  assert.ok(wal() <= WAL_SIZE_LIMIT_BYTES, `WAL is ${wal()} bytes`);
  db.close();
});

test('opening an up-to-date database from a second connection applies no migration again', () => {
  const file = join(tempDir(), 'ruby.db');
  openDb(file).close();
  const a = openDb(file);
  const b = openDb(file); // e.g. a CLI command while the service runs
  const versions = (d: typeof a) => (d.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map((r) => r.version);
  assert.deepEqual(versions(a), versions(b));
  assert.equal(versions(a).length, 1);
  a.close();
  b.close();
});
