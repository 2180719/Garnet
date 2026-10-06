import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { GarnetError, type InboundMessage } from '../contracts/index.ts';
import { TelegramChannel } from './index.ts';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x';

type Call = { method: string; body: any };
type Handler = (body: any, signal: AbortSignal | undefined) => Response | Promise<Response>;

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (status: number, description: string, parameters?: object) =>
  new Response(JSON.stringify({ ok: false, error_code: status, description, parameters }), { status });
/** Never resolves until the request is aborted, like a long poll with no updates. */
const hang: Handler = (_body, signal) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
  });

/** Routes on the Bot API method name. getUpdates replies come from a script, then hang. */
function fakeApi(handlers: Record<string, Handler> = {}, updateScript: Handler[] = []) {
  const calls: Call[] = [];
  const queue = [...updateScript];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body instanceof FormData ? init.body : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    if (method === 'getUpdates') return (queue.shift() ?? hang)(body, init?.signal ?? undefined);
    const handler = handlers[method];
    if (handler) return handler(body, init?.signal ?? undefined);
    if (method === 'getMe') return ok({ id: 1, is_bot: true, username: 'garnet_bot' });
    if (method === 'deleteWebhook') return ok(true);
    return ok(true);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what = 'condition') {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

function setup(api: ReturnType<typeof fakeApi>) {
  const sleeps: number[] = [];
  const channel = new TelegramChannel({
    token: TOKEN,
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      await tick();
    },
  });
  return { channel, sleeps };
}

const textUpdate = (id: number, text: string, extra: object = {}) => ({
  update_id: id,
  message: { message_id: id * 10, date: 1_700_000_000, text, from: { id: 42, first_name: 'Ada', last_name: 'Lovelace' }, chat: { id: 42, type: 'private' }, ...extra },
});

test('rejects a malformed token before any request', () => {
  const api = fakeApi();
  for (const token of ['', 'abc', '123:short', 'notdigits:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_x']) {
    assert.throws(() => new TelegramChannel({ token, fetch: api.fetch }), (e) => e instanceof GarnetError && e.category === 'config' && !e.message.includes(token || '\0'));
  }
  assert.equal(api.calls.length, 0);
});

test('start fails fast with a config error when Telegram rejects the token', async () => {
  for (const status of [401, 404]) {
    const api = fakeApi({ getMe: () => fail(status, 'Unauthorized') });
    const { channel } = setup(api);
    await assert.rejects(
      channel.start(async () => {}),
      (e) => e instanceof GarnetError && e.category === 'config' && e.message === 'Telegram rejected the bot token' && !e.message.includes(TOKEN),
    );
    assert.equal(api.of('getUpdates').length, 0);
  }
});

test('start calls getMe, then deleteWebhook (keeping pending updates), then long polls for messages only', async () => {
  const api = fakeApi();
  const { channel } = setup(api);
  await channel.start(async () => {});
  await until(() => api.of('getUpdates').length === 1);
  assert.deepEqual(api.calls.map((c) => c.method).slice(0, 3), ['getMe', 'deleteWebhook', 'getUpdates']);
  assert.deepEqual(api.of('deleteWebhook')[0]!.body, { drop_pending_updates: false });
  assert.deepEqual(api.of('getUpdates')[0]!.body, { offset: 0, timeout: 30, allowed_updates: ['message'] });
  await channel.stop();
});

test('maps text messages and advances the offset only after the sink resolves', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const api = fakeApi({}, [() => ok([textUpdate(7, 'hello')])]);
  const { channel } = setup(api);
  const got: InboundMessage[] = [];
  await channel.start(async (m) => {
    got.push(m);
    await gate;
  });
  await until(() => got.length === 1);
  await tick();
  assert.equal(api.of('getUpdates').length, 1, 'no further poll while the sink is pending');
  release();
  await until(() => api.of('getUpdates').length === 2);
  assert.equal(api.of('getUpdates')[1]!.body.offset, 8);
  assert.deepEqual(got[0], {
    channel: 'telegram',
    account: 'default',
    chatId: '42',
    externalId: '70',
    sender: { id: '42', displayName: 'Ada Lovelace' },
    text: 'hello',
    isPrivate: true,
    receivedAt: new Date(1_700_000_000_000).toISOString(),
  });
  await channel.stop();
});

