import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RubyError, type InboundMessage } from '../contracts/index.ts';
import { DiscordChannel } from './index.ts';

// A placeholder assembled at runtime so secret scanners don't mistake it for a real token.
const TOKEN = [Buffer.from('123456789012345678').toString('base64'), 'GabcDE', 'abcdefghijklmnopqrstuvwxyz012345678'].join('.');
const BOT_ID = '900';
const HB = 41_250;

type Listener = (ev: any) => void;
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  sent: any[] = [];
  closedWith: number | null = null;
  #listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    if (this.closedWith !== null) return;
    this.closedWith = code ?? 1005;
    queueMicrotask(() => this.#emit('close', { code: this.closedWith }));
  }
  #emit(type: string, ev: object) {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev);
  }
  /** Server -> client gateway payload. */
  push(p: object) {
    this.#emit('message', { data: JSON.stringify(p) });
  }
  serverClose(code: number) {
    this.closedWith = code;
    this.#emit('close', { code });
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what = 'condition') {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

type Req = { method: string; path: string; headers: Record<string, string>; body: any };
type Handler = (req: Req) => Response;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function setup(handlers: Record<string, Handler> = {}) {
  FakeWS.instances = [];
  const reqs: Req[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = String(url).replace('https://discord.test/api/v10', '');
    const req: Req = {
      method: init?.method ?? 'GET',
      path,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    reqs.push(req);
    const h = handlers[`${req.method} ${path.replace(/\/\d+/g, '/:id')}`];
    if (h) return h(req);
    if (path === '/users/@me') return json(200, { id: BOT_ID, username: 'ruby' });
    if (path === '/gateway/bot') return json(200, { url: 'wss://gw.test' });
    if (path.endsWith('/messages')) return json(200, { id: `m${reqs.length}` });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const pending: { ms: number; resolve: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const entry = { ms, resolve: () => resolve() };
      // Aborted sleeps leave the list so tests never "release" one that already ended.
      const drop = () => {
        const i = pending.indexOf(entry);
        if (i >= 0) pending.splice(i, 1);
        resolve();
      };
      if (signal.aborted) return drop();
      pending.push(entry);
      signal.addEventListener('abort', drop, { once: true });
    });
  const channel = new DiscordChannel({
    token: TOKEN,
    apiBase: 'https://discord.test/api/v10',
    fetch: fetchImpl,
    WebSocketImpl: FakeWS as unknown as typeof WebSocket,
    sleep,
  });
  /** Resolve the oldest pending sleep matching the predicate. */
  const release = async (pred: (ms: number) => boolean = () => true) => {
    await until(() => pending.some((p) => pred(p.ms)), 'a pending sleep');
    const i = pending.findIndex((p) => pred(p.ms));
    pending.splice(i, 1)[0]!.resolve();
    await tick();
  };
  /** Resolve the newest pending sleep matching the predicate (avoids the random first-heartbeat jitter sleep). */
  const releaseLast = async (pred: (ms: number) => boolean) => {
    await until(() => pending.some((p) => pred(p.ms)), 'a pending sleep');
    const i = pending.findLastIndex((p) => pred(p.ms));
    pending.splice(i, 1)[0]!.resolve();
    await tick();
  };
  return { channel, reqs, release, releaseLast, pending, ws: () => FakeWS.instances[FakeWS.instances.length - 1]! };
}

async function connect(t: ReturnType<typeof setup>, sink: (m: InboundMessage) => Promise<void> = async () => {}) {
  await t.channel.start(sink);
  await until(() => FakeWS.instances.length === 1, 'socket');
  t.ws().push({ op: 10, d: { heartbeat_interval: HB } });
  await until(() => t.ws().sent.length === 1, 'identify');
  t.ws().push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess', resume_gateway_url: 'wss://resume.test', user: { id: BOT_ID } } });
  await until(() => t.channel.health().ok, 'ready');
}

const msg = (extra: object = {}, author: object = {}) => ({
  id: '555',
  channel_id: '777',
  content: 'hello',
  timestamp: '2024-01-02T03:04:05.000Z',
  author: { id: '42', username: 'ada', global_name: 'Ada L', ...author },
  ...extra,
});

test('rejects a malformed token before any request', () => {
  for (const token of ['', 'abc', 'a.b', 'a.b.c', 'has space.in.it']) {
    assert.throws(() => new DiscordChannel({ token }), (e) => e instanceof RubyError && e.category === 'config' && !e.message.includes(token || '\0'));
  }
});

test('start fails with a config error when Discord returns 401', async () => {
  const t = setup({ 'GET /users/@me': () => json(401, { message: '401: Unauthorized', code: 0 }) });
  await assert.rejects(
    t.channel.start(async () => {}),
    (e) => e instanceof RubyError && e.category === 'config' && e.message === 'Discord rejected the bot token' && !e.message.includes(TOKEN),
  );
  assert.equal(FakeWS.instances.length, 0);
  assert.equal(t.reqs[0]!.headers.authorization, `Bot ${TOKEN}`);
});

test('connects with v=10 json, identifies with the right intents, and records READY', async () => {
  const t = setup();
  await connect(t);
  const ws = t.ws();
  assert.equal(ws.url, 'wss://gw.test/?v=10&encoding=json');
  const identify = ws.sent[0];
  assert.equal(identify.op, 2);
  assert.equal(identify.d.token, TOKEN);
  assert.equal(identify.d.intents, 512 + 4096 + 32768);
  assert.equal(t.channel.health().ok, true);
  await t.channel.stop();
  assert.equal(ws.closedWith, 1000);
  assert.equal(t.channel.health().ok, false);
});

test('maps DMs and guild messages; ignores bots, self, webhooks and empty content', async () => {
  const t = setup();
  const got: InboundMessage[] = [];
  await connect(t, async (m) => {
    got.push(m);
  });
  const ws = t.ws();
  ws.push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: msg() });
  ws.push({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: msg({ id: '556', guild_id: '9' }, { global_name: null }) });
  ws.push({ op: 0, s: 4, t: 'MESSAGE_CREATE', d: msg({ id: '557' }, { bot: true }) });
  ws.push({ op: 0, s: 5, t: 'MESSAGE_CREATE', d: msg({ id: '558' }, { id: BOT_ID }) });
  ws.push({ op: 0, s: 6, t: 'MESSAGE_CREATE', d: msg({ id: '559', content: '' }) });
  ws.push({ op: 0, s: 7, t: 'MESSAGE_CREATE', d: msg({ id: '560', webhook_id: '1' }) });
  await until(() => got.length === 2, 'two messages');
  await tick();
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], {
    channel: 'discord',
    account: 'default',
    chatId: '777',
    externalId: '555',
    sender: { id: '42', displayName: 'Ada L' },
    text: 'hello',
    isPrivate: true,
    receivedAt: '2024-01-02T03:04:05.000Z',
  });
  assert.equal(got[1]!.isPrivate, false);
  assert.equal(got[1]!.sender.displayName, 'ada');
  await t.channel.stop();
});

