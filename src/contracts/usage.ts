import type { TaskRecord } from './session.ts';

// Token usage. `null` means the provider did not report a value; it is never
// silently treated as zero.

export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

export const unknownUsage = (): Usage => ({
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
});

const add = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
  };
}

/** Total tokens the budget counts against: input (including cache) plus output. */
export function billedTokens(u: Usage): number {
  return (
    (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0)
  );
}

/** Every token a task is accountable for: its own model calls plus delegated and side-model work (`TaskRecord.delegatedUsage`). */
export function taskTokens(task: Pick<TaskRecord, 'usage' | 'delegatedUsage'>): number {
  return billedTokens(task.usage) + (task.delegatedUsage ? billedTokens(task.delegatedUsage) : 0);
}
