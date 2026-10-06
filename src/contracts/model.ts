import type { ChatMessage, ToolCallBlock } from './messages.ts';
import type { Usage } from './usage.ts';
import type { ErrorCategory } from './errors.ts';

/** Tool schema as sent to a model. */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
};

export type ModelRequest = {
  /** Stable instruction prefix. Adapters may mark it cacheable. */
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCallBlock }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; message: ChatMessage; stopReason: StopReason; usage: Usage }
  | { type: 'error'; category: ErrorCategory; message: string; retryAfterMs?: number };

/** What a model can read natively besides text. Absent means text only. */
export type MediaCapabilities = {
  /** image/jpeg, image/png, image/gif and image/webp as image blocks. */
  images: boolean;
  /** application/pdf as a document block. */
  pdf: boolean;
  /** Largest single image or PDF the provider accepts inline. */
  maxImageBytes: number;
  maxPdfBytes: number;
};

export type ModelCapabilities = {
  streaming: boolean;
  promptCaching: boolean;
  contextWindow: number;
  media?: MediaCapabilities;
};

export interface ModelAdapter {
  readonly id: string; // e.g. "anthropic:claude-sonnet-5-5"
  readonly capabilities: ModelCapabilities;
  /**
   * Streams one model turn. Must end with exactly one `done` or `error` event.
   * Must not throw for provider failures; report them as `error` events.
   */
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
