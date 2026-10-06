/**
 * Remembers what a tool's `bind` resolved a call to, per session, so the call
 * the model repeats after an owner approval (same raw arguments, minutes later)
 * gets the same concrete values that were shown and approved instead of
 * resolving again to something else ("in 20 minutes" is a different time by
 * then, "owner" may be another chat). Entries expire, are dropped once the
 * call runs, and are lost on restart; a miss only means a fresh resolution,
 * hence a fresh approval prompt (fail closed).
 */
export class BindMemo<I> {
  private readonly entries = new Map<string, { raw: string; bound: I; at: number }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.max = options.max ?? 200;
    this.now = options.now ?? Date.now;
  }

  /** The remembered resolution for these raw arguments when still `usable`, else a new one from `compute` (remembered). */
  resolve(sessionId: string, raw: I, compute: () => I, usable: (bound: I) => boolean = () => true): I {
    const key = `${sessionId}\n${stable(raw)}`;
    const found = this.entries.get(key);
    if (found && this.now() - found.at < this.ttlMs && usable(found.bound)) return found.bound;
    const bound = compute();
    this.entries.delete(key);
    this.entries.set(key, { raw: key, bound, at: this.now() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
    return bound;
  }

  /** Forgets the resolutions that produced `bound` (the call ran). */
  consume(sessionId: string, bound: I): void {
    const b = stable(bound);
    for (const [key, e] of this.entries) if (key.startsWith(`${sessionId}\n`) && stable(e.bound) === b) this.entries.delete(key);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
