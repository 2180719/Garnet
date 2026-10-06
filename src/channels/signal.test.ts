import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { RubyError, type InboundMessage } from '../contracts/index.ts';
import { SignalChannel } from './index.ts';

const ACCOUNT = '+15550001111';
const enc = new TextEncoder();

type Feed = { response: Response; push: (s: string) => void; close: () => void };
type RpcCall = { method: string; params: any; id: number };

/** An SSE response the test drives by hand. Errors when the request aborts. */
function feed(signal?: AbortSignal | null): Feed {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  signal?.addEventListener('abort', () => { try { ctl.error(new Error('aborted')); } catch { /* closed */ } }, { once: true });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (s) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
  };
}

/** What signal-cli's /api/v1/events actually sends: `event:receive` with `{ account, envelope }` as data. */
let eventSeq = 0;
const notification = (envelope: object, extra: object = {}) =>
  `id:1700000000000-${++eventSeq}\nevent:receive\ndata:${JSON.stringify({ account: ACCOUNT, envelope, ...extra })}\n\n`;
/** The JSON-RPC notification shape (also accepted). */
const rpcNotification = (envelope: object) => `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'receive', params: { envelope } })}\n\n`;
const direct = (text: string, ts = 1700000000000) =>
  notification({ source: '+15559998888', sourceNumber: '+15559998888', sourceUuid: 'uuid-1', sourceName: 'Alice', timestamp: ts, dataMessage: { message: text, timestamp: ts } });

function fakeDaemon(opts: { check?: () => Response | Promise<Response>; rpc?: (c: RpcCall) => Response | Promise<Response> } = {}) {
  const feeds: Feed[] = [];
  const queue: Feed[] = [];
  const rpcs: RpcCall[] = [];
  let eventRequests = 0;
  const headersSeen: Array<Record<string, string>> = [];
  const eventUrls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/v1/check') return opts.check ? opts.check() : new Response('', { status: 200 });
    if (path === '/api/v1/events') {
      eventRequests++;
      eventUrls.push(String(url));
      headersSeen.push((init?.headers ?? {}) as Record<string, string>);
      const f = queue.shift() ?? feed(init?.signal);
      if (!feeds.includes(f)) feeds.push(f);
      init?.signal?.addEventListener('abort', () => { try { f.close(); } catch { /* */ } }, { once: true });
      return f.response;
    }
    if (path === '/api/v1/rpc') {
      const call = JSON.parse(String(init?.body)) as RpcCall;
      rpcs.push(call);
      if (opts.rpc) return opts.rpc(call);
      return Response.json({ jsonrpc: '2.0', result: { timestamp: 1700000000000 + call.id, results: [{ type: 'SUCCESS' }] }, id: call.id });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, feeds, queue, rpcs, headersSeen, eventUrls, eventRequests: () => eventRequests };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what = 'condition') {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

function setup(d: ReturnType<typeof fakeDaemon>) {
  const sleeps: number[] = [];
  const channel = new SignalChannel({
    account: ACCOUNT,
    fetch: d.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      await tick();
    },
  });
  return { channel, sleeps };
}

async function started(d = fakeDaemon()) {
  const { channel, sleeps } = setup(d);
  const got: InboundMessage[] = [];
  await channel.start(async (m) => void got.push(m));
  await until(() => d.feeds.length === 1, 'event stream');
  return { d, channel, sleeps, got };
}

test('rejects malformed account numbers', () => {
  for (const account of ['', '15551234567', '+0555123456', '+123', '+1555123456789012', 'abc']) {
    assert.throws(() => new SignalChannel({ account }), (e: unknown) => e instanceof RubyError && e.category === 'config');
  }
  const ch = new SignalChannel({ account: ACCOUNT });
  assert.equal(ch.channel, 'signal');
  assert.equal(ch.account, ACCOUNT);
  assert.deepEqual(ch.capabilities, { maxMessageChars: 4000, dedupesSends: false, typingIndicator: true, maxUploadBytes: 100 * 1024 * 1024 });
});

