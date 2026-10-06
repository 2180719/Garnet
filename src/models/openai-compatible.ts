import type {
  ChatMessage,
  ContentBlock,
  MediaCapabilities,
  ErrorCategory,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  StopReason,
  ToolCallBlock,
  Usage,
} from '../contracts/index.ts';
import { attachmentText, newId, unknownUsage } from '../contracts/index.ts';

const PROVIDER = 'openai-compatible';

export type OpenAICompatibleOptions = {
  /** e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  contextWindow?: number | undefined;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch | undefined;
  extraHeaders?: Record<string, string> | undefined;
  /**
   * Which request field carries the output cap. Defaults by host: `max_completion_tokens` for
   * OpenAI and Azure OpenAI (their reasoning models reject `max_tokens`), `max_tokens` elsewhere
   * (OpenRouter, Ollama, llama.cpp, LM Studio and older vLLM only document `max_tokens`).
   */
  tokenParam?: 'max_tokens' | 'max_completion_tokens' | undefined;
  /** The model accepts `image_url` parts (vision). Off unless configured: many local models are text only. */
  vision?: boolean | undefined;
  /** The server accepts `file` parts with a PDF (OpenAI, OpenRouter). Off unless configured. */
  pdf?: boolean | undefined;
};

const MAX_INLINE_BYTES = 20 * 1024 * 1024;

type WirePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WirePart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type WireToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

type PartialCall = { id: string; name: string; args: string };

/**
 * Adapter for OpenAI-compatible Chat Completions endpoints (OpenRouter,
 * Ollama, llama.cpp, vLLM, LM Studio, ...). Streaming only, via global fetch.
 * Creates no provider blocks: history replays from text and tool calls alone.
 */
