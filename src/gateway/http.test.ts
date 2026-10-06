import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setup } from '../../test/fixtures.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../test/helpers.ts';
import type { AttachmentBlock } from '../contracts/index.ts';
import { MediaIngest, MediaStore } from '../media/index.ts';
import { KeyStore } from '../store/index.ts';
import { ApiKeys, ApiServer, type ApiServerDeps } from './index.ts';

async function server(script: Parameters<typeof setup>[0] = [], rate = 100, extra: Partial<ApiServerDeps> = {}, opts: Parameters<typeof setup>[1] = {}) {
  const t = setup(script, opts);
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: rate, version: 'test', ...extra });
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

test('key creation rejects a nonsensical expiry and reports deduplicated scopes', async () => {
  const s = await server();
  for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5000]) {
    assert.throws(() => s.keys.create('k', ['chat'], days), /Expiry must be/, String(days));
  }
  assert.deepEqual(s.keys.create('k', ['chat', 'chat', 'read'], 30).scopes, ['chat', 'read']);
});

test('malformed paging parameters are a 400, not a 500 or an unbounded query', async () => {
  const s = await server();
  const { key } = s.keys.create('reader', ['read', 'admin']);
  for (const q of ['limit=abc', 'limit=-1', 'limit=0', 'limit=1.5', 'limit=100000']) {
    assert.equal((await s.call(`/api/sessions?${q}`, { key })).status, 400, q);
  }
  assert.equal((await s.call('/api/sessions?limit=2', { key })).status, 200);
  const session = s.t.sessions.createSession();
  assert.equal((await s.call(`/api/sessions/${session.id}/events?after=x`, { key })).status, 400);
  assert.equal((await s.call(`/api/sessions/${session.id}/events?after=0`, { key })).status, 200);
});

test('chat completions run a task in a per-key conversation', async () => {
  const s = await server([{ text: 'First answer.' }, { text: 'Second answer.' }]);
  const { key } = s.keys.create('app', ['chat']);
  const r1 = await s.call('/v1/chat/completions', { key, ...chat('hello') });
  const body = (await r1.json()) as any;
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'First answer.');
  assert.equal(body.usage.completion_tokens, 20);
  await s.call('/v1/chat/completions', { key, ...chat('again'), headers: { 'x-ruby-conversation': 'notes' } });
  await s.call('/v1/chat/completions', { key, ...chat('more'), headers: { 'x-ruby-conversation': 'notes' } });
  assert.equal(s.t.model.requests[1]!.messages.length, 1, 'a named conversation is separate');
  assert.equal(s.t.model.requests[2]!.messages.length, 3, 'server-side history continues in a named conversation');
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

async function mediaServer(script: Parameters<typeof setup>[0], images: boolean) {
  const store = new MediaStore(join(tempDir(), 'media'), 100_000);
  const media = new MediaIngest({ store, maxTextChars: 10_000, modelMedia: { images, pdf: false, maxImageBytes: 5_000_000, maxPdfBytes: 0 } });
  const t = setup(script, { gateway: { media }, agent: { loadAttachment: (r) => store.read(r.id) } });
  const keyStore = new KeyStore(t.db);
  const keys = new ApiKeys(keyStore);
  const api = new ApiServer({ gateway: t.gateway, keys, keyStore, sessions: t.sessions, rateLimitPerMinute: 100, version: 'test', maxChatBodyBytes: 200_000 });
  const addr = await api.listen('127.0.0.1', 0);
  after(() => api.close(0));
  const { key } = keys.create('k', ['chat']);
  const post = (content: unknown, extra: object = {}) =>
    fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'ruby', messages: [{ role: 'user', content }], ...extra }),
    });
  return { t, post };
}

const PNG = readFileSync(join(import.meta.dirname, '..', '..', 'test', 'media', 'pixel.png')).toString('base64');