test('group chats are not private and display name falls back to username', async () => {
  const api = fakeApi({}, [
    () => ok([textUpdate(1, 'hi', { from: { id: 5, username: 'grace' }, chat: { id: -100, type: 'supergroup' } })]),
  ]);
  const { channel } = setup(api);
  const got: InboundMessage[] = [];
  await channel.start(async (m) => void got.push(m));
  await until(() => got.length === 1);
  assert.equal(got[0]!.isPrivate, false);
  assert.equal(got[0]!.chatId, '-100');
  assert.deepEqual(got[0]!.sender, { id: '5', displayName: 'grace' });
  await channel.stop();
});

test('a failing sink stops the batch and the same update is redelivered', async () => {
  const api = fakeApi({}, [
    () => ok([textUpdate(1, 'one'), textUpdate(2, 'two')]),
    () => ok([textUpdate(1, 'one'), textUpdate(2, 'two')]),
  ]);
  const { channel, sleeps } = setup(api);
  const seen: string[] = [];
  let failed = false;
  await channel.start(async (m) => {
    if (m.text === 'one' && !failed) {
      failed = true;
      throw new Error('disk full');
    }
    seen.push(m.text);
  });
  await until(() => api.of('getUpdates').length === 3);
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(api.of('getUpdates')[1]!.body.offset, 0, 'not acked after failure');
  assert.equal(api.of('getUpdates')[2]!.body.offset, 3);
  assert.ok(sleeps.length >= 1);
  await channel.stop();
});

test('updates with nothing to read (service messages, a photo without a file id) are skipped but acknowledged', async () => {
  const photo = { update_id: 5, message: { message_id: 50, date: 1, photo: [{}], new_chat_title: 'x', from: { id: 1 }, chat: { id: 1, type: 'private' } } };
  const api = fakeApi({}, [() => ok([photo]), () => ok([photo, textUpdate(6, 'after')])]);
  const { channel } = setup(api);
  const got: string[] = [];
  await channel.start(async (m) => void got.push(m.text));
  await until(() => api.of('getUpdates').length === 3);
  assert.deepEqual(got, ['after']);
  assert.equal(api.of('getUpdates')[1]!.body.offset, 6);
  assert.equal(api.of('getUpdates')[2]!.body.offset, 7);
  await channel.stop();
});

test('409 conflict sets lastError, backs off and retries without crashing', async () => {
  const api = fakeApi({}, [() => fail(409, 'Conflict: terminated by other getUpdates request'), () => ok([textUpdate(3, 'back')])]);
  const { channel, sleeps } = setup(api);
  const got: string[] = [];
  await channel.start(async (m) => void got.push(m.text));
  await until(() => got.length === 1);
  assert.deepEqual(sleeps, [5000]);
  assert.equal(api.of('getUpdates').length >= 2, true);
  const h = channel.health();
  assert.equal(h.lastError, null, 'cleared by the next successful poll');
  await channel.stop();

  const api2 = fakeApi({}, [() => fail(409, 'Conflict')]);
  const second = setup(api2);
  await second.channel.start(async () => {});
  await until(() => second.channel.health().lastError !== null);
  assert.match(second.channel.health().lastError!, /409/);
  assert.equal(second.channel.health().ok, true, 'recent getMe success keeps it healthy');
  await second.channel.stop();
});

test('stop aborts a pending long poll promptly and is idempotent', async () => {
  const api = fakeApi();
  const { channel } = setup(api);
  await channel.start(async () => {});
  await until(() => api.of('getUpdates').length === 1);
  const started = Date.now();
  await Promise.all([channel.stop(), channel.stop()]);
  assert.ok(Date.now() - started < 50, 'stop should not wait for the poll timeout');
  await tick();
  assert.equal(api.of('getUpdates').length, 1, 'no polling after stop');
  await channel.stop();
});

test('health reports lastSuccessAt and is not ok before start', async () => {
  const api = fakeApi();
  const { channel } = setup(api);
  assert.deepEqual(channel.health(), { ok: false, lastSuccessAt: null, lastError: null });
  await channel.start(async () => {});
  const h = channel.health();
  assert.equal(h.ok, true);
  assert.ok(h.lastSuccessAt);
  await channel.stop();
});

test('send splits long text at paragraph boundaries within 4096 chars, replying on the first chunk only', async () => {
  let id = 100;
  const api = fakeApi({ sendMessage: () => ok({ message_id: ++id }) });
  const { channel } = setup(api);
  const para = 'a'.repeat(3000);
  const result = await channel.send({ deliveryId: 'd1', channel: 'telegram', account: 'default', chatId: '42', text: `${para}\n\n${para}`, replyToExternalId: '9' });
  assert.deepEqual(result, { status: 'sent', externalIds: ['101', '102'] });
  const sends = api.of('sendMessage');
  assert.equal(sends.length, 2);
  assert.equal(sends[0]!.body.text, para);
  assert.equal(sends[1]!.body.text, para);
  assert.deepEqual(sends[0]!.body.reply_parameters, { message_id: 9, allow_sending_without_reply: true });
  assert.equal(sends[1]!.body.reply_parameters, undefined);
  assert.equal(sends[0]!.body.parse_mode, 'HTML');
  assert.equal(sends[0]!.body.chat_id, '42');
});

