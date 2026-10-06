import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolUnion,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { attachmentText } from '../contracts/index.ts';
import type {
  ChatMessage,
  ContentBlock,
  MediaCapabilities,
  ErrorCategory,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  StopReason,
  Usage,
} from '../contracts/index.ts';

const PROVIDER = 'anthropic';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  effort?: Effort | undefined;
  /** Server-side refusal fallback ("default" routing). On unless disabled. */
  fallbacks?: boolean;
  /** Send images as image blocks. Every current Claude model has vision; on unless disabled. */
  vision?: boolean | undefined;
  /** Send PDFs as document blocks. On unless disabled. */
  pdf?: boolean | undefined;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
};

/**
 * The API takes images up to 5 MB each as base64 (so about 3.75 MB of raw
 * bytes) and requests up to 32 MB, which bounds an inline PDF.
 */
const MAX_IMAGE_BYTES = 3_750_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Anthropic Messages API adapter (official SDK, streaming).
 *
 * History is append-only: blocks this adapter does not interpret (thinking,
 * fallback markers) are stored as opaque provider blocks and sent back
 * byte-for-byte in their original position, as the API requires.
 */
export class AnthropicModel implements ModelAdapter {
  readonly id: string;
  readonly capabilities: { streaming: boolean; promptCaching: boolean; contextWindow: number; media: MediaCapabilities };
  private readonly client: Anthropic;
  private readonly options: AnthropicOptions;

  constructor(options: AnthropicOptions) {
    this.options = options;
    this.id = `${PROVIDER}:${options.model}`;
    this.capabilities = {
      streaming: true,
      promptCaching: true,
      contextWindow: 1_000_000,
      media: { images: options.vision !== false, pdf: options.pdf !== false, maxImageBytes: MAX_IMAGE_BYTES, maxPdfBytes: MAX_PDF_BYTES },
    };
    // The runtime owns retries so it can avoid duplicating streamed output.
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const useFallbacks = this.options.fallbacks !== false;
    const tools: BetaToolUnion[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaToolUnion extends { input_schema: infer S } ? S : never,
      // Inputs stream as generated; the executor validates every input against its schema.
      eager_input_streaming: true,
    }));
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.options.model,
          max_tokens: request.maxOutputTokens,
          // Breakpoint on the stable prefix (tools + system) and automatic caching of the conversation.
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' },
          messages: toParams(request.messages),
          ...(tools.length ? { tools } : {}),
          ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
          ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { signal: request.signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text_delta', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      const message: ChatMessage = { role: 'assistant', content: final.content.map(fromBlock) };
      for (const block of message.content) {
        if (block.type === 'tool_call') yield { type: 'tool_call', call: block };
      }
      yield { type: 'done', message, stopReason: mapStop(final.stop_reason), usage: mapUsage(final.usage) };
    } catch (e) {
      yield toErrorEvent(e);
    }
  }
}

/**
 * The API rejects empty text blocks, so they are left out, and so are blocks
 * from other providers. A message left with no content is dropped (the API
 * merges the consecutive user turns that can leave behind).
 */
function toParams(messages: ChatMessage[]): BetaMessageParam[] {
  return messages.flatMap((m) => {
    const content = m.content.flatMap((b) => toBlockParam(b) ?? []);
    return content.length ? [{ role: m.role, content }] : [];
  });
}

function toBlockParam(block: ContentBlock): BetaContentBlockParam | null {
  switch (block.type) {
    case 'text':
      return block.text ? { type: 'text', text: block.text } : null;
    case 'tool_call':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.callId, content: block.content, is_error: block.isError };
    case 'provider':
      // Opaque blocks from this provider are replayed unchanged.
      return block.provider === PROVIDER ? (block.data as BetaContentBlockParam) : null;
    case 'attachment': {
      // The runtime sets `data` only for what this model reads natively; anything else is described in text.
      const a = block.attachment;
      if (block.data && a.kind === 'image') {
        return { type: 'image', source: { type: 'base64', media_type: a.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: block.data } };
      }
      if (block.data && a.mimeType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: block.data }, ...(a.name ? { title: a.name } : {}) };
      }
      return { type: 'text', text: attachmentText(block) };
    }
  }
}

function fromBlock(block: BetaContentBlock): ContentBlock {
  if (block.type === 'text' && !('citations' in block && block.citations?.length)) return { type: 'text', text: block.text };
  if (block.type === 'tool_use') return { type: 'tool_call', id: block.id, name: block.name, input: block.input };
  const bound = block.type === 'thinking' || block.type === 'redacted_thinking';
  return { type: 'provider', provider: PROVIDER, data: block, ...(bound ? { bound: true } : {}) };
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason;
    default:
      return 'other';
  }
}

function mapUsage(u: BetaUsage): Usage {
  return {
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null,
  };
}

function toErrorEvent(e: unknown): ModelEvent {
  const fail = (category: ErrorCategory, message: string, retryAfterMs?: number): ModelEvent => ({
    type: 'error',
    category,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
  if (e instanceof Anthropic.APIUserAbortError) return fail('cancelled', 'Request aborted.');
  if (e instanceof Anthropic.APIConnectionError) return fail('provider_transient', `Connection error: ${e.message}`);
  if (e instanceof Anthropic.AuthenticationError) return fail('provider_fatal', 'Anthropic rejected the API key.');
  if (e instanceof Anthropic.PermissionDeniedError) return fail('provider_fatal', `Permission denied: ${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return fail('provider_fatal', `Not found (check the model name): ${e.message}`);
  if (e instanceof Anthropic.BadRequestError) return fail('provider_fatal', `Bad request: ${e.message}`);
  if (e instanceof Anthropic.RateLimitError) return fail('provider_transient', 'Rate limited.', retryAfter(e.headers));
  if (e instanceof Anthropic.APIError) {
    if (e.status === undefined) {
      // An `error` event in the middle of a stream: there is no HTTP status, only the error type.
      const type = e.type ?? 'unknown_error';
      return fail(TRANSIENT_TYPES.has(type) ? 'provider_transient' : 'provider_fatal', `Provider error (${type}): ${e.message}`);
    }
    const status = e.status;
    if (status >= 500 || status === 408 || status === 409) {
      return fail('provider_transient', `Provider error ${status}: ${e.message}`, retryAfter(e.headers));
    }
    return fail('provider_fatal', `Provider error ${status}: ${e.message}`);
  }
  return fail('internal', e instanceof Error ? e.message : String(e));
}

/** Error types (https://docs.anthropic.com/en/api/errors) worth retrying. */
const TRANSIENT_TYPES: ReadonlySet<string> = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error']);

function retryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
