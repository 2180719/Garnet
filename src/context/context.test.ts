import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent, SessionEventPayload } from '../contracts/index.ts';
import { messagesFromEvents, systemPrompt } from './index.ts';

const ev = (seq: number, p: SessionEventPayload): SessionEvent => ({ ...p, sessionId: 's', seq, at: '' });
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null };

test('an interrupted tool call still gets a result, and follow-up text merges into one user turn', () => {
  const msgs = messagesFromEvents([
    ev(1, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, source: 't' }),
    ev(2, { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'x', input: {} }] }, stopReason: 'tool_use', usage, model: 'm' }),
    ev(3, { type: 'tool_started', call: { type: 'tool_call', id: 'c1', name: 'x', input: {} }, operationId: 'o' }),
    ev(4, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'again' }] }, source: 't' }),
  ]);
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  const last = msgs[2]!.content;
  assert.equal(last[0]?.type, 'tool_result');
  assert.ok(last[0]?.type === 'tool_result' && last[0].isError && /interrupted/.test(last[0].content));
  assert.equal(last[1]?.type, 'text');
});

test('the system prompt is deterministic', () => {
  const a = systemPrompt({ workspace: '/w' });
  assert.equal(a, systemPrompt({ workspace: '/w' }));
  assert.match(systemPrompt({ workspace: '/w', persona: 'Be terse.' }), /Be terse\./);
});

test('bound blocks are dropped only from turns that precede a checkpoint', () => {
  const thinking = (id: string) => ({ type: 'provider' as const, provider: 'anthropic', data: { id }, bound: true });
  const user = (seq: number, text: string) => ev(seq, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text }] }, source: 't' });
  const msgs = messagesFromEvents([
    user(1, 'old'),
    ev(2, { type: 'assistant_message', message: { role: 'assistant', content: [thinking('folded'), { type: 'text', text: 'a' }] }, stopReason: 'end_turn', usage, model: 'm' }),
    user(3, 'kept'),
    ev(4, { type: 'assistant_message', message: { role: 'assistant', content: [thinking('retained'), { type: 'text', text: 'b' }] }, stopReason: 'end_turn', usage, model: 'm' }),
    ev(5, { type: 'checkpoint', summary: 'S', throughSeq: 2, usage }),
    user(6, 'new'),
    ev(7, { type: 'assistant_message', message: { role: 'assistant', content: [thinking('after'), { type: 'tool_call', id: 'c1', name: 'x', input: {} }] }, stopReason: 'tool_use', usage, model: 'm' }),
    ev(8, { type: 'tool_finished', callId: 'c1', operationId: 'o', result: { status: 'ok', content: 'r', truncated: false, durationMs: 0 } }),
    ev(9, { type: 'assistant_message', message: { role: 'assistant', content: [thinking('after2'), { type: 'text', text: 'done' }] }, stopReason: 'end_turn', usage, model: 'm' }),
  ]);
  const provider = msgs.flatMap((m) => m.content).filter((b) => b.type === 'provider').map((b) => (b.data as { id: string }).id);
  assert.deepEqual(provider, ['after', 'after2'], 'retained pre-checkpoint turns lose bound blocks; later turns keep them');
  assert.ok(!JSON.stringify(msgs).includes('"old"'), 'folded turns are summarized');
});