test('send renders markdown as Telegram HTML with model text escaped', async () => {
  const api = fakeApi({ sendMessage: () => ok({ message_id: 1 }) });
  const { channel } = setup(api);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: '**Done**: wrote `a<b>.txt` & checked <script>.' });
  assert.equal(r.status, 'sent');
  const body = api.of('sendMessage')[0]!.body;
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.text, '<b>Done</b>: wrote <code>a&lt;b&gt;.txt</code> &amp; checked &lt;script&gt;.');
});

test('send falls back to plain text when Telegram cannot parse the entities', async () => {
  let n = 0;
  const api = fakeApi({ sendMessage: (body) => (++n === 1 && body.parse_mode ? fail(400, "Bad Request: can't parse entities: unexpected end tag") : ok({ message_id: 7 })) });
  const { channel } = setup(api);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'A **bold** [link](https://example.com)', replyToExternalId: '3' });
  assert.deepEqual(r, { status: 'sent', externalIds: ['7'] });
  const [first, second] = api.of('sendMessage');
  assert.equal(first!.body.parse_mode, 'HTML');
  assert.equal(second!.body.parse_mode, undefined);
  assert.equal(second!.body.text, 'A bold link (https://example.com)');
  assert.deepEqual(second!.body.reply_parameters, { message_id: 3, allow_sending_without_reply: true });
});

test('a 400 that is not a parse error is not retried as plain text', async () => {
  const api = fakeApi({ sendMessage: () => fail(400, 'Bad Request: chat not found') });
  const { channel } = setup(api);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'hi' });
  assert.equal(r.status, 'failed');
  assert.equal(api.of('sendMessage').length, 1);
});

test('send hard-splits text without natural boundaries', async () => {
  const api = fakeApi({ sendMessage: () => ok({ message_id: 1 }) });
  const { channel } = setup(api);
  const result = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'x'.repeat(9000) });
  assert.equal(result.status, 'sent');
  const lengths = api.of('sendMessage').map((c) => c.body.text.length);
  assert.deepEqual(lengths, [4096, 4096, 808]);
});

test('a rate limit on a later chunk is waited out without resending the earlier chunks', async () => {
  let n = 0;
  const api = fakeApi({ sendMessage: () => (++n === 2 ? fail(429, 'Too Many Requests: retry after 2', { retry_after: 2 }) : ok({ message_id: n })) });
  const { channel, sleeps } = setup(api);
  const para = 'a'.repeat(3000);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: `${para}\n\n${'b'.repeat(3000)}` });
  assert.deepEqual(r, { status: 'sent', externalIds: ['1', '3'] });
  assert.deepEqual(api.of('sendMessage').map((c) => c.body.text[0]), ['a', 'b', 'b']);
  assert.deepEqual(sleeps, [2000]);
});

test('send maps 429 with retry_after to a retryable failure', async () => {
  const api = fakeApi({ sendMessage: () => fail(429, 'Too Many Requests: retry after 7', { retry_after: 7 }) });
  const { channel } = setup(api);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'hi' });
  assert.equal(r.status, 'failed');
  assert.ok(r.status === 'failed' && r.retryable && r.retryAfterMs === 7000);
});

test('send maps 403 and 400 to non-retryable, 500/503 to retryable, and gateway errors to uncertain', async () => {
  const cases: Array<[number, boolean]> = [[403, false], [400, false], [500, true], [503, true]];
  for (const [status, retryable] of cases) {
    const api = fakeApi({ sendMessage: () => fail(status, 'Forbidden: bot was blocked by the user') });
    const { channel } = setup(api);
    const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'hi' });
    assert.ok(r.status === 'failed' && r.retryable === retryable, `status ${status}`);
  }
  for (const status of [502, 504]) {
    const { channel } = setup(fakeApi({ sendMessage: () => fail(status, 'Bad Gateway') }));
    const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'hi' });
    assert.equal(r.status, 'uncertain', `status ${status}`);
  }
});

