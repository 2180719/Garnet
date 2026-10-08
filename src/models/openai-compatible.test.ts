import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ModelEvent } from '../contracts/index.ts';
import { OpenAICompatibleModel } from './index.ts';
import { clampOutputTokens } from './openai-compatible.ts';

const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object, finish: string | null = null) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** A response whose body is delivered in the given pieces (so tests control chunk boundaries). */
function sseResponse(pieces: string[], status = 200, headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

/** Splits text into pieces of n characters, cutting lines and JSON mid-way. */
const slice = (s: string, n: number) => s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];

type Seen = { url: string; headers: Record<string, string>; body: any };

function model(respond: () => Response | Promise<Response>, seen: Seen[] = [], extra: object = {}) {
  return new OpenAICompatibleModel({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3',
    fetch: (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return respond();
    }) as typeof fetch,
    ...extra,
  });
}

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const tools = [{ name: 'list_files', description: 'd', inputSchema: { type: 'object' } }];

async function collect(m: OpenAICompatibleModel, messages: ChatMessage[] = [user('hi')], opts: { tools?: typeof tools; signal?: AbortSignal } = {}) {
  const out: ModelEvent[] = [];
  for await (const e of m.stream({ system: 'sys', messages, tools: opts.tools ?? [], maxOutputTokens: 100, ...(opts.signal ? { signal: opts.signal } : {}) })) out.push(e);
  return out;
}

test('id and capabilities', () => {
  const m = new OpenAICompatibleModel({ baseUrl: 'http://x/v1', model: 'm' });
  assert.equal(m.id, 'openai-compatible:m');
  assert.deepEqual(m.capabilities, {
    streaming: true,
    promptCaching: false,
    contextWindow: 128_000,
    media: { images: false, pdf: false, maxImageBytes: 20 * 1024 * 1024, maxPdfBytes: 20 * 1024 * 1024 },
  });
});

test('streams text with usage, subtracting cached tokens, across mid-line chunk splits', async () => {
  const full =
    ': keepalive\n\n' +
    delta({ role: 'assistant', content: '' }) +
    delta({ content: 'Hel' }) +
    delta({ content: 'lo' }) +
    delta({}, 'stop') +
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } } }) +
    'data: [DONE]\n\n';
  const events = await collect(model(() => sseResponse(slice(full, 7))));
  assert.deepEqual(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text), ['Hel', 'lo']);
  const done = events.at(-1);
  assert.ok(done?.type === 'done');
  assert.equal(done.stopReason, 'end_turn');
  assert.deepEqual(done.message.content, [{ type: 'text', text: 'Hello' }]);
  assert.deepEqual(done.usage, { inputTokens: 60, outputTokens: 7, cacheReadTokens: 40, cacheWriteTokens: 0 });
  // Absent cache details with a known prompt count mean nothing cached, so a price with cache rates still gives a cost.
  assert.equal(events.filter((e) => e.type === 'done' || e.type === 'error').length, 1);
});

test('missing usage yields nulls, not zeros', async () => {
  const full = delta({ content: 'x' }) + delta({}, 'stop') + 'data: [DONE]\n\n';
  const done = (await collect(model(() => sseResponse([full])))).at(-1);
  assert.ok(done?.type === 'done');
  assert.deepEqual(done.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
});

test('assembles parallel tool calls from fragments', async () => {
  const full =
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_files', arguments: '' } }] }) +
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_files', arguments: '{"pa' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }) +
    delta({ tool_calls: [{ index: 0, function: { arguments: '"."}' } }] }) +
    delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"src"}' } }] }) +
    delta({}, 'tool_calls') +
    'data: [DONE]\n\n';
  const events = await collect(model(() => sseResponse(slice(full, 11))), undefined, { tools });
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call);
  assert.deepEqual(calls, [
    { type: 'tool_call', id: 'call_a', name: 'list_files', input: { path: '.' } },
    { type: 'tool_call', id: 'call_b', name: 'list_files', input: { path: 'src' } },
  ]);
  const done = events.at(-1);
  assert.ok(done?.type === 'done');
  assert.equal(done.stopReason, 'tool_use');
  assert.equal(done.message.content.length, 2);
  // tool_call events come before done
  assert.ok(events.findIndex((e) => e.type === 'tool_call') < events.findIndex((e) => e.type === 'done'));
});

test('invalid tool-argument JSON is passed through as the raw string', async () => {
  const full =
    delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'list_files', arguments: '{"path": ' } }] }) +
    delta({}, 'tool_calls') + 'data: [DONE]\n\n';
  const events = await collect(model(() => sseResponse([full])));
  const call = events.find((e) => e.type === 'tool_call');
  assert.ok(call?.type === 'tool_call');
  assert.equal(call.call.input, '{"path": ');
});