test('refuses non-loopback http baseUrl but allows loopback and https', () => {
  assert.throws(() => new SignalChannel({ account: ACCOUNT, baseUrl: 'http://192.168.1.5:8080' }), (e: unknown) => e instanceof RubyError && e.category === 'config' && /unauthenticated/.test(e.message));
  assert.throws(() => new SignalChannel({ account: ACCOUNT, baseUrl: 'http://example.com' }), RubyError);
  assert.throws(() => new SignalChannel({ account: ACCOUNT, baseUrl: 'not a url' }), RubyError);
  new SignalChannel({ account: ACCOUNT, baseUrl: 'http://localhost:9000' });
  new SignalChannel({ account: ACCOUNT, baseUrl: 'http://[::1]:8080' });
  new SignalChannel({ account: ACCOUNT, baseUrl: 'https://signal.example.com' });
});

test('start fails with a config error when the daemon is unreachable', async () => {
  const refused = new SignalChannel({ account: ACCOUNT, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await assert.rejects(refused.start(async () => {}), (e: unknown) => e instanceof RubyError && e.category === 'config' && /not reachable at http:\/\/127\.0\.0\.1:8080/.test(e.message) && e.message.includes('signal-cli -a +15550001111 daemon --http 127.0.0.1:8080'));
  const bad = setup(fakeDaemon({ check: () => new Response('', { status: 503 }) })).channel;
  await assert.rejects(bad.start(async () => {}), RubyError);
});

test('parses direct and group messages, keepalives, and events split across chunks', async () => {
  const { d, channel, got } = await started();
  const feedA = d.feeds[0]!;
  feedA.push(': keepalive\n\n');
  feedA.push(direct('hello there'));
  const group = notification({ sourceNumber: '+15557776666', sourceUuid: 'uuid-2', timestamp: 1700000001000, dataMessage: { message: 'in group', groupInfo: { groupId: 'abc/def+=' } } });
  const cut = Math.floor(group.length / 2);
  feedA.push(group.slice(0, cut));
  await tick();
  assert.equal(got.length, 1);
  feedA.push(group.slice(cut));
  // Multi-line data: JSON split over two data: lines, CRLF endings.
  const json = JSON.stringify({ account: ACCOUNT, envelope: { sourceNumber: '+15551112222', timestamp: 5, dataMessage: { message: 'multi' } } });
  const mid = json.indexOf('"envelope"');
  feedA.push(`data: ${json.slice(0, mid)}\r\ndata: ${json.slice(mid)}\r\n\r\n`);
  await until(() => got.length === 3, 'three messages');

  assert.deepEqual(got[0], {
    channel: 'signal', account: ACCOUNT, chatId: '+15559998888', externalId: 'uuid-1:1700000000000',
    sender: { id: 'uuid-1', displayName: 'Alice' }, text: 'hello there', isPrivate: true, receivedAt: '2023-11-14T22:13:20.000Z',
  });
  assert.equal(got[1]!.chatId, 'group:abc/def+=');
  assert.equal(got[1]!.isPrivate, false);
  assert.equal(got[1]!.sender.id, 'uuid-2');
  assert.equal(got[1]!.externalId, 'uuid-2:1700000001000');
  assert.equal(got[2]!.text, 'multi');
  assert.equal(got[2]!.sender.id, '+15551112222');
  assert.equal(channel.health().ok, true);
  await channel.stop();
});

test('ignores receipts, typing, sync and own-account messages', async () => {
  const { d, channel, got } = await started();
  const f = d.feeds[0]!;
  f.push(notification({ sourceNumber: '+15559998888', timestamp: 1, receiptMessage: { when: 1, isDelivery: true } }));
  f.push(notification({ sourceNumber: '+15559998888', timestamp: 2, typingMessage: { action: 'STARTED' } }));
  f.push(notification({ sourceNumber: ACCOUNT, timestamp: 3, syncMessage: { sentMessage: { message: 'mine', destinationNumber: '+15559998888' } } }));
  f.push(notification({ sourceNumber: ACCOUNT, source: ACCOUNT, timestamp: 4, dataMessage: { message: 'note to self' } }));
  f.push(notification({ sourceNumber: '+15559998888', timestamp: 5, dataMessage: { message: '' } }));
  f.push('data: {not json\n\n');
  f.push(`data: ${JSON.stringify({ method: 'other', params: {} })}\n\n`);
  f.push(notification({ sourceNumber: '+15559998888', timestamp: 7, dataMessage: { message: 'other account' } }, { account: '+15550002222' }));
  f.push(direct('real', 6));
  f.push(rpcNotification({ sourceNumber: '+15559998888', timestamp: 8, dataMessage: { message: 'rpc shape' } }));
  await until(() => got.length === 2, 'real messages');
  assert.deepEqual(got.map((m) => m.text), ['real', 'rpc shape']);
  await channel.stop();
});

test('sink failure is retried with backoff, then the message is skipped', async () => {
  const d = fakeDaemon();
  const { channel, sleeps } = setup(d);
  let attemptsFirst = 0;
  const seen: string[] = [];
  await channel.start(async (m) => {
    if (m.text === 'bad') {
      attemptsFirst++;
      throw new Error('db down');
    }
    seen.push(m.text);
  });
  await until(() => d.feeds.length === 1);
  d.feeds[0]!.push(direct('bad', 1));
  d.feeds[0]!.push(direct('good', 2));
  await until(() => seen.length === 1, 'good message');
  assert.equal(attemptsFirst, 4);
  assert.deepEqual(sleeps.slice(0, 3), [1000, 2000, 4000]);
  const h = channel.health();
  assert.match(h.lastError ?? '', /inbound sink failed.*dropped/);
  await channel.stop();
});

test('sink retry succeeds when the failure was transient', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  let n = 0;
  const seen: string[] = [];
  await channel.start(async (m) => {
    if (++n < 3) throw new Error('flaky');
    seen.push(m.text);
  });
  await until(() => d.feeds.length === 1);
  d.feeds[0]!.push(direct('hi'));
  await until(() => seen.length === 1);
  assert.equal(n, 3);
  await channel.stop();
});

test('reconnects with backoff after the stream ends or fails, resending Last-Event-ID', async () => {
  const d = fakeDaemon();
  const first = feed();
  const second = feed();
  d.queue.push(first, second);
  const { channel, sleeps } = setup(d);
  const got: string[] = [];
  await channel.start(async (m) => void got.push(m.text));
  await until(() => d.eventRequests() === 1);
  first.push(direct('one').replace(/^id:[^\n]*\n/, 'id: 41\n'));
  await until(() => got.length === 1);
  first.close();
  await until(() => d.eventRequests() === 2, 'reconnect');
  assert.equal(sleeps[0], 1000);
  assert.equal(d.headersSeen[1]!['last-event-id'], '41');
  assert.equal(d.headersSeen[0]!['last-event-id'], undefined);
  second.push(direct('two', 2));
  await until(() => got.length === 2);
  assert.deepEqual(got, ['one', 'two']);
  await channel.stop();
});

test('backoff doubles up to 30s while the daemon keeps failing', async () => {
  let eventCalls = 0;
  const sleeps: number[] = [];
  const channel = new SignalChannel({
    account: ACCOUNT,
    fetch: (async (url: unknown) => {
      if (String(url).endsWith('/check')) return new Response('', { status: 200 });
      eventCalls++;
      return new Response('', { status: 502 });
    }) as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); await tick(); },
  });
  await channel.start(async () => {});
  await until(() => sleeps.length >= 7);
  assert.deepEqual(sleeps.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.match(channel.health().lastError ?? '', /502/);
  await channel.stop();
  assert.ok(eventCalls >= 7);
});

