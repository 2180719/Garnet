import type { ModelAdapter, ModelEvent, ModelRequest } from '../contracts/index.ts';

/**
 * A model whose provider can be swapped between calls (`/provider`). Each `stream` call goes to whichever
 * adapter is current when the call starts, so a swap never affects a request in flight. `id` and
 * `capabilities` always describe the current adapter; the runtime records `id` on every assistant message,
 * so the event log shows which provider answered each turn.
 */
export class SwitchableModel implements ModelAdapter {
  private current: ModelAdapter;

  constructor(initial: ModelAdapter) {
    this.current = initial;
  }

  get id(): string {
    return this.current.id;
  }

  get capabilities(): ModelAdapter['capabilities'] {
    return this.current.capabilities;
  }

  swap(next: ModelAdapter): void {
    this.current = next;
  }

  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    return this.current.stream(request);
  }
}
