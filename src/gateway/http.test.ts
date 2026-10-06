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

test('the public demo is keyless, tool-less, origin-checked and rate-limited', async () => {
  const { DemoChat } = await import('./index.ts');
  const { FakeModel } = await import('../models/index.ts');
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const model = new FakeModel([{ text: 'Hi from the demo!' }, { text: 'again' }]);
  const demo = new DemoChat({ model, allowedOrigins: ['https://ruby.example'], perIpPerHour: 2, dailyTokenBudget: 10_000, maxOutputTokens: 100 });
  const api = new ApiServer({ gateway: t.gateway, keys: new ApiKeys(keyStore), keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't', demo });
  const { port } = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const post = (origin: string, messages: unknown) =>
    fetch(`http://127.0.0.1:${port}/v1/demo/chat/completions`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  const ok = await post('https://ruby.example', [{ role: 'user', content: 'hello' }]);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://ruby.example');
  assert.equal(((await ok.json()) as any).choices[0].message.content, 'Hi from the demo!');
  assert.deepEqual(model.requests[0]!.tools, [], 'no tools in the demo');
  assert.equal((await post('https://evil.example', [{ role: 'user', content: 'x' }])).status, 403);
  await post('https://ruby.example', [{ role: 'user', content: 'two' }]);
  assert.equal((await post('https://ruby.example', [{ role: 'user', content: 'three' }])).status, 429, 'per-IP limit');
});

test('behind a trusted proxy the client IP is the rightmost X-Forwarded-For entry', async () => {
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't', trustProxy: true });
  const { port } = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const { key } = keys.create('app', ['read']);
  // A client can prepend anything; the proxy appends the real address last.
  await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } });
  assert.equal(keyStore.auditLog()[0]!.ip, '203.0.113.9');
});

test('keyless traffic is not audited and failed logins are audited at a limited rate', async () => {
  const s = await server();
  for (let i = 0; i < 5; i++) await s.call('/nope');
  assert.equal(s.keyStore.auditLog().length, 0, 'unknown paths are not audited');
  for (let i = 0; i < 15; i++) await s.call('/v1/models', { key: 'ruby_AAAAAAAA_' + 'x'.repeat(32) });
  const failures = s.keyStore.auditLog().length;
  assert.ok(failures >= 1 && failures <= 5, `failed attempts are audited but limited (got ${failures})`);
  const { key } = s.keys.create('app', ['read']);
  await s.call('/api/sessions', { key });
  assert.equal(s.keyStore.auditLog().length, failures + 1, 'authenticated requests are always audited');
});

test('a request body that trickles in too slowly is cut off with 408', async () => {
  const { connect } = await import('node:net');
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't', bodyTimeoutMs: 100 });
  const { port } = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const { key } = keys.create('app', ['chat']);
  const socket = connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (d) => (received += d.toString()));
  socket.on('error', () => {});
  const closed = new Promise<boolean>((resolve) => {
    socket.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 3000).unref();
  });
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${key}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"mess`);
  const timer = setInterval(() => socket.writable && socket.write(' '), 30);
  const wasClosed = await closed;
  clearInterval(timer);
  socket.destroy();
  assert.ok(wasClosed, 'the server closed the connection');
  assert.match(received, /^HTTP\/1\.1 408/);
});

/** A model whose reply waits until `release()` is called (or the request is aborted). */
function gatedModel() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const requests: unknown[] = [];
  const model = {
    id: 'fake:gated',
    capabilities: { streaming: true, promptCaching: false, contextWindow: 10_000 },
    async *stream(request: { signal?: AbortSignal }) {
      requests.push(request);
      await Promise.race([gate, new Promise((r) => request.signal?.addEventListener('abort', r))]);
      if (request.signal?.aborted) {
        yield { type: 'error' as const, category: 'cancelled' as const, message: 'aborted' };
        return;
      }
      yield {
        type: 'done' as const,
        message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null },
      };
    },
  };
  return { model, requests, release };
}

async function demoServer(dailyTokenBudget: number, model: unknown) {
  const { DemoChat } = await import('./index.ts');
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const demo = new DemoChat({ model: model as never, allowedOrigins: [], perIpPerHour: 100, dailyTokenBudget, maxOutputTokens: 100 });
  const api = new ApiServer({ gateway: t.gateway, keys: new ApiKeys(keyStore), keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't', demo });
  const { port } = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const post = (signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/v1/demo/chat/completions`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  return { post, keyStore };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('the demo budget is reserved up front, so concurrent requests cannot overspend', async () => {
  const g = gatedModel();
  // Room for one reservation (100 output + ~200 estimated input) but not two.
  const d = await demoServer(500, g.model);
  const first = d.post();
  await until(() => g.requests.length === 1);
  const second = await Promise.race([d.post(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
  g.release();
  assert.equal(second?.status, 429, 'the second concurrent request is refused');
  assert.equal((await first).status, 200);
  assert.equal(g.requests.length, 1);
  assert.equal(d.keyStore.auditLog().length, 0, 'demo traffic is not audited');
});

test('disconnecting from the demo does not refund the reservation', async () => {
  const g = gatedModel();
  const d = await demoServer(500, g.model);
  const abort = new AbortController();
  const first = d.post(abort.signal).catch(() => null);
  await until(() => g.requests.length === 1);
  abort.abort();
  await first;
  await new Promise((r) => setTimeout(r, 50));
  g.release();
  const next = await Promise.race([d.post(), new Promise<null>((r) => setTimeout(() => r(null), 300))]);
  assert.equal(next?.status, 429);
});

test('a conflict (job already running) is a 409, not a 500', async () => {
  const { RubyError } = await import('../contracts/index.ts');
  const t = setup();
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const admin = { jobAction: async () => Promise.reject(new RubyError('conflict', 'Job "tea" is already running')) };
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: 10, version: 't', admin: admin as never });
  const { port } = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const { key } = keys.create('root', ['admin']);
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/tea/run`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as any).error.message, /already running/);
});