test('maps finish reasons', async () => {
  for (const [reason, expected] of [['length', 'max_tokens'], ['content_filter', 'refusal'], ['weird', 'other']] as const) {
    const done = (await collect(model(() => sseResponse([delta({ content: 'a' }, reason), 'data: [DONE]\n\n'])))).at(-1);
    assert.ok(done?.type === 'done');
    assert.equal(done.stopReason, expected);
  }
});

test('translates messages: system first, tool messages before user text, error prefix, foreign blocks dropped', async () => {
  const seen: Seen[] = [];
  const messages: ChatMessage[] = [
    user('start'),
    {
      role: 'assistant',
      content: [
        { type: 'provider', provider: 'anthropic', data: { type: 'thinking' }, bound: true },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_call', id: 'c1', name: 'list_files', input: { path: '.' } },
        { type: 'tool_call', id: 'c2', name: 'list_files', input: { path: 'src' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool_result', callId: 'c1', content: 'a.ts', isError: false },
        { type: 'tool_result', callId: 'c2', content: 'no such dir', isError: true },
        { type: 'text', text: 'second' },
      ],
    },
  ];
  await collect(model(() => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']), seen), messages);
  assert.deepEqual(seen[0]?.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'start' },
    {
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
        { id: 'c2', type: 'function', function: { name: 'list_files', arguments: '{"path":"src"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'a.ts' },
    { role: 'tool', tool_call_id: 'c2', content: 'Error: no such dir' },
    { role: 'user', content: 'first\n\nsecond' },
  ]);
});

test('request shape: stream options, tools only when present, no Authorization without key', async () => {
  const seen: Seen[] = [];
  const ok = () => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']);
  await collect(model(ok, seen));
  const first = seen[0]!;
  assert.equal(first.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(first.body.stream, true);
  assert.deepEqual(first.body.stream_options, { include_usage: true });
  assert.equal(first.body.max_tokens, 100);
  assert.equal(first.body.model, 'llama3');
  assert.equal('tools' in first.body, false);
  assert.equal('Authorization' in first.headers, false);
  assert.equal('X-Title' in first.headers, false);
  assert.equal(first.headers['Content-Type'], 'application/json');

  await collect(model(ok, seen), undefined, { tools });
  assert.deepEqual(seen[1]!.body.tools, [{ type: 'function', function: { name: 'list_files', description: 'd', parameters: { type: 'object' } } }]);
});

test('sends Authorization with a key, X-Title only for openrouter, and extra headers', async () => {
  const seen: Seen[] = [];
  const ok = () => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']);
  await collect(model(ok, seen, { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: 'sk-secret', extraHeaders: { 'HTTP-Referer': 'r' } }));
  assert.equal(seen[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0]!.headers.Authorization, 'Bearer sk-secret');
  assert.equal(seen[0]!.headers['X-Title'], 'Garnet');
  assert.equal(seen[0]!.headers['HTTP-Referer'], 'r');
});

const last = (events: ModelEvent[]) => {
  const e = events.at(-1);
  assert.ok(e?.type === 'error', `expected error, got ${JSON.stringify(e)}`);
  return e;
};

test('maps HTTP errors to categories', async () => {
  const json = (status: number, message: string, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

  const auth = last(await collect(model(json(401, 'bad key sk-secret'), [], { apiKey: 'sk-secret' })));
  assert.equal(auth.category, 'provider_fatal');
  assert.ok(/credentials|API key/i.test(auth.message));
  assert.ok(!auth.message.includes('sk-secret'));

  const rate = last(await collect(model(json(429, 'slow down', { 'retry-after': '7' }))));
  assert.equal(rate.category, 'provider_transient');
  assert.equal(rate.retryAfterMs, 7000);

  const date = new Date(Date.now() + 30_000).toUTCString();
  const dated = last(await collect(model(json(503, 'busy', { 'retry-after': date }))));
  assert.ok(dated.retryAfterMs !== undefined && dated.retryAfterMs > 20_000 && dated.retryAfterMs <= 30_000);

  const server = last(await collect(model(json(500, 'boom'))));
  assert.equal(server.category, 'provider_transient');
  assert.equal(server.retryAfterMs, undefined);

  const bad = last(await collect(model(json(404, 'model "llama9" not found'))));
  assert.equal(bad.category, 'provider_fatal');
  assert.ok(bad.message.includes('llama9'));
});

test('mid-stream error lines map to fatal or transient', async () => {
  const fatal = last(await collect(model(() => sseResponse([delta({ content: 'a' }), chunk({ error: { message: 'context length exceeded', code: 400 } })]))));
  assert.equal(fatal.category, 'provider_fatal');
  assert.ok(fatal.message.includes('context length'));
  const transient = last(await collect(model(() => sseResponse([chunk({ error: { message: 'Provider overloaded' } })]))));
  assert.equal(transient.category, 'provider_transient');
});

test('the response body is released when the stream stops early', async () => {
  // A body that never closes on its own, like a server still holding the connection.
  const openBody = (first: string, onCancel: () => void) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
        },
        cancel: onCancel,
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  let cancelled = 0;
  const errored = last(await collect(model(() => openBody(chunk({ error: { message: 'boom' } }), () => void cancelled++))));
  assert.equal(errored.category, 'provider_fatal');
  assert.equal(cancelled, 1, 'a mid-stream error cancels the body');

  for await (const e of model(() => openBody(delta({ content: 'hi' }), () => void cancelled++)).stream({ system: 's', messages: [user('x')], tools: [], maxOutputTokens: 10 })) {
    if (e.type === 'text_delta') break; // the consumer stops listening
  }
  assert.equal(cancelled, 2, 'a consumer that stops early cancels the body');
});

test('cache writes reported by the provider are split out of input tokens', async () => {
  const full = delta({ content: 'x' }, 'stop') + chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 50 } } }) + 'data: [DONE]\n\n';
  const done = (await collect(model(() => sseResponse([full])))).at(-1);
  assert.ok(done?.type === 'done');
  assert.deepEqual(done.usage, { inputTokens: 40, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 50 });
});

test('network failure is transient; truncated stream is transient', async () => {
  const net = new OpenAICompatibleModel({ baseUrl: 'http://x/v1', model: 'm', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.equal(last(await collect(net)).category, 'provider_transient');
  const cut = last(await collect(model(() => sseResponse([delta({ content: 'partial' })]))));
  assert.equal(cut.category, 'provider_transient');
});

test('abort maps to cancelled', async () => {
  const ac = new AbortController();
  const m = new OpenAICompatibleModel({
    baseUrl: 'http://x/v1', model: 'm',
    fetch: (async (_u: unknown, init?: RequestInit) => {
      ac.abort();
      init?.signal?.throwIfAborted();
      return sseResponse([]);
    }) as typeof fetch,
  });
  assert.equal(last(await collect(m, undefined, { signal: ac.signal })).category, 'cancelled');

  const ac2 = new AbortController();
  const slow = model(() => new Response(new ReadableStream({ pull() { ac2.abort(); throw new DOMException('aborted', 'AbortError'); } })));
  assert.equal(last(await collect(slow, undefined, { signal: ac2.signal })).category, 'cancelled');
});

test('output cap field: max_completion_tokens for OpenAI and Azure OpenAI, max_tokens elsewhere, overridable', async () => {
  const ok = () => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']);
  const field = async (extra: object) => {
    const seen: Seen[] = [];
    await collect(model(ok, seen, extra));
    const b = seen[0]!.body;
    return { completion: b.max_completion_tokens, tokens: b.max_tokens };
  };
  assert.deepEqual(await field({ baseUrl: 'https://api.openai.com/v1' }), { completion: 100, tokens: undefined });
  assert.deepEqual(await field({ baseUrl: 'https://myres.openai.azure.com/openai/v1' }), { completion: 100, tokens: undefined });
  assert.deepEqual(await field({ baseUrl: 'https://openrouter.ai/api/v1' }), { completion: undefined, tokens: 100 });
  assert.deepEqual(await field({ baseUrl: 'http://127.0.0.1:8000/v1', tokenParam: 'max_completion_tokens' }), { completion: 100, tokens: undefined });
  assert.deepEqual(await field({ baseUrl: 'https://api.openai.com/v1', tokenParam: 'max_tokens' }), { completion: undefined, tokens: 100 });
});

test('output cap is clamped so prompt + output fits the context window', async () => {
  const seen: Seen[] = [];
  const ok = () => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']);
  const m = model(ok, seen, { baseUrl: 'http://127.0.0.1:8000/v1', contextWindow: 8192 });
  const big = { system: 's', messages: [user('x'.repeat(9000))], tools: [], maxOutputTokens: 32_000 };
  for await (const e of m.stream(big)) void e;
  const cap = seen[0]!.body.max_tokens as number;
  // ~9000 chars of prompt is at most ~3000 tokens; the rest of the 8192 window is left for output.
  assert.ok(cap < 8192 - 3000 && cap > 4000, `cap ${cap}`);
  // A cap that already fits is left alone.
  for await (const e of m.stream({ ...big, messages: [user('hi')], maxOutputTokens: 2000 })) void e;
  assert.equal(seen[1]!.body.max_tokens, 2000);
});

test('clampOutputTokens keeps a usable minimum and never exceeds the request', () => {
  assert.equal(clampOutputTokens(32_000, 128_000, 30_000), 32_000);
  assert.equal(clampOutputTokens(32_000, 8192, 3000), 7192);
  assert.equal(clampOutputTokens(32_000, 8192, 30_000), 1024); // nearly full: still ask for something
  assert.equal(clampOutputTokens(500, 8192, 30_000), 500);
});

test('attachments: image_url and file parts with data URLs, in order; text-only turns stay plain strings', async () => {
  const seen: Seen[] = [];
  const ok = () => sseResponse([delta({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']);
  const m = model(ok, seen, { vision: true, pdf: true });
  assert.equal(m.capabilities.media.images, true);
  const img = { id: 'med_1', kind: 'image' as const, mimeType: 'image/jpeg', size: 3, name: 'p.jpg' };
  const pdf = { id: 'med_2', kind: 'document' as const, mimeType: 'application/pdf', size: 3, name: 'r.pdf' };
  await collect(m, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'compare' },
        { type: 'attachment', attachment: img, data: '/9j/' },
        { type: 'attachment', attachment: pdf, data: 'JVBE' },
        { type: 'attachment', attachment: { ...img, id: 'med_9' } },
      ],
    },
  ]);
  assert.deepEqual(seen[0]!.body.messages[1].content, [
    { type: 'text', text: 'compare' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } },
    { type: 'file', file: { filename: 'r.pdf', file_data: 'data:application/pdf;base64,JVBE' } },
    { type: 'text', text: '[Image attached: "p.jpg", image/jpeg, 3 B; id med_9]' },
  ]);
  await collect(model(ok, seen), [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'attachment', attachment: { id: 'med_3', kind: 'audio', mimeType: 'audio/ogg', size: 3 }, text: 'Transcript:\nb' }] }]);
  assert.equal(seen[1]!.body.messages[1].content, 'a\n\n[Audio attached: audio/ogg, 3 B; id med_3]\nTranscript:\nb');
});

