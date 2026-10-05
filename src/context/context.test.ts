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
  const a = systemPrompt({ workspace: '/w', toolNames: ['a'] });
  assert.equal(a, systemPrompt({ workspace: '/w', toolNames: ['a'] }));
  assert.match(systemPrompt({ workspace: '/w', toolNames: [], persona: 'Be terse.' }), /Be terse\./);
});
