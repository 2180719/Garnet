import assert from 'node:assert/strict';
import { existsSync, utimesSync } from 'node:fs';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { createGarnet, runRetention } from '../src/main.ts';
import { parseConfig, CONFIG_VERSION } from '../src/config/index.ts';
import { FakeModel } from '../src/models/index.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const inbox = (db: ReturnType<typeof createGarnet>['db'], id: string, status: string, at: string, attachments: string | null = null) =>
  db
    .prepare(
      `INSERT INTO inbox (id, channel, account, chat_id, external_id, sender_id, is_private, text, attachments, received_at, status)
       VALUES (?, 'telegram', 'a', 'c', ?, 's', 1, 'hi', ?, ?, ?)`,
    )
    .run(id, id, attachments, at, status);
const outbox = (db: ReturnType<typeof createGarnet>['db'], id: string, status: string, at: string, attachments: string | null = null) =>
  db
    .prepare(
      `INSERT INTO outbox (delivery_id, channel, account, chat_id, text, attachments, status, next_attempt_at, created_at, sent_at)
       VALUES (?, 'telegram', 'a', 'c', 'x', ?, ?, ?, ?, ?)`,
    )
    .run(id, attachments, status, at, at, status === 'sent' ? at : null);
const ids = (db: ReturnType<typeof createGarnet>['db'], sql: string) => (db.prepare(sql).all() as { id: string }[]).map((r) => r.id).sort();

function setup() {
  const home = tempDir();
  const garnet = createGarnet({ home, memoryDb: true, model: new FakeModel([]) });
  return { garnet, home };
}

test('retention defaults to 90 days for every table and can be switched off per table', () => {
  const c = parseConfig({ version: CONFIG_VERSION });
  assert.deepEqual(c.retention, { inboxDays: 90, outboxDays: 90, sentMessagesDays: 90, jobRunsDays: 90, approvalsDays: 90, mediaDays: 90 });
  assert.equal(parseConfig({ version: CONFIG_VERSION, retention: { inboxDays: 0 } }).retention.inboxDays, 0);
});

test('retention removes old finished rows and keeps anything pending, recent or still referenced', () => {
  const { garnet } = setup();
  try {
    const { db } = garnet;
    for (const s of ['done', 'ignored']) inbox(db, `old-${s}`, s, ago(100));
    for (const s of ['pending', 'processing', 'interrupted']) inbox(db, `old-${s}`, s, ago(100));
    inbox(db, 'new-done', 'done', ago(10));
    for (const s of ['sent', 'failed']) outbox(db, `old-${s}`, s, ago(100));
    for (const s of ['pending', 'sending', 'uncertain']) outbox(db, `old-${s}`, s, ago(100));
    outbox(db, 'new-sent', 'sent', ago(10));
    db.prepare("INSERT INTO sent_messages (sent_at, session_id, channel, account, chat_id, delivery_id) VALUES (?, 's', 'c', 'a', 'x', 'd')").run(ago(100));
    db.prepare("INSERT INTO sent_messages (sent_at, session_id, channel, account, chat_id, delivery_id) VALUES (?, 's', 'c', 'a', 'x', 'd')").run(ago(1));
    const approval = (code: string, status: string, created: string, expires: string) =>
      db
        .prepare("INSERT INTO approvals (code, session_id, call_id, tool, capability, summary, input_hash, status, created_at, expires_at) VALUES (?, 's', 'c', 't', 'exec', 'x', 'h', ?, ?, ?)")
        .run(code, status, created, expires);
    approval('OLD1', 'approved', ago(100), ago(99));
    approval('OLD2', 'denied', ago(100), ago(99));
    approval('OLD3', 'pending', ago(100), ago(99));
    approval('NEW1', 'approved', ago(5), ago(4));
    approval('LIVE', 'approved', ago(100), new Date(NOW + DAY).toISOString());
    const run = (occ: string, job: string, status: string, at: string) =>
      db.prepare("INSERT INTO job_runs (occurrence_id, job_id, scheduled_for, status, started_at) VALUES (?, ?, ?, ?, ?)").run(occ, job, at, status, at);
    run('a1', 'daily', 'completed', ago(200));
    run('a2', 'daily', 'completed', ago(150));
    run('a3', 'daily', 'completed', ago(5));
    run('b1', 'yearly', 'completed', ago(300)); // newest of its job: kept
    run('c1', 'stuck', 'running', ago(300));

    const r = runRetention(garnet, NOW);
    assert.deepEqual({ ...r }, { inbox: 2, outbox: 2, sentMessages: 1, jobRuns: 2, approvals: 3, media: 0 });
    assert.deepEqual(ids(db, 'SELECT id FROM inbox'), ['new-done', 'old-interrupted', 'old-pending', 'old-processing']);
    assert.deepEqual(ids(db, 'SELECT delivery_id AS id FROM outbox'), ['new-sent', 'old-pending', 'old-sending', 'old-uncertain']);
    assert.deepEqual(ids(db, 'SELECT code AS id FROM approvals'), ['LIVE', 'NEW1']);
    assert.deepEqual(ids(db, 'SELECT occurrence_id AS id FROM job_runs'), ['a3', 'b1', 'c1']);
    assert.equal(ids(db, 'SELECT delivery_id AS id FROM sent_messages').length, 1);
  } finally {
    garnet.close();
  }
});

