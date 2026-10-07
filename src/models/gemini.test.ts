import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, ModelEvent } from '../contracts/index.ts';
import { GEMINI_BASE_URL, GEMINI_MODELS, GeminiModel, geminiModelInfo } from './index.ts';

const chunk = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: object, finish: string | null = null) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function sse(pieces: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

type Seen = { url: string; headers: Record<string, string>; body: any };

function gemini(respond: () => Response, seen: Seen[] = [], extra: object = {}) {
  return new GeminiModel({
    apiKey: 'AIza-test-key',
    model: 'gemini-2.5-flash',
    fetch: (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return respond();
    }) as typeof fetch,
    ...extra,
  });
}

const user = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

async function collect(m: GeminiModel, messages: ChatMessage[] = [user('hi')], tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []) {
  const out: ModelEvent[] = [];
  for await (const e of m.stream({ system: 'sys', messages, tools, maxOutputTokens: 500 })) out.push(e);
  return out;
}

test('preset: gemini id, endpoint, bearer key, max_tokens, media on, window from the table', async () => {
  const seen: Seen[] = [];
  const m = gemini(() => sse([delta({ content: 'Hi' }, 'stop'), chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }), 'data: [DONE]\n\n']), seen);
  assert.equal(m.id, 'gemini:gemini-2.5-flash');
  assert.equal(m.capabilities.contextWindow, 1_048_576);
  assert.equal(m.capabilities.media?.images, true);
  assert.equal(m.capabilities.media?.pdf, true);
  const events = await collect(m);
  assert.equal(seen[0]!.url, `${GEMINI_BASE_URL}chat/completions`);
  assert.equal(seen[0]!.headers.Authorization, 'Bearer AIza-test-key');
  assert.equal(seen[0]!.body.max_tokens, 500);
  assert.equal('max_completion_tokens' in seen[0]!.body, false);
  assert.equal(seen[0]!.body.model, 'gemini-2.5-flash');
  const done = events.at(-1) as Extract<ModelEvent, { type: 'done' }>;
  assert.equal(done.type, 'done');
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 2);
  assert.deepEqual(done.message.content, [{ type: 'text', text: 'Hi' }]);
});

test('streams a tool call sent whole in one chunk, and maps the stop reason', async () => {
  const body = delta({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }) + delta({}, 'tool_calls') + 'data: [DONE]\n\n';
  const events = await collect(gemini(() => sse([body])), [user('list')], [{ name: 'list_files', description: 'd', inputSchema: { type: 'object' } }]);
  const call = events.find((e) => e.type === 'tool_call') as Extract<ModelEvent, { type: 'tool_call' }>;
  assert.deepEqual([call.call.name, call.call.input], ['list_files', { path: '.' }]);
  const done = events.at(-1) as Extract<ModelEvent, { type: 'done' }>;
  assert.equal(done.stopReason, 'tool_use');
});

test('attachments go as image_url parts; another provider\'s blocks are dropped when history is replayed', async () => {
  const seen: Seen[] = [];
  const m = gemini(() => sse([delta({ content: 'ok' }, 'stop'), 'data: [DONE]\n\n']), seen);
  const img = { id: 'med_1', kind: 'image' as const, mimeType: 'image/png', size: 3, name: 'p.png' };
  const history: ChatMessage[] = [
    user('earlier'),
    {
      role: 'assistant',
      content: [
        { type: 'provider', provider: 'anthropic', data: { type: 'thinking', thinking: 'secret', signature: 'sig' }, bound: true },
        { type: 'text', text: 'Earlier answer from Claude.' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'attachment', attachment: img, data: 'iVBO' }] },
  ];
  await collect(m, history);
  const sent = seen[0]!.body.messages;
  assert.equal(JSON.stringify(sent).includes('secret'), false, 'the thinking block of another provider is not sent');
  assert.deepEqual(sent[2], { role: 'assistant', content: 'Earlier answer from Claude.' });
  assert.deepEqual(sent[3].content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBO' } }]);
});

test('the model table lists explicit ids with windows and media; overrides and unknown ids work', () => {
  assert.ok(GEMINI_MODELS.length >= 4);
  for (const g of GEMINI_MODELS) {
    assert.match(g.id, /^gemini-/);
    assert.ok(g.contextWindow >= 1_000_000 && g.vision && g.pdf, g.id);
    assert.ok(!/latest/.test(g.id), 'explicit ids only');
  }
  assert.equal(geminiModelInfo('models/gemini-2.5-pro')?.maxOutputTokens, 65_536);
  const unknown = gemini(() => sse([]), [], { model: 'gemini-9-future' });
  assert.equal(unknown.capabilities.contextWindow, 1_048_576);
  const custom = gemini(() => sse([]), [], { contextWindow: 200_000, vision: false });
  assert.equal(custom.capabilities.contextWindow, 200_000);
  assert.equal(custom.capabilities.media?.images, false);
});

test('an HTTP error becomes an error event that never contains the key', async () => {
  const m = gemini(() => new Response('{"error":{"message":"API key not valid: AIza-test-key"}}', { status: 400 }));
  const events = await collect(m);
  const err = events.at(-1) as Extract<ModelEvent, { type: 'error' }>;
  assert.equal(err.type, 'error');
  assert.equal(err.category, 'provider_fatal');
  assert.ok(!err.message.includes('AIza-test-key'));
});
