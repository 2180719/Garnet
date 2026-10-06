import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { unknownUsage } from '../contracts/index.ts';
import { KeyStore, openDb, SessionStore } from './index.ts';

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
