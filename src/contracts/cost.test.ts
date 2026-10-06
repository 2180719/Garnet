import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, eventsCost, formatUsd, resolvePricing, startOfDayIso, sumCost } from './cost.ts';
import type { SessionEvent } from './session.ts';
import type { Usage } from './usage.ts';

const u = (inputTokens: number | null, outputTokens: number | null, cacheReadTokens: number | null = 0, cacheWriteTokens: number | null = 0): Usage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

test('cost is tokens times USD per million, cache included', () => {
  assert.equal(costOf(u(1_000_000, 100_000, 500_000, 200_000), price), 4 + 2 + 0.1 + 1);
});

test('unknown tokens or no pricing give null, never 0', () => {
  assert.equal(costOf(u(null, 10), price), null);
  assert.equal(costOf(u(10, null), price), null);
  assert.equal(costOf(u(10, 10, null, 0), price), null, 'unreported cache tokens with a cache price');
  assert.equal(costOf(u(10, 10), undefined), null);
  assert.equal(costOf(u(1_000_000, 0, 1_000_000, 1_000_000), { input: 1, output: 1 }), 1 + 0.1 + 1.25, 'missing cache prices derive from input (0.1x read, 1.25x write)');
  assert.equal(costOf(u(1_000_000, 0, 1_000_000, 0), { input: 1, output: 1, cacheRead: 0.5 }), 1.5, 'a given cache price is kept');
  assert.equal(costOf(u(1_000_000, 0, null, null), { input: 1, output: 1 }), 1, 'unreported cache is fine when there is no cache price');
  assert.equal(sumCost([1, null]), null);
  assert.equal(sumCost([1, 2]), 3);
});

test('formatting: ? for unknown, four decimals under a cent', () => {
  assert.equal(formatUsd(null), '?');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0012), '$0.0012');
  assert.equal(formatUsd(1.234), '$1.23');
});

test('built-in prices exist only for known Anthropic models; configured pricing wins', () => {
  assert.deepEqual(resolvePricing('anthropic', 'claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.equal(resolvePricing('anthropic', 'claude-opus-5-5-20260101')?.input, 4, 'a dated snapshot matches its alias');
  assert.equal(resolvePricing('anthropic', 'claude-opus-5')?.input, 5, 'opus 5 is not opus 5.5');
  assert.equal(resolvePricing('anthropic', 'claude-unknown-9'), undefined);
  assert.equal(resolvePricing('openai-compatible', 'claude-opus-5-5'), undefined);
  assert.equal(resolvePricing('fake', 'x'), undefined);
  assert.equal(resolvePricing('openai-compatible', 'llama', { input: 0, output: 0 })?.input, 0, 'a local model can be priced at zero on purpose');
});

test('session cost sums model calls and is unknown if any call is', () => {
  const call = (usage: Usage): SessionEvent => ({ type: 'assistant_message', message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage, model: 'm', seq: 1, at: '' }) as unknown as SessionEvent;
  assert.equal(eventsCost([call(u(1_000_000, 0)), call(u(1_000_000, 0))], price), 8);
  assert.equal(eventsCost([call(u(1_000_000, 0)), call(u(null, null))], price), null);
});

test('startOfDayIso is local midnight in the given zone', () => {
  const now = new Date('2026-10-06T03:30:00Z');
  assert.equal(startOfDayIso('UTC', now), '2026-10-06T00:00:00.000Z');
  assert.equal(startOfDayIso('America/Los_Angeles', now), '2026-10-05T07:00:00.000Z', 'still Oct 5 in LA (PDT)');
  assert.equal(startOfDayIso('Asia/Tokyo', now), '2026-10-05T15:00:00.000Z');
  assert.equal(startOfDayIso('Not/AZone', now), '2026-10-06T00:00:00.000Z', 'unknown zone falls back to UTC');
});
