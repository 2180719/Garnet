import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelEvent } from '../contracts/index.ts';
import { AnthropicModel } from './index.ts';

const sse = (events: object[]) =>
  events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const stream = sse([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"."}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
]);

function model(response: () => Response, seen: unknown[] = []) {
  return new AnthropicModel({
    apiKey: 'test', model: 'claude-opus-5-5', effort: 'high',
    fetch: (async (_url: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return response();
    }) as typeof fetch,
  });
}

async function collect(m: AnthropicModel, messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }]) {
  const out: ModelEvent[] = [];
  for await (const e of m.stream({ system: 'sys', messages, tools: [{ name: 'list_files', description: 'd', inputSchema: { type: 'object' } }], maxOutputTokens: 100 })) out.push(e);
  return out;
}

test('streams text, tool calls, usage and preserves thinking blocks in order', async () => {
  const seen: any[] = [];
  const events = await collect(model(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), seen), undefined);
  const done = events.at(-1);
  assert.ok(done?.type === 'done');
  assert.equal(done.stopReason, 'tool_use');
  assert.deepEqual(done.message.content.map((b) => b.type), ['provider', 'text', 'tool_call']);
  const call = done.message.content[2];
  assert.ok(call?.type === 'tool_call');
  assert.deepEqual(call.input, { path: '.' });
  assert.equal(done.usage.cacheReadTokens, 5);
  assert.equal(done.usage.outputTokens, 30);
  assert.ok(events.some((e) => e.type === 'text_delta' && e.text === 'Checking.'));

  const body = seen[0];
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.equal(body.tools[0].eager_input_streaming, true);
});

test('replays provider blocks unchanged', async () => {
  const seen: any[] = [];
  const thinking = { type: 'thinking', thinking: '', signature: 'sig123' };
  await collect(model(() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), seen), [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'provider', provider: 'anthropic', data: thinking } as never, { type: 'tool_call', id: 't', name: 'list_files', input: {} } as never] },
    { role: 'user', content: [{ type: 'tool_result', callId: 't', content: 'ok', isError: false } as never] },
  ] as never);
  assert.deepEqual(seen[0].messages[1].content[0], thinking);
  assert.equal(seen[0].messages[2].content[0].tool_use_id, 't');
});

test('maps HTTP errors to categories with retry-after', async () => {
  const err = (status: number, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'nope' } }), { status, headers: { 'content-type': 'application/json', ...headers } });
  const rate = (await collect(model(err(429, { 'retry-after': '7' })))).at(-1);
  assert.ok(rate?.type === 'error' && rate.category === 'provider_transient' && rate.retryAfterMs === 7000);
  const auth = (await collect(model(err(401)))).at(-1);
  assert.ok(auth?.type === 'error' && auth.category === 'provider_fatal');
  const overloaded = (await collect(model(err(529)))).at(-1);
  assert.ok(overloaded?.type === 'error' && overloaded.category === 'provider_transient');
});