test('send posts JSON-RPC with incrementing ids and targets recipients or groups', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  const a = await channel.send({ deliveryId: 'd1', channel: 'signal', account: ACCOUNT, chatId: '+15559998888', text: 'hi' });
  const b = await channel.send({ deliveryId: 'd2', channel: 'signal', account: ACCOUNT, chatId: 'group:Zm9v/b+==', text: 'yo' });
  assert.equal(a.status, 'sent');
  assert.equal(b.status, 'sent');
  assert.deepEqual(d.rpcs.map((c) => c.id), [1, 2]);
  assert.deepEqual(d.rpcs[0]!.params, { recipient: ['+15559998888'], message: 'hi' });
  assert.deepEqual(d.rpcs[1]!.params, { groupId: 'Zm9v/b+==', message: 'yo' });
  assert.equal(d.rpcs[0]!.method, 'send');
  if (a.status === 'sent') assert.deepEqual(a.externalIds, [`${ACCOUNT}:1700000000001`]);
});

test('send splits long text at paragraph then line boundaries and reports partial failure', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  const p1 = 'a'.repeat(3000);
  const p2 = 'b'.repeat(3000);
  const r = await channel.send({ deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+15559998888', text: `${p1}\n\n${p2}` });
  assert.equal(r.status, 'sent');
  assert.deepEqual(d.rpcs.map((c) => c.params.message), [p1, p2]);
  const lines = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(1500)).join('\n');
  d.rpcs.length = 0;
  await channel.send({ deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+1', text: lines });
  assert.ok(d.rpcs.every((c) => c.params.message.length <= 4000));
  assert.equal(d.rpcs.map((c) => c.params.message).join('\n'), lines);

  // Once the first chunk is out, a later chunk's transient failure is retried here, not by
  // the gateway (which would resend the first chunk too).
  let n = 0;
  const d2 = fakeDaemon({ rpc: (c) => (++n === 2 ? new Response('down', { status: 503 }) : Response.json({ result: { timestamp: 1, results: [] }, id: c.id })) });
  const s2 = setup(d2);
  const r2 = await s2.channel.send({ deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+1', text: `${p1}\n\n${p2}` });
  assert.equal(r2.status, 'sent');
  assert.deepEqual(d2.rpcs.map((c) => c.params.message), [p1, p2, p2]);
  assert.deepEqual(s2.sleeps, [1000]);

  // If the rest keeps failing, the result is final (not retryable) and says what was delivered.
  let m = 0;
  const d3 = fakeDaemon({ rpc: (c) => (++m >= 2 ? new Response('down', { status: 503 }) : Response.json({ result: { timestamp: 1, results: [] }, id: c.id })) });
  const r3 = await setup(d3).channel.send({ deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+1', text: `${p1}\n\n${p2}` });
  assert.equal(r3.status, 'failed');
  if (r3.status === 'failed') {
    assert.equal(r3.retryable, false);
    assert.match(r3.error, /after sending 1 of 2 chunks\); the rest was not sent/);
  }
  assert.equal(d3.rpcs.filter((c) => c.params.message === p1).length, 1, 'the first chunk is never resent');
});

test('a group send that reached some members counts as sent', async () => {
  const d = fakeDaemon({ rpc: (c) => Response.json({ result: { timestamp: 9, results: [{ type: 'SUCCESS' }, { type: 'NETWORK_FAILURE' }, { type: 'UNREGISTERED_FAILURE' }] }, id: c.id }) });
  const r = await setup(d).channel.send({ deliveryId: 'g', channel: 'signal', account: ACCOUNT, chatId: 'group:abc', text: 'hello all' });
  assert.equal(r.status, 'sent');
  assert.equal(d.rpcs.length, 1, 'not resent to members who already have it');
  const rate = await setup(fakeDaemon({ rpc: (c) => Response.json({ result: { timestamp: 9, results: [{ type: 'RATE_LIMIT_FAILURE' }] }, id: c.id }) })).channel.send({ deliveryId: 'r', channel: 'signal', account: ACCOUNT, chatId: '+1', text: 'x' });
  assert.ok(rate.status === 'failed' && rate.retryable);
});

test('the event stream asks for our account and reconnects when it goes silent', async () => {
  const d = fakeDaemon();
  const errors: (string | null)[] = [];
  const channel: SignalChannel = new SignalChannel({ account: ACCOUNT, fetch: d.fetch, idleTimeoutMs: 20, sleep: async () => { errors.push(channel.health().lastError); await tick(); } });
  await channel.start(async () => {});
  await until(() => d.eventRequests() >= 2, 'reconnect after silence');
  assert.match(errors[0] ?? '', /silent for 20 ms/);
  assert.equal(new URL(d.eventUrls[0]!).searchParams.get('account'), ACCOUNT);
  await channel.stop();
});

test('send maps errors: refused and 5xx retryable; ambiguous ones uncertain; rpc and unregistered not; never throws or leaks text', async () => {
  const secret = 'TOP-SECRET-BODY';
  const mk = (rpc: (c: RpcCall) => Response | Promise<Response>) => setup(fakeDaemon({ rpc })).channel;
  const msg = { deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+15559998888', text: secret };

  // A reset after the request was written may have sent the message: never resend it.
  const net = await mk(() => { throw new TypeError('socket hang up'); }).send(msg);
  assert.equal(net.status, 'uncertain');

  const refused = await mk(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  }).send(msg);
  assert.deepEqual([refused.status, (refused as any).retryable], ['failed', true]);

  const s5 = await mk(() => new Response('unavailable', { status: 503 })).send(msg);
  assert.equal((s5 as any).retryable, true);

  const gateway = await mk(() => new Response('bad gateway', { status: 502 })).send(msg);
  assert.equal(gateway.status, 'uncertain');

  const garbled = await mk(() => new Response('not json', { status: 200 })).send(msg);
  assert.equal(garbled.status, 'uncertain');

  const rpcErr = await mk((c) => Response.json({ error: { code: -32602, message: 'Invalid params' }, id: c.id }, { status: 200 })).send(msg);
  assert.deepEqual([rpcErr.status, (rpcErr as any).retryable], ['failed', false]);

  const unreg = await mk((c) => Response.json({ error: { code: -1, message: 'User +1555 is not registered' }, id: c.id })).send(msg);
  assert.equal((unreg as any).retryable, false);

  const perRecipient = await mk((c) => Response.json({ result: { timestamp: 1, results: [{ type: 'UNREGISTERED_FAILURE' }] }, id: c.id })).send(msg);
  assert.deepEqual([perRecipient.status, (perRecipient as any).retryable], ['failed', false]);
  assert.match((perRecipient as any).error, /UNREGISTERED_FAILURE/);

  const netFail = await mk((c) => Response.json({ result: { timestamp: 1, results: [{ type: 'NETWORK_FAILURE' }] }, id: c.id })).send(msg);
  assert.equal((netFail as any).retryable, true);

  for (const r of [net, refused, s5, gateway, garbled, rpcErr, unreg, perRecipient]) assert.ok(!JSON.stringify(r).includes(secret));
  const empty = await mk(() => new Response('{}')).send({ ...msg, text: '  \n' });
  assert.equal((empty as any).retryable, false);
});

test('typing calls sendTyping and swallows errors', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  await channel.typing('group:xyz');
  await channel.typing('+15559998888');
  assert.deepEqual(d.rpcs.map((c) => [c.method, c.params]), [['sendTyping', { groupId: 'xyz' }], ['sendTyping', { recipient: ['+15559998888'] }]]);
  const broken = setup(fakeDaemon({ rpc: () => { throw new Error('boom'); } })).channel;
  await broken.typing('+1');
});

test('stop ends promptly, aborts the stream, and is idempotent', async () => {
  const { d, channel } = await started();
  const t0 = Date.now();
  await channel.stop();
  await channel.stop();
  assert.ok(Date.now() - t0 < 500);
  const before = d.eventRequests();
  await tick();
  assert.equal(d.eventRequests(), before);
  // Can be restarted after stop.
  await channel.start(async () => {});
  await until(() => d.eventRequests() === before + 1);
  await channel.stop();
});

test('health reports lastSuccessAt and reflects a down stream', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  assert.deepEqual(channel.health(), { ok: false, lastSuccessAt: null, lastError: null });
  await channel.start(async () => {});
  await until(() => d.feeds.length === 1);
  assert.equal(channel.health().ok, true);
  assert.ok(channel.health().lastSuccessAt);
  await channel.stop();
});

test('attachments carry a getAttachment reference; downloads decode base64 and enforce the limit', async () => {
  const d = fakeDaemon({
    rpc: (c) => Response.json({ jsonrpc: '2.0', result: c.method === 'getAttachment' ? { data: Buffer.from('voice!').toString('base64') } : {}, id: c.id }),
  });
  const { channel, got } = await started(d);
  const env = (dataMessage: object) => notification({ source: '+15559998888', sourceNumber: '+15559998888', sourceUuid: 'uuid-1', timestamp: 1700000000001, dataMessage });
  d.feeds[0]!.push(env({ message: null, attachments: [{ id: 'att1.m4a', contentType: 'audio/aac', size: 6, voiceNote: true }] }));
  d.feeds[0]!.push(notification({ sourceNumber: '+15559998888', sourceUuid: 'uuid-1', timestamp: 1700000000002, dataMessage: { message: 'pic', groupInfo: { groupId: 'G1' }, attachments: [{ id: 'att2.jpg', contentType: 'image/jpeg', filename: 'cat.jpg', size: 3 }] } }));
  await until(() => got.length === 2, 'two messages');
  assert.deepEqual(got[0]!.attachments, [{ kind: 'audio', ref: JSON.stringify({ id: 'att1.m4a', recipient: '+15559998888' }), name: 'voice.m4a', mimeType: 'audio/aac', size: 6, liveVoice: true }]);
  assert.equal(got[0]!.text, '');
  assert.equal(JSON.parse(got[1]!.attachments![0]!.ref).groupId, 'G1');
  const file = await channel.fetchAttachment(got[0]!.attachments![0]!.ref, { maxBytes: 100, signal: new AbortController().signal });
  assert.equal(Buffer.from(file.data).toString(), 'voice!');
  assert.deepEqual(d.rpcs.at(-1)!.params, { id: 'att1.m4a', recipient: '+15559998888' });
  await assert.rejects(channel.fetchAttachment(got[0]!.attachments![0]!.ref, { maxBytes: 2, signal: new AbortController().signal }), /too large/);
  await assert.rejects(channel.fetchAttachment('not json', { maxBytes: 2, signal: new AbortController().signal }), /not a Signal attachment/);
  await channel.stop();
});

test('send with a file uses a data URI attachment, with the text in the same message', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  const path = join(tempDir(), 'a.png');
  writeFileSync(path, Buffer.from([1, 2, 3]));
  const r = await channel.send({ deliveryId: 'd', channel: 'signal', account: ACCOUNT, chatId: '+15559998888', text: 'see', attachments: [{ path, name: 'my chart;v2.png', mimeType: 'image/png', kind: 'image', size: 3 }] });
  assert.equal(r.status, 'sent');
  const call = d.rpcs.at(-1)!;
  assert.equal(call.method, 'send');
  assert.deepEqual(call.params, { recipient: ['+15559998888'], message: 'see', attachments: ['data:image/png;filename=my_chart_v2.png;base64,AQID'] });
});

test('send strips markdown, since Signal shows the markers literally', async () => {
  const d = fakeDaemon();
  const { channel } = setup(d);
  await channel.send({ deliveryId: 'x', channel: 'signal', account: ACCOUNT, chatId: '+15559998888', text: '**Saved** `notes.txt`:\n- one' });
  assert.equal((d.rpcs.at(-1)!.params as { message: string }).message, 'Saved notes.txt:\n• one');
});
