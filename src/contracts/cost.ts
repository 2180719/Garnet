// Dollar cost from token usage. Unknown is `null` and shown as `?`; it is never
// treated as $0 (no pricing, or a token count the provider did not report).

import type { SessionEvent } from './session.ts';
import type { Usage } from './usage.ts';

/** USD per million tokens. Cache prices may be omitted; cache tokens then make the cost unknown. */
export type Pricing = { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined };

/**
 * Anthropic list prices, checked on https://platform.claude.com/docs/en/about-claude/pricing
 * on 2026-10-06. Cache write is the 5-minute price (what Garnet's adapter requests).
 * Keys are model IDs; a dated snapshot (`<id>-YYYYMMDD`) matches its alias.
 */
const ANTHROPIC_PRICING: Record<string, Pricing> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Configured pricing wins; otherwise the built-in Anthropic price for exactly this model ID; otherwise unknown. */
export function resolvePricing(provider: string, modelId: string, configured?: Pricing | undefined): Pricing | undefined {
  if (configured) return configured;
  if (provider !== 'anthropic') return undefined;
  const id = modelId.replace(/-\d{8}$/, '');
  return Object.hasOwn(ANTHROPIC_PRICING, id) ? ANTHROPIC_PRICING[id] : undefined;
}

/** USD for one usage record, or null when it cannot be known. */
export function costOf(usage: Usage, pricing: Pricing | undefined): number | null {
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) return null;
  let usd = usage.inputTokens * pricing.input + usage.outputTokens * pricing.output;
  for (const [tokens, price] of [[usage.cacheReadTokens, pricing.cacheRead], [usage.cacheWriteTokens, pricing.cacheWrite]] as const) {
    if (price === undefined) {
      if (tokens) return null; // cache tokens exist but have no price
    } else if (tokens === null) {
      return null;
    } else {
      usd += tokens * price;
    }
  }
  return usd / 1_000_000;
}

/** Sum of several records: null if any is unknown. */
export function sumCost(costs: (number | null)[]): number | null {
  let total = 0;
  for (const c of costs) {
    if (c === null) return null;
    total += c;
  }
  return total;
}

export function formatUsd(usd: number | null): string {
  if (usd === null) return '?';
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Cost of a session's model calls (assistant turns and compaction summaries); null if any call's cost is unknown. */
export function eventsCost(events: readonly SessionEvent[], pricing: Pricing | undefined): number | null {
  return sumCost(events.flatMap((e) => (e.type === 'assistant_message' || e.type === 'checkpoint' ? [costOf(e.usage, pricing)] : [])));
}
