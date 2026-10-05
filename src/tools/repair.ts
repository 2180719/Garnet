import type { ToolCallBlock } from '../contracts/index.ts';

export type Repaired = { call: ToolCallBlock; repairs: string[] };

/**
 * Deterministic, unambiguous repairs only. Never guesses paths, recipients or
 * other consequential arguments, and grants no permissions: the repaired call
 * goes through validation and policy like any other.
 */
export function repairCall(call: ToolCallBlock, toolNames: string[]): Repaired {
  const repairs: string[] = [];
  let { name, input } = call;

  if (!toolNames.includes(name)) {
    const normalized = normalizeName(name);
    const matches = toolNames.filter((t) => normalizeName(t) === normalized);
    if (matches.length === 1) {
      repairs.push(`tool name "${name}" → "${matches[0]}"`);
      name = matches[0]!;
    }
  }

  if (typeof input === 'string') {
    const parsed = parseJsonLoosely(input);
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      repairs.push('arguments were a JSON string; parsed them');
      input = parsed;
    }
  }

  return { call: repairs.length ? { ...call, name, input } : call, repairs };
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

/** Parses JSON after stripping a surrounding code fence and trailing commas. */
function parseJsonLoosely(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  for (const candidate of [t, t.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}
