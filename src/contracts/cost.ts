// Dollar cost from token usage. Unknown is `null` and shown as `?`; it is never
// treated as $0 (no pricing, or a token count the provider did not report).

import type { SessionEvent } from './session.ts';
import type { Usage } from './usage.ts';

/** USD per million tokens. Cache prices may be omitted; they are then derived from `input` (see `CACHE_READ_MULTIPLIER`). */
export type Pricing = { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined; tiers?: readonly PriceTier[] | undefined };

/** Higher rates a model charges for a whole call whose prompt (input + cache read + cache write tokens) exceeds `minPromptTokens`. */
export type PriceTier = { minPromptTokens: number; input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined };

/** The rates that apply to a call with this many prompt tokens: the highest tier it exceeds, else the base rates. */
function ratesFor(pricing: Pricing, promptTokens: number): Pricing {
  const tier = (pricing.tiers ?? []).filter((t) => promptTokens > t.minPromptTokens).sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
  return tier ?? pricing;
}

/**
 * Configured pricing wins; otherwise whatever `lookup` knows (the model catalog, supplied by the composition
 * root so contracts stays dependency-free); otherwise unknown. A dated snapshot id is not resolved here: the
 * lookup decides how ids map to prices.
 */
export function resolvePricing(configured: Pricing | undefined, lookup?: () => Pricing | undefined): Pricing | undefined {
  return configured ?? lookup?.();
}

/** Anthropic's standard cache multipliers on the input price, used when custom pricing omits the cache prices. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Names of the cache prices that `costOf` derives from `input` because `pricing` leaves them out. */
export function derivedCachePrices(pricing: Pricing): ('cacheRead' | 'cacheWrite')[] {
  return (['cacheRead', 'cacheWrite'] as const).filter((k) => pricing[k] === undefined);
}

/** USD for one usage record, or null when it cannot be known. */
export function costOf(usage: Usage, pricing: Pricing | undefined): number | null {
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) return null;
  pricing = ratesFor(pricing, usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
  let usd = usage.inputTokens * pricing.input + usage.outputTokens * pricing.output;
  for (const [tokens, price] of [
    [usage.cacheReadTokens, pricing.cacheRead ?? (tokens0(usage.cacheReadTokens) ? pricing.input * CACHE_READ_MULTIPLIER : undefined)],
    [usage.cacheWriteTokens, pricing.cacheWrite ?? (tokens0(usage.cacheWriteTokens) ? pricing.input * CACHE_WRITE_MULTIPLIER : undefined)],
  ] as const) {
    if (price === undefined) {
      continue; // no cache price and no cache tokens (or not reported): nothing to add
    } else if (tokens === null) {
      return null;
    } else {
      usd += tokens * price;
    }
  }
  return usd / 1_000_000;
}

const tokens0 = (n: number | null): boolean => n !== null && n > 0;

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

/**
 * The instant (ISO, UTC) at which the calendar day containing `now` began in `timeZone`.
 * Falls back to the UTC day for an unknown zone.
 */
export function startOfDayIso(timeZone: string, now: Date = new Date()): string {
  try {
    const parts = (at: Date) => {
      const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
      const o: Record<string, number> = {};
      for (const p of f.formatToParts(at)) if (p.type !== 'literal') o[p.type] = Number(p.value);
      return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
    };
    const n = parts(now);
    // Local wall-clock midnight as if it were UTC, then corrected by the zone's offset at that moment.
    const wallMidnight = Date.UTC(n.year, n.month - 1, n.day);
    let guess = wallMidnight;
    for (let i = 0; i < 3; i++) {
      const g = parts(new Date(guess));
      const wall = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second);
      guess += wallMidnight - wall;
    }
    return new Date(guess).toISOString();
  } catch {
    return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  }
}