test('ambiguous send errors are uncertain, pre-connect ones retryable; never throw or leak the token', async () => {
  const send = (error: Error) =>
    setup(fakeApi({ sendMessage: () => { throw error; } })).channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '1', text: 'hi' });
  // A timeout or reset may come after Telegram accepted the message: resending could duplicate it.
  const timeout = await send(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  assert.equal(timeout.status, 'uncertain');
  const reset = await send(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`, { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }));
  assert.ok(reset.status === 'uncertain' && !reset.error.includes(TOKEN));
  // DNS failure or a refused connection happens before anything is sent: safe to retry.
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
    const r = await send(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`, { cause: Object.assign(new Error(code), { code }) }));
    assert.ok(r.status === 'failed' && r.retryable, code);
    assert.ok(!r.error.includes(TOKEN));
  }
});

test('capabilities and typing', async () => {
  const api = fakeApi({ sendChatAction: () => fail(500, 'boom') });
  const { channel } = setup(api);
  assert.deepEqual(channel.capabilities, { maxMessageChars: 4096, dedupesSends: false, typingIndicator: true, maxUploadBytes: 50 * 1024 * 1024 });
  await channel.typing('42');
  assert.deepEqual(api.of('sendChatAction')[0]!.body, { chat_id: '42', action: 'typing' });
});

const base = { date: 1, from: { id: 7, first_name: 'Ada' }, chat: { id: 7, type: 'private' } };

test('a forwarded voice note and an audio file are not marked as live voice', async () => {
  const updates = [
    { update_id: 1, message: { ...base, message_id: 1, forward_origin: { type: 'user' }, voice: { file_id: 'v1', duration: 4 } } },
    { update_id: 2, message: { ...base, message_id: 2, audio: { file_id: 'a1', duration: 4, mime_type: 'audio/mpeg' } } },
  ];
  const { channel } = setup(fakeApi({}, [() => ok(updates)]));
  const got: InboundMessage[] = [];
  await channel.start(async (m) => void got.push(m));
  await until(() => got.length === 2, 'two messages');
  assert.equal(got[0]!.attachments![0]!.liveVoice, undefined);
  assert.equal(got[1]!.attachments![0]!.liveVoice, undefined);
  await channel.stop();
});

test('photos, voice notes, documents and captions arrive as attachments; stickers as unsupported', async () => {
  const updates = [
    { update_id: 1, message: { ...base, message_id: 1, caption: 'look', photo: [{ file_id: 'small', width: 90, height: 90, file_size: 1000 }, { file_id: 'big', width: 1280, height: 960, file_size: 90_000 }] } },
    { update_id: 2, message: { ...base, message_id: 2, voice: { file_id: 'v1', duration: 4, mime_type: 'audio/ogg', file_size: 9000 } } },
    { update_id: 3, message: { ...base, message_id: 3, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 50_000 } } },
    { update_id: 4, message: { ...base, message_id: 4, sticker: { file_id: 's1' } } },
  ];
  const api = fakeApi({}, [() => ok(updates)]);
  const { channel } = setup(api);
  const got: InboundMessage[] = [];
  await channel.start(async (m) => void got.push(m));
  await until(() => got.length === 4, 'four messages');
  assert.equal(got[0]!.text, 'look');
  assert.deepEqual(got[0]!.attachments, [{ kind: 'image', ref: 'big', name: 'photo.jpg', mimeType: 'image/jpeg', size: 90_000 }]);
  assert.equal(got[1]!.text, '');
  assert.deepEqual(got[1]!.attachments, [{ kind: 'audio', ref: 'v1', name: 'voice.ogg', mimeType: 'audio/ogg', size: 9000, durationSec: 4, liveVoice: true }]);
  assert.deepEqual(got[2]!.attachments, [{ kind: 'document', ref: 'd1', name: 'report.pdf', mimeType: 'application/pdf', size: 50_000 }]);
  assert.equal(got[3]!.unsupported, 'sticker');
  assert.equal(got[3]!.attachments, undefined);
  await channel.stop();
});