test('chat completions accept image_url parts as data URLs and pass the image to the model', async () => {
  const s = await mediaServer([{ text: 'A pixel.' }], true);
  const res = await s.post([{ type: 'text', text: 'what is it?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}`, detail: 'auto' } }]);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).choices[0].message.content, 'A pixel.');
  const native = s.t.model.requests[0]!.messages.at(-1)!.content.find((b) => b.type === 'attachment') as AttachmentBlock;
  assert.equal(native.data, PNG);
  const imageOnly = await s.post([{ type: 'image_url', image_url: `data:image/png;base64,${PNG}` }]);
  assert.equal(imageOnly.status, 200, 'an image alone is a valid message');
});

test('remote image URLs, unknown parts and oversize bodies are refused; text-only models say so', async () => {
  const s = await mediaServer([], true);
  const remote = await s.post([{ type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } }]);
  assert.equal(remote.status, 400);
  assert.match(((await remote.json()) as any).error.message, /URLs are not fetched; send the image inline as a base64 data URL/);
  const audio = await s.post([{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }]);
  assert.equal(audio.status, 400);
  assert.match(((await audio.json()) as any).error.message, /unsupported_content_type: "input_audio"/);
  const big = await s.post([{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(1_200_000)}` } }]);
  assert.equal(big.status, 413);
  assert.equal(s.t.model.requests.length, 0);

  const blind = await mediaServer([], false);
  const res = await blind.post([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }]);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error.message, /can't view images/);
  const streamed = await blind.post([{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }], { stream: true });
  assert.equal(streamed.status, 200);
  assert.match(await streamed.text(), /can't view images[\s\S]*\[DONE\]/);
  assert.equal(blind.t.model.requests.length, 0);
});

const post = (messages: unknown[], extra: object = {}) => ({ method: 'POST', body: JSON.stringify({ model: 'ruby', messages, ...extra }) });
const turnText = (s: { t: { model: { requests: { messages: { content: { type: string; text?: string }[] }[] }[] } } }, i: number) =>
  s.t.model.requests[i]!.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n');

test('stateless clients get one conversation per chat, keyed by its first message', async () => {
  const s = await server([{ text: 'A1' }, { text: 'B1' }, { text: 'A2' }]);
  const { key } = s.keys.create('webui', ['chat']);
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'Plan a trip' }]) });
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'Fix my bike' }]) });
  // Chat A continues: the client resends its history; Ruby uses only the newest message.
  await s.call('/v1/chat/completions', {
    key,
    ...post([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Plan a trip' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'To Rome' }]),
  });
  assert.equal(s.t.model.requests[1]!.messages.length, 1, 'chat B did not see chat A');
  assert.equal(s.t.model.requests[2]!.messages.length, 3, 'chat A continued its own history');
  assert.doesNotMatch(turnText(s, 2), /bike/);
  const keys = s.t.store.keyForSession(s.t.sessions.listSessions(10)[0]!.id);
  assert.match(keys!, /^api:[^:]+:chat-[0-9a-f]{20}$/);
});

test('the user field scopes chats but does not merge them; X-OpenWebUI-Chat-Id names the chat', async () => {
  const s = await server([{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }]);
  const { key } = s.keys.create('webui', ['chat']);
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'hi' }], { user: 'ada' }) });
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'hi' }], { user: 'bob' }) });
  assert.equal(s.t.model.requests[1]!.messages.length, 1, 'same first message, different user: separate');
  const h = { 'x-openwebui-chat-id': '8a1c0f5e-1111-4222-8333-944455556666' };
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'hello' }]), headers: h });
  await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: 'edited first message' }, { role: 'assistant', content: '3' }, { role: 'user', content: 'next' }]), headers: h });
  assert.equal(s.t.model.requests[3]!.messages.length, 3, 'the chat id wins over the first message');
});

test('an unseen chat with history replays the earlier messages once', async () => {
  const s = await server([{ text: 'ok' }, { text: 'ok2' }]);
  const { key } = s.keys.create('webui', ['chat']);
  const history = [{ role: 'user', content: 'My cat is Tom.' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }, { role: 'assistant', content: 'Noted.' }];
  const r = await s.call('/v1/chat/completions', { key, ...post([...history, { role: 'user', content: "What's my cat called?" }]) });
  assert.equal(r.status, 200, 'content: null in history is accepted');
  assert.match(turnText(s, 0), /Earlier messages in this chat[\s\S]*Owner: My cat is Tom\.[\s\S]*Assistant: Noted\.[\s\S]*What's my cat called\?/);
  await s.call('/v1/chat/completions', { key, ...post([...history, { role: 'user', content: "What's my cat called?" }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Thanks' }]) });
  assert.doesNotMatch(turnText(s, 1).split('\n').at(-1)!, /Earlier messages/, 'not replayed again');
});

test('content parts: text parts are read; images need media handling and a valid data URL', async () => {
  const s = await server([{ text: 'seen' }]);
  const { key } = s.keys.create('app', ['chat']);
  const parts = [{ type: 'text', text: 'Describe' }, { type: 'text', text: 'please' }];
  const ok = await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: parts }]) });
  assert.equal(ok.status, 200);
  assert.match(turnText(s, 0), /Describe\nplease/);
  const malformed = await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }]) });
  assert.equal(malformed.status, 400);
  assert.match(((await malformed.json()) as any).error.message, /Malformed image data URL/);
  const png = `data:image/png;base64,${readFileSync(join(import.meta.dirname, '..', '..', 'test', 'media', 'pixel.png')).toString('base64')}`;
  const off = await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }] }]) });
  assert.equal(off.status, 400, 'this server has no media ingest (media.enabled false)');
  assert.match(((await off.json()) as any).error.message, /media handling is off/);
  const empty = await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: null }]) });
  assert.equal(empty.status, 400);
});

test("Open WebUI's title, tag and follow-up tasks are answered without a model call or a conversation", async () => {
  const s = await server();
  const { key } = s.keys.create('webui', ['chat']);
  const task = (output: string) =>
    `### Task:\nGenerate something.\n### Output:\nJSON format: ${output}\n### Chat History:\n<chat_history>\nUSER: plan a weekend in Lisbon!\nASSISTANT: Sure.\n</chat_history>`;
  const ask = async (output: string, stream = false) => {
    const r = await s.call('/v1/chat/completions', { key, ...post([{ role: 'user', content: task(output) }], { stream }) });
    if (!stream) return ((await r.json()) as any).choices[0].message.content as string;
    const chunks = (await r.text()).split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    return chunks.map((c) => c.choices[0].delta.content ?? '').join('');
  };
  assert.deepEqual(JSON.parse(await ask('{ "title": "your concise title here" }')), { title: 'Plan a weekend in Lisbon' });
  assert.deepEqual(JSON.parse(await ask('{ "tags": ["tag1"] }')), { tags: ['General'] });
  assert.deepEqual(JSON.parse(await ask('{ "follow_ups": ["Question 1?"] }', true)), { follow_ups: [] });
  assert.deepEqual(JSON.parse(await ask('{ "queries": ["query1"] }')), { queries: [] });
  assert.equal(s.t.model.requests.length, 0);
  assert.equal(s.t.sessions.listSessions(10).length, 0);
});

test('streams send keepalive comments while a task runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await server([{ text: 'late' }], 100, { keepaliveMs: 10 });
  const original = s.t.model.stream.bind(s.t.model);
  s.t.model.stream = async function* (request) {
    await gate;
    yield* original(request);
  };
  const { key } = s.keys.create('app', ['chat']);
  setTimeout(release, 80);
  const res = await s.call('/v1/chat/completions', { key, ...chat('slow', { stream: true }) });
  const text = await res.text();
  assert.ok((text.match(/^: keepalive$/gm) ?? []).length >= 2, text);
  assert.ok(text.trimEnd().endsWith('data: [DONE]'));
});

test('CORS is off by default and allows only listed origins on the OpenAI routes', async () => {
  const off = await server();
  const pre = await off.call('/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://chat.example.com' } });
  assert.equal(pre.status, 401);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);

  const s = await server([], 100, { corsOrigins: ['https://chat.example.com'] });
  const ok = await s.call('/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://chat.example.com', 'access-control-request-method': 'POST' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://chat.example.com');
  assert.match(ok.headers.get('access-control-allow-headers')!, /Authorization/);
  const other = await s.call('/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(other.status, 401);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const admin = await s.call('/api/sessions', { method: 'OPTIONS', headers: { origin: 'https://chat.example.com' } });
  assert.equal(admin.headers.get('access-control-allow-origin'), null, 'admin routes never get CORS');
  const { key } = s.keys.create('app', ['chat']);
  const models = await s.call('/v1/models', { key, headers: { origin: 'https://chat.example.com' } });
  assert.equal(models.status, 200);
  assert.equal(models.headers.get('access-control-allow-origin'), 'https://chat.example.com');
  const noKey = await s.call('/v1/models', { headers: { origin: 'https://chat.example.com' } });
  assert.equal(noKey.status, 401, 'CORS never replaces the key');
});

test('/approve and /deny work in an API chat, only for approvals raised in that conversation', async () => {
  const write = { name: 'write_file', input: { path: 'note.txt', content: 'hi' } };
  const s = await server([{ toolCalls: [write] }, { toolCalls: [write] }, { text: 'Saved.' }], 100, {}, { withApprovals: true });
  const { key } = s.keys.create('webui', ['chat']);
  const { key: other } = s.keys.create('other', ['chat']);
  const h = { 'x-ruby-conversation': 'work' };
  const first = (await (await s.call('/v1/chat/completions', { key, ...chat('save a note'), headers: h })).json()) as any;
  const code = /\/approve ([A-Z0-9]{5})/.exec(first.choices[0].message.content)?.[1];
  assert.ok(code, first.choices[0].message.content);
  const foreign = (await (await s.call('/v1/chat/completions', { key: other, ...chat(`/approve ${code}`), headers: h })).json()) as any;
  assert.match(foreign.choices[0].message.content, /belongs to another conversation/);
  const done = (await (await s.call('/v1/chat/completions', { key, ...chat(`/approve ${code}`), headers: h })).json()) as any;
  assert.equal(done.choices[0].message.content, 'Saved.');
  assert.ok(s.t.approvals.get(code!)?.usedAt);
  const again = (await (await s.call('/v1/chat/completions', { key, ...chat(`/deny ${code}`), headers: h })).json()) as any;
  assert.match(again.choices[0].message.content, /No pending approval/);
});