export class OpenAICompatibleModel implements ModelAdapter {
  readonly id: string;
  readonly capabilities: { streaming: boolean; promptCaching: boolean; contextWindow: number; media: MediaCapabilities };
  private readonly options: OpenAICompatibleOptions;
  private readonly tokenParam: 'max_tokens' | 'max_completion_tokens';

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
    this.id = `${PROVIDER}:${options.model}`;
    this.capabilities = {
      streaming: true,
      promptCaching: false,
      contextWindow: options.contextWindow ?? 128_000,
      media: { images: options.vision === true, pdf: options.pdf === true, maxImageBytes: MAX_INLINE_BYTES, maxPdfBytes: MAX_INLINE_BYTES },
    };
    this.tokenParam = options.tokenParam ?? (isOpenAI(options.baseUrl) ? 'max_completion_tokens' : 'max_tokens');
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const o = this.options;
    const fail = (category: ErrorCategory, message: string, retryAfterMs?: number): ModelEvent => ({
      type: 'error',
      category,
      message: redact(message, o.apiKey),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
    try {
      const messages = toWireMessages(request);
      const tools = request.tools.length
        ? request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
        : undefined;
      const body: Record<string, unknown> = {
        model: o.model,
        stream: true,
        stream_options: { include_usage: true },
        [this.tokenParam]: clampOutputTokens(request.maxOutputTokens, this.capabilities.contextWindow, promptChars(messages) + JSON.stringify(tools ?? []).length),
        messages,
      };
      if (tools) body.tools = tools;
      const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(o.extraHeaders ?? {}) };
      if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
      if (isOpenRouter(o.baseUrl)) headers['X-Title'] ??= 'Garnet';

      let response: Response;
      try {
        response = await (o.fetch ?? fetch)(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (e) {
        if (isAbort(e, request.signal)) return yield fail('cancelled', 'Request aborted.');
        return yield fail('provider_transient', `Connection error: ${msg(e)}`);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return yield httpError(response, text, fail);
      }
      if (!response.body) return yield fail('provider_transient', 'Provider returned an empty response body.');

      let text = '';
      const calls = new Map<number, PartialCall>();
      let finish: string | null = null;
      let usage: Usage | null = null;
      let sawDone = false;
      let chunks = 0;
      let streamError: { category: ErrorCategory; message: string } | null = null;

      const handle = (payload: string): ModelEvent[] => {
        const events: ModelEvent[] = [];
        if (payload === '[DONE]') {
          sawDone = true;
          return events;
        }
        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          return events; // tolerate junk lines from lenient servers
        }
        if (!json || typeof json !== 'object') return events;
        if (json.error) {
          const m = errorText(json.error);
          streamError = { category: TRANSIENT_RE.test(m) ? 'provider_transient' : 'provider_fatal', message: `Provider error: ${m}` };
          return events;
        }
        chunks++;
        if (json.usage && typeof json.usage === 'object') usage = mapUsage(json.usage);
        const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
        if (!choice) return events;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          events.push({ type: 'text_delta', text: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index = typeof tc?.index === 'number' ? tc.index : calls.size;
            const cur = calls.get(index) ?? { id: '', name: '', args: '' };
            if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
            if (typeof tc.function?.name === 'string') cur.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            calls.set(index, cur);
          }
        }
        if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
        return events;
      };

      const reader = response.body.getReader();
      let drained = false;
      try {
        const decoder = new TextDecoder();
        let buf = '';
        const lines = (final: boolean): string[] => {
          const parts = buf.split('\n');
          buf = final ? '' : (parts.pop() ?? '');
          return parts.map((l) => l.replace(/\r$/, ''));
        };
        const process = function* (ls: string[]): Generator<ModelEvent> {
          for (const line of ls) {
            if (!line.startsWith('data:')) continue; // comments, keepalives, event:/id: fields
            yield* handle(line.slice(5).trim());
          }
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            drained = true;
            break;
          }
          buf += decoder.decode(value, { stream: true });
          yield* process(lines(false));
          if (streamError) break;
        }
        if (!streamError) {
          buf += decoder.decode();
          yield* process(lines(true));
        }
      } catch (e) {
        if (isAbort(e, request.signal)) return yield fail('cancelled', 'Request aborted.');
        return yield fail('provider_transient', `Stream interrupted: ${msg(e)}`);
      } finally {
        // Stopped early (a mid-stream error, or the consumer stopped listening):
        // release the connection instead of leaving the body unread.
        if (!drained) void reader.cancel().catch(() => {});
      }

      if (request.signal?.aborted) return yield fail('cancelled', 'Request aborted.');
      if (streamError) return yield fail((streamError as { category: ErrorCategory }).category, (streamError as { message: string }).message);
      if (!sawDone && finish === null) {
        return yield fail('provider_transient', chunks ? 'Stream ended before completion.' : 'Provider returned no data.');
      }

      const content: ContentBlock[] = [];
      if (text) content.push({ type: 'text', text });
      const toolCalls: ToolCallBlock[] = [];
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        toolCalls.push({ type: 'tool_call', id: c.id || newId('call'), name: c.name, input: parseArgs(c.args) });
      }
      content.push(...toolCalls);
      for (const call of toolCalls) yield { type: 'tool_call', call };
      const finalUsage = usage ?? unknownUsage();
      yield {
        type: 'done',
        message: { role: 'assistant', content },
        stopReason: mapStop(finish, toolCalls.length > 0),
        usage: finalUsage,
      };
    } catch (e) {
      if (isAbort(e, request.signal)) yield fail('cancelled', 'Request aborted.');
      else yield fail('internal', msg(e));
    }
  }
}

const TRANSIENT_RE = /overloaded|rate.?limit|too many requests|try again|temporar|unavailable/i;

function toWireMessages(request: ModelRequest): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: request.system }];
  for (const m of request.messages) {
    if (m.role === 'assistant') {
      const wire = assistantToWire(m);
      if (wire) out.push(wire);
      continue;
    }
    // Tool results first: OpenAI requires them right after the assistant tool_calls message.
    const parts: WirePart[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.callId, content: b.isError ? `Error: ${b.content}` : b.content });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'attachment') {
        // `data` is set only for what this model reads natively; anything else is described in text.
        const a = b.attachment;
        if (b.data && a.kind === 'image') parts.push({ type: 'image_url', image_url: { url: `data:${a.mimeType};base64,${b.data}` } });
        else if (b.data && a.mimeType === 'application/pdf') parts.push({ type: 'file', file: { filename: a.name ?? 'document.pdf', file_data: `data:application/pdf;base64,${b.data}` } });
        else parts.push({ type: 'text', text: attachmentText(b) });
      }
    }
    if (parts.length === 0) continue;
    // Plain string content unless there is media: text-only local servers often reject part arrays.
    if (parts.every((p) => p.type === 'text')) out.push({ role: 'user', content: parts.map((p) => (p as { text: string }).text).join('\n\n') });
    else out.push({ role: 'user', content: parts });
  }
  return out;
}

