/**
 * Serializes work per key (one active run per session) while capping total
 * concurrency across keys.
 */
export class LaneQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.withSlot(job));
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }

  /** Resolves when every queued and running job has settled. */
  async idle(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()]);
  }

  get pendingKeys(): number {
    return this.tails.size;
  }

  private async withSlot<T>(job: () => Promise<T>): Promise<T> {
    // A finishing job hands its slot straight to the next waiter (`active` is
    // unchanged), so a newcomer cannot take it in between and exceed the cap.
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r));
    else this.active += 1;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