test('retention never prunes the session event log', () => {
  const { garnet } = setup();
  try {
    const s = garnet.store.createSession('t');
    garnet.store.append(s.id, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'old' }] }, source: 'test' });
    garnet.db.prepare('UPDATE events SET at = ?').run(ago(1000));
    runRetention(garnet, NOW);
    assert.equal(garnet.store.events(s.id).length, 1);
  } finally {
    garnet.close();
  }
});

test('retention keeps media that events, pending inbox or outbox rows refer to and removes old unreferenced files', () => {
  const { garnet } = setup();
  try {
    const store = garnet.mediaStore!;
    const put = (text: string) => store.put({ data: Buffer.from(text), name: `${text}.txt`, mimeType: 'text/plain' });
    const inEvent = put('in event');
    const inInbox = put('in pending inbox');
    const inOutbox = put('in pending outbox');
    const orphan = put('orphan');
    const fresh = put('fresh orphan');
    const old = new Date(NOW - 100 * DAY);
    for (const ref of [inEvent, inInbox, inOutbox, orphan]) utimesSync(store.path(ref.id), old, old);
    utimesSync(store.path(fresh.id), new Date(NOW - 1 * DAY), new Date(NOW - 1 * DAY));

    const s = garnet.store.createSession('t');
    garnet.store.append(s.id, { type: 'user_message', message: { role: 'user', content: [{ type: 'attachment', attachment: inEvent }] }, source: 'test' });
    inbox(garnet.db, 'i1', 'pending', ago(100), JSON.stringify([{ ref: inInbox }]));
    outbox(garnet.db, 'o1', 'pending', ago(100), JSON.stringify([{ ref: inOutbox }]));

    const r = runRetention(garnet, NOW);
    assert.equal(r.media, 1);
    assert.equal(existsSync(store.path(inEvent.id)), true);
    assert.equal(existsSync(store.path(inInbox.id)), true);
    assert.equal(existsSync(store.path(inOutbox.id)), true);
    assert.equal(existsSync(store.path(fresh.id)), true);
    assert.equal(existsSync(store.path(orphan.id)), false);

    // A file only a sent message referred to is released once that row is pruned.
    const late = put('late');
    utimesSync(store.path(late.id), old, old);
    outbox(garnet.db, 'o2', 'sent', ago(100), JSON.stringify([{ ref: late }]));
    assert.equal(runRetention(garnet, NOW).media, 1);
    assert.equal(existsSync(store.path(late.id)), false);

    // put() on an existing old file refreshes it so retention cannot race a new reference.
    const again = put('in event');
    assert.equal(again.id, inEvent.id);
  } finally {
    garnet.close();
  }
});

test('mediaDays 0 and other zero settings keep everything', () => {
  const home = tempDir();
  const garnet = createGarnet({ home, memoryDb: true, model: new FakeModel([]) });
  try {
    const all = { ...garnet.config, retention: { inboxDays: 0, outboxDays: 0, sentMessagesDays: 0, jobRunsDays: 0, approvalsDays: 0, mediaDays: 0 } };
    const ref = garnet.mediaStore!.put({ data: Buffer.from('keep me'), mimeType: 'text/plain' });
    const old = new Date(NOW - 500 * DAY);
    utimesSync(garnet.mediaStore!.path(ref.id), old, old);
    inbox(garnet.db, 'x', 'done', ago(500));
    const r = runRetention({ config: all, db: garnet.db, mediaStore: garnet.mediaStore }, NOW);
    assert.deepEqual({ ...r }, { inbox: 0, outbox: 0, sentMessages: 0, jobRuns: 0, approvals: 0, media: 0 });
    assert.equal(existsSync(garnet.mediaStore!.path(ref.id)), true);
  } finally {
    garnet.close();
  }
});