test('a failing sink is retried then the message is dropped, and later messages still flow', async () => {
  const t = setup();
  let calls = 0;
  const got: string[] = [];
  await connect(t, async (m) => {
    calls++;
    if (m.externalId === '555') throw new Error('db down');
    got.push(m.externalId);
  });
  t.ws().push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: msg() });
  t.ws().push({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: msg({ id: '556' }) });
  for (const d of [1000, 2000, 4000]) await t.release((ms) => ms === d);
  await until(() => got.length === 1, 'second message');
  assert.equal(calls, 5);
  await t.channel.stop();
});

test('heartbeats carry the last sequence number', async () => {
  const t = setup();
  await connect(t);
  t.ws().push({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: msg({ content: '' }) });
  await tick();
  await t.release((ms) => ms < HB); // jittered first beat
  assert.deepEqual(t.ws().sent[1], { op: 1, d: 2 });
  t.ws().push({ op: 11 });
  await t.release((ms) => ms === HB);
  assert.deepEqual(t.ws().sent[2], { op: 1, d: 2 });
  await t.channel.stop();
});

test('a missing heartbeat ACK reconnects and RESUMEs with session and sequence', async () => {
  const t = setup();
  await connect(t);
  const first = t.ws();
  await t.release((ms) => ms < HB); // beat 1, never acked
  await t.release((ms) => ms === HB); // zombie detected
  assert.equal(first.closedWith, 4000);
  assert.match(t.channel.health().lastError ?? '', /heartbeat/);
  await t.release((ms) => ms === 1000); // reconnect backoff
  await until(() => FakeWS.instances.length === 2, 'second socket');
  const second = t.ws();
  assert.equal(second.url, 'wss://resume.test/?v=10&encoding=json');
  second.push({ op: 10, d: { heartbeat_interval: HB } });
  await until(() => second.sent.length === 1, 'resume');
  assert.deepEqual(second.sent[0], { op: 6, d: { token: TOKEN, session_id: 'sess', seq: 1 } });
  second.push({ op: 0, s: 2, t: 'RESUMED', d: {} });
  await until(() => t.channel.health().ok, 'healthy again');
  await t.channel.stop();
});

test('RECONNECT resumes; INVALID_SESSION false re-identifies', async () => {
  const t = setup();
  await connect(t);
  t.ws().push({ op: 7 });
  await until(() => t.pending.some((p) => p.ms === 0), 'immediate retry');
  await t.release((ms) => ms === 0);
  await until(() => FakeWS.instances.length === 2, 'second socket');
  t.ws().push({ op: 10, d: { heartbeat_interval: HB } });
  await until(() => t.ws().sent.length === 1);
  assert.equal(t.ws().sent[0].op, 6);
  t.ws().push({ op: 9, d: false });
  await t.releaseLast((ms) => ms >= 1000 && ms < 5000);
  await until(() => FakeWS.instances.length === 3, 'third socket');
  assert.equal(t.ws().url, 'wss://gw.test/?v=10&encoding=json');
  t.ws().push({ op: 10, d: { heartbeat_interval: HB } });
  await until(() => t.ws().sent.length === 1);
  assert.equal(t.ws().sent[0].op, 2);
  await t.channel.stop();
});

