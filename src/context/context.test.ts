import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent, SessionEventPayload } from '../contracts/index.ts';
import { assistantName, extractSummary, messagesFromEvents, planCompaction, systemPrompt, turnTime } from './index.ts';

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

test('the system prompt uses the configured assistant name, defaulting to Ruby', () => {
  assert.match(systemPrompt({ workspace: '/w' }), /^You are Ruby, /);
  const persona = '<!-- ruby setup -->\nYour name is Molty.\n<!-- /ruby setup -->\n\nBe terse.';
  assert.match(systemPrompt({ workspace: '/w', persona }), /^You are Molty, /);
  assert.match(systemPrompt({ workspace: '/w', persona, name: 'Nova' }), /^You are Nova, /);
  assert.equal(assistantName('Your name is  .'), 'Ruby');
  assert.equal(assistantName('Your name is Juniper.\nYour name is Other.'), 'Juniper');
  assert.equal(assistantName('My friend said your name is Bob.'), 'Ruby');
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

test('a second compaction starts from the previous summary, not the full history', () => {
  const user = (seq: number, text: string) => ev(seq, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text }] }, source: 't' });
  const reply = (seq: number, text: string) =>
    ev(seq, { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text }] }, stopReason: 'end_turn', usage, model: 'm' });
  // The first compaction ran during the task for u3 (keepTurns 2): it folded u1 and kept u2 and u3.
  const events = [
    user(1, 'u1'), reply(2, 'a1'),
    user(3, 'u2'), reply(4, 'a2'),
    user(5, 'u3'),
    ev(6, { type: 'checkpoint', summary: 'S1', throughSeq: 2, usage }),
    reply(7, 'a3'),
    user(8, 'u4'),
  ];
  const plan = planCompaction(events, 2);
  assert.ok(plan, 'u2 is now older than the kept tail');
  assert.equal(plan.throughSeq, 4);
  const text = JSON.stringify(plan.messages);
  assert.ok(text.includes('S1'), 'the earlier summary is part of what gets summarized');
  assert.ok(!text.includes('"u1"') && !text.includes('"a1"'), 'turns the earlier checkpoint folded are not replayed');
  assert.ok(text.includes('"u2"') && text.includes('"a2"'));
});

test('tool results are matched to their own turn even when a call id repeats', () => {
  // Some local servers send no call ids, so generated ids can repeat across turns.
  const call = { type: 'tool_call' as const, id: 'call_0', name: 'x', input: {} };
  const turn = (seq: number) => ev(seq, { type: 'assistant_message', message: { role: 'assistant', content: [call] }, stopReason: 'tool_use', usage, model: 'm' });
  const done = (seq: number, content: string) =>
    ev(seq, { type: 'tool_finished', callId: 'call_0', operationId: 'o', result: { status: 'ok', content, truncated: false, durationMs: 0 } });
  const msgs = messagesFromEvents([
    ev(1, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'go' }] }, source: 't' }),
    turn(2), done(3, 'first'),
    turn(4), done(5, 'second'),
  ]);
  const results = msgs.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
  assert.deepEqual(results, ['first', 'second']);
});

test('extractSummary takes the text after an unclosed tag', () => {
  assert.equal(extractSummary('<summary>\nfacts'), 'facts');
  assert.equal(extractSummary('x <summary>a</summary> y'), 'a');
  assert.equal(extractSummary('plain'), 'plain');
});

test('with a time zone, each user message carries its send time; the system prompt stays the same per session', () => {
  const at = (seq: number, iso: string, p: SessionEventPayload): SessionEvent => ({ ...p, sessionId: 's', seq, at: iso });
  const events = [
    at(1, '2026-10-06T13:03:59Z', { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'what day is it?' }] }, source: 't' }),
    at(2, '2026-10-06T13:04:00Z', { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tuesday.' }] }, stopReason: 'end_turn', usage, model: 'm' }),
    at(3, '2026-10-07T08:00:00Z', { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'and now?' }] }, source: 't' }),
  ];
  const msgs = messagesFromEvents(events, { timeZone: 'Europe/London' });
  assert.deepEqual(msgs[0]!.content[0], { type: 'text', text: '[Tue 2026-10-06 14:03 Europe/London, UTC+01:00]' });
  assert.deepEqual(msgs[0]!.content[1], { type: 'text', text: 'what day is it?' });
  assert.deepEqual(msgs[2]!.content[0], { type: 'text', text: '[Wed 2026-10-07 09:00 Europe/London, UTC+01:00]' });
  assert.deepEqual(messagesFromEvents(events, { timeZone: 'Europe/London' }), msgs, 'derived from stored timestamps, so stable');
  assert.equal(messagesFromEvents(events)[0]!.content.length, 1, 'off without a time zone');
  assert.equal(turnTime('2026-01-06T13:03:00Z', 'America/New_York'), '[Tue 2026-01-06 08:03 America/New_York, UTC-05:00]');
  assert.equal(turnTime('2026-01-06T13:03:00Z', 'UTC'), '[Tue 2026-01-06 13:03 UTC, UTC+00:00]');
  assert.match(systemPrompt({ workspace: '/w', timestamps: true }), /starts with the time it was sent/);
  assert.doesNotMatch(systemPrompt({ workspace: '/w' }), /time it was sent/);
});
