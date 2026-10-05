import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setup } from '../../test/fixtures.ts';
import { KeyStore } from '../store/index.ts';
import { ApiKeys, ApiServer } from './index.ts';

async function server(script: Parameters<typeof setup>[0] = [], rate = 100) {
  const t = setup(script);
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: rate, version: 'test' });
  const addr = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const base = `http://127.0.0.1:${addr.port}`;
  const call = (path: string, init: RequestInit & { key?: string } = {}) =>
    fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.headers ?? {}) } });
  return { t, keys, keyStore, api, call };
}

const chat = (content: string, extra: object = {}) => ({ method: 'POST', body: JSON.stringify({ model: 'ruby', messages: [{ role: 'user', content }], ...extra }) });

test('health is public; everything else needs a valid key', async () => {
  const s = await server();
  assert.equal((await s.call('/health')).status, 200);
  assert.equal((await s.call('/v1/models')).status, 401);
  assert.equal((await s.call('/v1/models', { key: 'ruby_AAAAAAAA_' + 'x'.repeat(32) })).status, 401);
  const { key, id } = s.keys.create('laptop', ['chat']);
  assert.equal((await s.call('/v1/models', { key })).status, 200);
  assert.equal((await s.call('/v1/models', { key: key.slice(0, -1) + (key.endsWith('a') ? 'b' : 'a') })).status, 401, 'one wrong character fails');
  s.keys.revoke(id);
  assert.equal((await s.call('/v1/models', { key })).status, 401, 'revoked keys fail');
  const audit = s.keyStore.auditLog();
  assert.ok(audit.some((a) => a.status === 401) && audit.some((a) => a.keyId === id && a.status === 200));
  assert.ok(!audit.some((a) => a.path === '/health'));
});

test('scopes are enforced and admin implies all', async () => {
  const s = await server([{ text: 'hi' }]);
  const read = s.keys.create('reader', ['read']).key;
  const admin = s.keys.create('root', ['admin']).key;
  assert.equal((await s.call('/v1/chat/completions', { key: read, ...chat('hi') })).status, 403);
  assert.equal((await s.call('/api/sessions', { key: read })).status, 200);
  assert.equal((await s.call('/v1/chat/completions', { key: admin, ...chat('hi') })).status, 200);
});

test('chat completions run a task in a per-key conversation', async () => {
  const s = await server([{ text: 'First answer.' }, { text: 'Second answer.' }]);
  const { key } = s.keys.create('app', ['chat']);
  const r1 = await s.call('/v1/chat/completions', { key, ...chat('hello') });
  const body = (await r1.json()) as any;
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'First answer.');
  assert.equal(body.usage.completion_tokens, 20);
  await s.call('/v1/chat/completions', { key, ...chat('again') });
  assert.equal(s.t.model.requests[1]!.messages.length, 3, 'server-side history continues');
  const bad = await s.call('/v1/chat/completions', { key, ...chat('x'), headers: { 'x-ruby-conversation': 'Bad Name!' } });
  assert.equal(bad.status, 400);
});

test('streaming returns OpenAI-style SSE chunks', async () => {
  const s = await server([{ text: 'Streaming works fine here.' }]);
  const { key } = s.keys.create('app', ['chat']);
  const res = await s.call('/v1/chat/completions', { key, ...chat('go', { stream: true }) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  const chunks = text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), 'Streaming works fine here.');
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
});

test('bad input, oversized bodies and rate limits are rejected', async () => {
  const s = await server([], 2);
  const { key } = s.keys.create('app', ['chat']);
  assert.equal((await s.call('/v1/chat/completions', { key, method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await s.call('/v1/chat/completions', { key, method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] }) })).status, 413);
  const limited = await s.call('/v1/models', { key });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('refuses a public bind without any key', async () => {
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const api = new ApiServer({ gateway: t.gateway, keys: new ApiKeys(keyStore), keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't' });
  await assert.rejects(api.listen('0.0.0.0', 0), /without an API key/);
});