test('close 4014 is fatal and explains the Message Content intent; 4004 is fatal too', async () => {
  const t = setup();
  await connect(t);
  t.ws().serverClose(4014);
  await until(() => !t.channel.health().ok && /Message Content Intent/.test(t.channel.health().lastError ?? ''), 'fatal');
  await tick();
  assert.equal(FakeWS.instances.length, 1, 'no reconnect');
  assert.ok(!(t.channel.health().lastError ?? '').includes(TOKEN));
  await t.channel.stop();

  const u = setup();
  await connect(u);
  u.ws().serverClose(4004);
  await until(() => /rejected the bot token/.test(u.channel.health().lastError ?? ''));
  await u.channel.stop();
});

test('other close codes reconnect with backoff and resume', async () => {
  const t = setup();
  await connect(t);
  t.ws().serverClose(1006);
  await t.release((ms) => ms === 1000);
  await until(() => FakeWS.instances.length === 2);
  t.ws().push({ op: 10, d: { heartbeat_interval: HB } });
  await until(() => t.ws().sent.length === 1);
  assert.equal(t.ws().sent[0].op, 6);
  await t.channel.stop();
});

test('send splits at 2000 chars, never pings, replies on the first chunk only', async () => {
  const t = setup();
  const text = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
  const res = await t.channel.send({ deliveryId: 'd1', channel: 'discord', account: 'default', chatId: '777', text, replyToExternalId: '321' });
  assert.equal(res.status, 'sent');
  const posts = t.reqs.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.path, '/channels/777/messages');
  for (const p of posts) {
    assert.ok(p.body.content.length <= 2000);
    assert.deepEqual(p.body.allowed_mentions, { parse: [] });
    assert.ok(p.body.nonce.length <= 25);
    assert.equal(p.body.enforce_nonce, true);
  }
  assert.notEqual(posts[0]!.body.nonce, posts[1]!.body.nonce);
  assert.deepEqual(posts[0]!.body.message_reference, { message_id: '321', fail_if_not_exists: false });
  assert.equal(posts[1]!.body.message_reference, undefined);
  assert.equal(posts[0]!.body.content, 'a'.repeat(1500));
  assert.equal(t.channel.capabilities.maxMessageChars, 2000);
});

test('send maps 429 (float seconds), 5xx, ambiguous network errors and 4xx without throwing', async () => {
  const send = (t: ReturnType<typeof setup>) =>
    t.channel.send({ deliveryId: 'd', channel: 'discord', account: 'default', chatId: '777', text: 'hi' });
  let t = setup({ 'POST /channels/:id/messages': () => json(429, { message: 'You are being rate limited.', retry_after: 1.5, global: false }) });
  assert.deepEqual(await send(t), { status: 'failed', retryable: true, error: 'Discord POST /channels/:id/messages failed with 429: You are being rate limited.', retryAfterMs: 1500 });
  for (const status of [500, 503]) {
    t = setup({ 'POST /channels/:id/messages': () => json(status, {}) });
    assert.equal(((await send(t)) as any).retryable, true);
  }
  // A gateway error or a success without a message id may hide a created message: never resend it.
  t = setup({ 'POST /channels/:id/messages': () => json(504, {}) });
  assert.equal((await send(t)).status, 'uncertain');
  t = setup({ 'POST /channels/:id/messages': () => json(200, {}) });
  assert.equal((await send(t)).status, 'uncertain');
  // Connection refused happens before the request reaches Discord: safe to retry.
  t = setup({
    'POST /channels/:id/messages': () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    },
  });
  assert.deepEqual(await send(t), { status: 'failed', retryable: true, error: 'Discord POST /channels/:id/messages request failed: fetch failed' });
  for (const status of [400, 403, 404]) {
    t = setup({ 'POST /channels/:id/messages': () => json(status, { message: 'Missing Access', code: 50001 }) });
    const r = await send(t);
    assert.equal(r.status, 'failed');
    assert.equal((r as any).retryable, false);
  }
  t = setup({
    'POST /channels/:id/messages': () => {
      throw new Error(`socket hang up ${TOKEN}`);
    },
  });
  const net = (await send(t)) as any;
  assert.equal(net.status, 'uncertain', 'a reset after sending may have delivered the message');
  assert.ok(!net.error.includes(TOKEN));
  const bad = await t.channel.send({ deliveryId: 'd', channel: 'discord', account: 'default', chatId: '../x', text: 'hi' });
  assert.equal(bad.status, 'failed');
});

test('typing posts to the typing endpoint and swallows errors', async () => {
  const t = setup();
  await t.channel.typing('777');
  assert.deepEqual(
    t.reqs.map((r) => `${r.method} ${r.path}`),
    ['POST /channels/777/typing'],
  );
  const u = setup({ 'POST /channels/:id/typing': () => json(500, {}) });
  await u.channel.typing('777');
});

test('stop is prompt and idempotent, even before READY', async () => {
  const t = setup();
  await t.channel.start(async () => {});
  await until(() => FakeWS.instances.length === 1);
  await t.channel.stop();
  await t.channel.stop();
  assert.equal(t.ws().closedWith, 1000);
});
