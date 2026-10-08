import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayStore, openDb, SearchIndex, SessionStore } from './index.ts';

function setup() {
  const db = openDb(':memory:');
  const sessions = new SessionStore(db);
  const gateway = new GatewayStore(db);
  return { db, sessions, gateway, index: new SearchIndex(db, sessions) };
}

const say = (s: SessionStore, id: string, role: 'user' | 'assistant', text: string, source = 'cli') => {
  if (role === 'user') s.append(id, { type: 'user_message', message: { role, content: [{ type: 'text', text }] }, source });
  else s.append(id, { type: 'assistant_message', message: { role, content: [{ type: 'text', text }] }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null }, model: 'm' });
};

const inbound = (chatId: string, externalId: string) => ({ channel: 'telegram', account: 'a', chatId, externalId, sender: { id: 'u1' }, isPrivate: true, text: 'hi', receivedAt: new Date().toISOString() });

test('search finds stems, requires every word, ranks and snippets, and stays current as events arrive', () => {
  const { sessions, index } = setup();
  const a = sessions.createSession('Trip planning');
  say(sessions, a.id, 'user', 'We should book flights to Lisbon in March');
  say(sessions, a.id, 'assistant', 'Booked a flight; hotel next.');
  const hits = index.search([a.id], 'flight lisbon', { limit: 5 })!;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.role, 'user');
  assert.equal(hits[0]!.title, 'Trip planning');
  assert.match(hits[0]!.snippet, /\[flights\]/);
  assert.equal(index.search([a.id], 'lisbon paris', { limit: 5 })!.length, 0, 'every word is required');
  say(sessions, a.id, 'user', 'Also remember the paris layover');
  assert.equal(index.search([a.id], 'lisbon paris', { limit: 5 })!.length, 0, 'different messages do not combine');
  assert.equal(index.search([a.id], 'paris', { limit: 5 })!.length, 1, 'new events are indexed');
});

test('system-written notes and tool output are not indexed; punctuation in a query is harmless', () => {
  const { sessions, index } = setup();
  const a = sessions.createSession();
  say(sessions, a.id, 'user', 'approval continuation secret-token', 'approval');
  say(sessions, a.id, 'user', 'plain words');
  assert.equal(index.search([a.id], 'secret-token', { limit: 5 })!.length, 0);
  assert.equal(index.search([a.id], '"plain" (words', { limit: 5 })!.length, 1);
  assert.deepEqual(index.search([a.id], '!!!', { limit: 5 }), []);
});

test('only the given sessions are searched, and tainted sessions are flagged', () => {
  const { sessions, index } = setup();
  const a = sessions.createSession();
  const b = sessions.createSession();
  say(sessions, a.id, 'user', 'shared keyword alpha');
  say(sessions, b.id, 'user', 'shared keyword beta');
  sessions.append(b.id, { type: 'tainted', source: 'web_fetch https://example.com/' });
  const only = index.search([a.id], 'keyword', { limit: 5 })!;
  assert.deepEqual(only.map((h) => h.sessionId), [a.id]);
  assert.equal(only[0]!.tainted, false);
  const both = index.search([a.id, b.id], 'keyword', { limit: 5 })!;
  assert.deepEqual(both.map((h) => [h.sessionId, h.tainted]).sort(), [[a.id, false], [b.id, true]].sort());
});

test('a dropped or damaged index is rebuilt from the event log', () => {
  const { db, sessions, index } = setup();
  const a = sessions.createSession();
  say(sessions, a.id, 'user', 'remember the zebra');
  assert.equal(index.search([a.id], 'zebra', { limit: 5 })!.length, 1);
  db.exec('DROP TABLE search_fts');
  // The progress table says everything is indexed, but the search table is gone: the failure drops both...
  assert.equal(index.search([a.id], 'zebra', { limit: 5 }), null);
  // ...so the next search rebuilds from scratch.
  assert.equal(index.search([a.id], 'zebra', { limit: 5 })!.length, 1);
});

test('searchableSessions: a chat sees its own sessions only; non-chat sessions see other non-chat sessions', () => {
  const { sessions, gateway } = setup();
  const chatOld = sessions.createSession();
  const chatNew = sessions.createSession();
  const other = sessions.createSession();
  const cli1 = sessions.createSession();
  const cli2 = sessions.createSession();
  const link = (chatId: string, externalId: string, sessionId: string) => gateway.setInbox(gateway.receive(inbound(chatId, externalId))!.id, 'done', { sessionId });
  link('c1', 'm1', chatOld.id);
  link('c1', 'm2', chatNew.id);
  link('c2', 'm3', other.id);
  assert.deepEqual(gateway.searchableSessions(chatNew.id).sort(), [chatOld.id, chatNew.id].sort());
  assert.deepEqual(gateway.searchableSessions(cli1.id).sort(), [cli1.id, cli2.id].sort(), 'terminal history never includes chats');
});