function assistantToWire(m: ChatMessage): WireMessage | null {
  const texts: string[] = [];
  const toolCalls: WireToolCall[] = [];
  for (const b of m.content) {
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'tool_call') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) },
      });
    }
    // Provider blocks (ours are never created; foreign ones are meaningless here) are dropped.
  }
  const content = texts.join('');
  if (!content && !toolCalls.length) return null;
  return { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // the executor's repair step turns this into an actionable error
  }
}

function mapStop(reason: string | null, hasCalls: boolean): StopReason {
  switch (reason) {
    case 'stop':
      return hasCalls ? 'tool_use' : 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case null:
      return hasCalls ? 'tool_use' : 'end_turn';
    default:
      return 'other';
  }
}

function mapUsage(u: any): Usage {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const prompt = num(u.prompt_tokens);
  // prompt_tokens includes both; OpenRouter reports cache writes for providers that bill them.
  const cached = num(u.prompt_tokens_details?.cached_tokens);
  const written = num(u.prompt_tokens_details?.cache_write_tokens);
  return {
    inputTokens: prompt === null ? null : Math.max(0, prompt - (cached ?? 0) - (written ?? 0)),
    outputTokens: num(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

function httpError(
  res: Response,
  body: string,
  fail: (c: ErrorCategory, m: string, r?: number) => ModelEvent,
): ModelEvent {
  const s = res.status;
  const excerpt = excerptOf(body);
  const detail = excerpt ? `: ${excerpt}` : '';
  if (s === 401 || s === 403) {
    return fail('provider_fatal', `Provider rejected the credentials (HTTP ${s}); check the API key and its permissions${detail}`);
  }
  if (s === 408 || s === 409 || s === 429 || s >= 500) {
    return fail('provider_transient', `Provider error HTTP ${s}${detail}`, retryAfter(res.headers));
  }
  if (s === 400 || s === 404 || s === 422) {
    return fail('provider_fatal', `Provider rejected the request (HTTP ${s}; check the model name and base URL)${detail}`);
  }
  return fail('provider_fatal', `Provider error HTTP ${s}${detail}`);
}

function excerptOf(body: string): string {
  let text = body.trim();
  try {
    const j = JSON.parse(text);
    if (j?.error !== undefined) text = errorText(j.error);
    else if (typeof j?.message === 'string') text = j.message;
  } catch {
    // not JSON: use raw text
  }
  text = text.replace(/\s+/g, ' ');
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const parts = [o.type, o.code, o.message].filter((v) => typeof v === 'string' && v) as string[];
    if (parts.length) return parts.join(' ');
  }
  return 'unknown error';
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Below this, a clamped request is unlikely to be useful; send it anyway and let the server decide. */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * Caps the output so prompt + output fits the context window. Servers such as vLLM and
 * llama.cpp reject a request whose prompt plus max_tokens exceeds the model length, and the
 * default cap (32k) is larger than many local models' whole window. The prompt is estimated
 * generously (3 characters per token, an overestimate for most text) so the sum stays inside.
 */
export function clampOutputTokens(requested: number, contextWindow: number, promptChars: number): number {
  const room = contextWindow - Math.ceil(promptChars / 3);
  return Math.max(1, Math.min(requested, Math.max(MIN_OUTPUT_TOKENS, room)));
}

/** Characters of prompt text for the estimate. Inline files (data URLs) count as a flat ~1.5k tokens, not their base64 length. */
export function promptChars(messages: WireMessage[]): number {
  let inline = 0;
  const text = JSON.stringify(messages, (_key, value: unknown) => {
    if (typeof value === 'string' && value.startsWith('data:')) {
      inline += 1;
      return '';
    }
    return value;
  });
  return text.length + inline * INLINE_FILE_CHARS;
}

const INLINE_FILE_CHARS = 4500;

/** OpenAI proper and Azure OpenAI, which want max_completion_tokens. */
function isOpenAI(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.openai.com' || host.endsWith('.openai.azure.com');
  } catch {
    return false;
  }
}

function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

function isAbort(e: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (e instanceof Error && e.name === 'AbortError');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function redact(text: string, key: string | undefined): string {
  return key ? text.split(key).join('[redacted]') : text;
}