test('inline files count as a flat estimate, not their base64 length, when clamping output', async () => {
  const seen: Seen[] = [];
  const ok = () => sseResponse([delta({}, 'stop'), 'data: [DONE]\n\n']);
  const m = model(ok, seen, { baseUrl: 'http://127.0.0.1:8000/v1', contextWindow: 32_000, vision: true });
  const img = { id: 'med_1', kind: 'image' as const, mimeType: 'image/jpeg', size: 3_000_000, name: 'p.jpg' };
  const request = { system: 's', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'look' }, { type: 'attachment' as const, attachment: img, data: 'A'.repeat(4_000_000) }] }], tools: [], maxOutputTokens: 8000 };
  for await (const e of m.stream(request)) void e;
  assert.equal(seen[0]!.body.max_tokens, 8000);
});

test('a tool call\'s extra_content (Gemini thought_signature) is kept and echoed back on the next request', async () => {
  const extra = { google: { thought_signature: 'sig-abc' } };
  const first = await collect(
    model(() =>
      sseResponse([
        delta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: extra }] }),
        delta({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    ),
    [user('go')],
    { tools },
  );
  const done = first.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  const content = done.message.content;
  assert.deepEqual(content[0], { type: 'tool_call', id: 'c1', name: 'list_files', input: {} });
  assert.deepEqual(content[1], { type: 'provider', provider: 'openai-compatible', data: { callId: 'c1', extra } });

  const seen: Seen[] = [];
  const history: ChatMessage[] = [
    user('go'),
    done.message,
    { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'ok', isError: false }] },
  ];
  await collect(model(() => sseResponse([delta({ content: 'x' }, 'stop'), 'data: [DONE]\n\n']), seen), history, { tools });
  const assistant = seen[0]!.body.messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual(assistant.tool_calls[0].extra_content, extra);
  // A call without extra_content gets no such field.
  const plain = await collect(model(() => sseResponse([delta({ tool_calls: [{ index: 0, id: 'p', function: { name: 'list_files', arguments: '{}' } }] }, 'tool_calls'), 'data: [DONE]\n\n'])), [user('go')], { tools });
  const pd = plain.find((e) => e.type === 'done');
  assert.ok(pd && pd.type === 'done');
  assert.equal(pd.message.content.length, 1);
});