test('fetchAttachment resolves the file with getFile, downloads it, enforces limits and never leaks the token', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const urls: string[] = [];
  const api = fakeApi({
    getFile: (body) => (body.file_id === 'huge' ? ok({ file_id: 'huge', file_size: 30_000_000 }) : ok({ file_id: body.file_id, file_size: 4, file_path: 'voice/file_9.oga' })),
    'file_9.oga': () => new Response(bytes, { status: 200 }),
  });
  const wrapped = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    return api.fetch(url as string, init);
  }) as typeof fetch;
  const channel = new TelegramChannel({ token: TOKEN, fetch: wrapped, sleep: async () => {} });
  const got = await channel.fetchAttachment('v1', { maxBytes: 1000, signal: new AbortController().signal });
  assert.deepEqual(got.data, bytes);
  assert.equal(urls.at(-1), `https://api.telegram.org/file/bot${TOKEN}/voice/file_9.oga`);
  await assert.rejects(channel.fetchAttachment('v1', { maxBytes: 2, signal: new AbortController().signal }), /too large/);
  await assert.rejects(channel.fetchAttachment('huge', { maxBytes: 50_000_000, signal: new AbortController().signal }), /too large \(28\.6 MB; the limit is 20\.0 MB\)/);
  const failing = new TelegramChannel({ token: TOKEN, fetch: (async () => { throw new Error(`connect failed for /bot${TOKEN}/getFile`); }) as typeof fetch });
  await assert.rejects(failing.fetchAttachment('x', { maxBytes: 10, signal: new AbortController().signal }), (e: Error) => !e.message.includes(TOKEN) && /<token>/.test(e.message));
});

test('send with files: photos via sendPhoto (multipart) with the text as caption, voice via sendVoice, long text after', async () => {
  const dir = tempDir();
  const png = join(dir, 'chart.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const ogg = join(dir, 'v.ogg');
  writeFileSync(ogg, Buffer.from('OggS'));
  const api = fakeApi({ sendPhoto: () => ok({ message_id: 10 }), sendVoice: () => ok({ message_id: 11 }), sendMessage: () => ok({ message_id: 12 }) });
  const { channel } = setup(api);
  const result = await channel.send({
    deliveryId: 'd1', channel: 'telegram', account: 'default', chatId: '7', text: 'Here you go', replyToExternalId: '3',
    attachments: [
      { path: png, name: 'chart.png', mimeType: 'image/png', kind: 'image', size: 4 },
      { path: ogg, name: 'v.ogg', mimeType: 'audio/ogg', kind: 'audio', size: 4 },
    ],
  });
  assert.deepEqual(result, { status: 'sent', externalIds: ['10', '11'] });
  const photo = api.of('sendPhoto')[0]!.body as FormData;
  assert.equal(photo.get('chat_id'), '7');
  assert.equal((photo.get('photo') as File).name, 'chart.png');
  assert.equal((photo.get('photo') as File).size, 4);
  assert.equal(photo.get('caption'), null, 'the caption rides on the last file');
  assert.deepEqual(JSON.parse(String(photo.get('reply_parameters'))), { message_id: 3, allow_sending_without_reply: true });
  const voice = api.of('sendVoice')[0]!.body as FormData;
  assert.equal(voice.get('caption'), 'Here you go');
  assert.equal(voice.get('parse_mode'), 'HTML', 'captions use the same markdown to HTML conversion as messages');
  assert.equal(voice.get('reply_parameters'), null, 'only the first message replies');

  const long = await channel.send({ deliveryId: 'd2', channel: 'telegram', account: 'default', chatId: '7', text: 'x'.repeat(1500), attachments: [{ path: png, name: 'doc.bin', mimeType: 'application/octet-stream', kind: 'file', size: 4 }] });
  assert.equal(long.status, 'sent');
  assert.equal(api.of('sendDocument').length, 1, 'other files go as documents');
  assert.equal(api.of('sendMessage').at(-1)!.body.text.length, 1500, 'text too long for a caption follows as a message');
});

test('a caption Telegram cannot parse as HTML is resent as plain text', async () => {
  const dir = tempDir();
  const png = join(dir, 'c.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let calls = 0;
  const api = fakeApi({
    sendPhoto: (body: FormData) => (++calls === 1 && body.get('parse_mode') === 'HTML' ? fail(400, "Bad Request: can't parse entities: unsupported start tag") : ok({ message_id: 20 })),
  });
  const { channel } = setup(api);
  const r = await channel.send({ deliveryId: 'd', channel: 'telegram', account: 'default', chatId: '7', text: '**Chart** for `Q3`', attachments: [{ path: png, name: 'c.png', mimeType: 'image/png', kind: 'image', size: 4 }] });
  assert.deepEqual(r, { status: 'sent', externalIds: ['20'] });
  const [html, plain] = api.of('sendPhoto').map((c) => c.body as FormData);
  assert.equal(html!.get('caption'), '<b>Chart</b> for <code>Q3</code>');
  assert.equal(plain!.get('parse_mode'), null);
  assert.equal(plain!.get('caption'), 'Chart for Q3');
});
