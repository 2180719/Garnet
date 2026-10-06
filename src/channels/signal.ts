// Signal adapter: talks to a local signal-cli daemon (HTTP mode): SSE receive, JSON-RPC send.
import {
  RubyError,
  errorMessage,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundMessage,
  type InboundSink,
  type OutboundMessage,
  type SendResult,
} from '../contracts/index.ts';
import { AMBIGUOUS_STATUSES, mayHaveReachedServer } from './delivery.ts';

export type SignalOptions = {
  /** signal-cli daemon base URL. Plain http is only allowed for loopback hosts. */
  baseUrl?: string;
  /** The bot's own E.164 number, e.g. "+15551234567". */
  account: string;
  fetch?: typeof fetch;
  /** Backoff sleep; must resolve early when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const NUMBER_SHAPE = /^\+[1-9]\d{6,14}$/;
const MAX_CHARS = 4000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SINK_ATTEMPTS = 4;
/** An SSE stream may be idle for long stretches; a connected stream counts as healthy, otherwise traffic must be recent. */
const HEALTH_WINDOW_MS = 120_000;

type Envelope = {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: { message?: string | null; groupInfo?: { groupId?: string } | null } | null;
};

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** Split into chunks of at most `max` chars, preferring paragraph, then line, boundaries. */
function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) {
      cut = max;
      const last = window.charCodeAt(max - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // do not split a surrogate pair
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  chunks.push(rest);
  return chunks.map((c) => c.trimEnd()).filter((c) => c.length > 0);
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** A daemon call that failed. `status` is 0 for network failures; `rpcCode` is set for JSON-RPC errors. */
class SignalApiError extends Error {
  readonly status: number;
  readonly rpcCode: number | undefined;
  /** The request may have been carried out (timeout, reset, unreadable success response). */
  readonly maybeDelivered: boolean;
  constructor(status: number, message: string, rpcCode?: number, maybeDelivered = false) {
    super(message);
    this.name = 'SignalApiError';
    this.status = status;
    this.rpcCode = rpcCode;
    this.maybeDelivered = maybeDelivered;
  }
}

const UNREACHABLE_HINT = (base: string, account: string) =>
  `signal-cli daemon not reachable at ${base} — start it with: signal-cli -a ${account} daemon --http 127.0.0.1:8080`;

export class SignalChannel implements ChannelAdapter {
  readonly channel = 'signal';
  readonly account: string;
  readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_CHARS, dedupesSends: false, typingIndicator: true };

  #fetch: typeof fetch;
  #base: string;
  #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #rpcId = 0;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #lastSuccessAt: number | null = null;
  #lastError: string | null = null;
  #connected = false;
  #lastEventId: string | null = null;

  constructor(options: SignalOptions) {
    if (typeof options.account !== 'string' || !NUMBER_SHAPE.test(options.account)) {
      throw new RubyError('config', 'Signal account must be an E.164 phone number such as "+15551234567"');
    }
    this.account = options.account;
    const raw = options.baseUrl ?? 'http://127.0.0.1:8080';
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new RubyError('config', 'Signal baseUrl is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RubyError('config', 'Signal baseUrl must be an http(s) URL');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw new RubyError(
        'config',
        'Refusing non-loopback http Signal baseUrl: the signal-cli JSON-RPC endpoint is unauthenticated. Use a loopback address or an https URL (e.g. behind an authenticating reverse proxy).',
      );
    }
    this.#base = raw.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async start(sink: InboundSink): Promise<void> {
    if (this.#loop) return;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const res = await this.#fetch(`${this.#base}/api/v1/check`, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
    } catch {
      this.#controller = null;
      throw new RubyError('config', UNREACHABLE_HINT(this.#base, this.account));
    }
    this.#lastSuccessAt = Date.now();
    this.#lastError = null;
    this.#loop = this.#receiveLoop(sink, controller.signal).finally(() => {
      this.#loop = null;
      this.#connected = false;
    });
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    const loop = this.#loop;
    this.#controller = null;
    if (loop) await loop;
  }

  health(): ChannelHealth {
    const fresh = this.#lastSuccessAt !== null && Date.now() - this.#lastSuccessAt <= HEALTH_WINDOW_MS;
    return {
      ok: this.#connected || fresh,
      lastSuccessAt: this.#lastSuccessAt === null ? null : new Date(this.#lastSuccessAt).toISOString(),
      lastError: this.#lastError,
    };
  }

  async typing(chatId: string): Promise<void> {
    try {
      await this.#rpc('sendTyping', this.#target(chatId), AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch {
      // A missing typing hint is harmless.
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const chunks = splitText(message.text, MAX_CHARS);
    if (chunks.length === 0) return { status: 'failed', retryable: false, error: 'Cannot send an empty message' };
    const externalIds: string[] = [];
    for (const [i, text] of chunks.entries()) {
      try {
        const result = (await this.#rpc('send', { ...this.#target(message.chatId), message: text }, AbortSignal.timeout(REQUEST_TIMEOUT_MS))) as
          | { timestamp?: number; results?: { type?: string }[] }
          | null;
        const bad = (result?.results ?? []).find((r) => typeof r.type === 'string' && r.type !== 'SUCCESS');
        if (bad) {
          const type = String(bad.type);
          throw new SignalApiError(type === 'NETWORK_FAILURE' ? 0 : 400, `Signal send failed for recipient: ${type}`);
        }
        externalIds.push(`${this.account}:${result?.timestamp ?? this.#rpcId}`);
        this.#lastSuccessAt = Date.now();
      } catch (e) {
        const err = e instanceof SignalApiError ? e : new SignalApiError(0, errorMessage(e), undefined, true);
        const partial = externalIds.length ? ` (after sending ${externalIds.length} of ${chunks.length} chunks)` : '';
        // Resending after an ambiguous failure could duplicate the message; the gateway leaves it for the owner.
        if (err.maybeDelivered) return { status: 'uncertain', error: `${err.message}${partial}` };
        let retryable = err.status === 0 || err.status === 429 || err.status >= 500;
        if (err.rpcCode !== undefined) retryable = /network|timed? ?out|connection|unavailable/i.test(err.message);
        if (/unregistered|not registered|invalid (number|recipient|group)|unknown group|not a member/i.test(err.message)) retryable = false;
        return { status: 'failed', retryable, error: `${err.message}${partial}` };
      }
    }
    return { status: 'sent', externalIds };
  }

  #target(chatId: string): Record<string, unknown> {
    return chatId.startsWith('group:') ? { groupId: chatId.slice('group:'.length) } : { recipient: [chatId] };
  }

  async #receiveLoop(sink: InboundSink, signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    const wait = (ms: number) => this.#sleep(ms, signal);
    while (!signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const headers: Record<string, string> = { accept: 'text/event-stream' };
        if (this.#lastEventId !== null) headers['last-event-id'] = this.#lastEventId;
        const res = await this.#fetch(`${this.#base}/api/v1/events`, { headers, signal });
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          throw new SignalApiError(res.status, `Signal events stream failed with ${res.status}`);
        }
        this.#connected = true;
        this.#lastSuccessAt = Date.now();
        this.#lastError = null;
        backoff = MIN_BACKOFF_MS;
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let dataLines: string[] = [];
        let eventId: string | null = null;
        const dispatch = async () => {
          const data = dataLines.join('\n');
          const id = eventId;
          dataLines = [];
          eventId = null;
          if (data !== '') await this.#handleEvent(data, sink, signal);
          if (id !== null) this.#lastEventId = id;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.#lastSuccessAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
            // A lone trailing \r may be the first half of \r\n; wait for more input.
            if (buffer[nl] === '\r' && nl === buffer.length - 1) break;
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? nl + 2 : nl + 1);
            if (line === '') await dispatch();
            else if (line.startsWith(':')) continue; // keepalive comment
            else {
              const colon = line.indexOf(':');
              const field = colon === -1 ? line : line.slice(0, colon);
              let val = colon === -1 ? '' : line.slice(colon + 1);
              if (val.startsWith(' ')) val = val.slice(1);
              if (field === 'data') dataLines.push(val);
              else if (field === 'id') eventId = val;
            }
          }
          if (signal.aborted) break;
        }
        if (!signal.aborted) this.#lastError = 'events stream ended; reconnecting';
      } catch (e) {
        if (signal.aborted) break;
        this.#lastError = `events stream failed: ${errorMessage(e)}`;
      } finally {
        this.#connected = false;
        await reader?.cancel().catch(() => {});
      }
      if (signal.aborted) break;
      await wait(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  async #handleEvent(data: string, sink: InboundSink, signal: AbortSignal): Promise<void> {
    let inbound: InboundMessage | null = null;
    try {
      inbound = this.#toInbound(JSON.parse(data));
    } catch {
      this.#lastError = 'ignored malformed event from signal-cli';
      return;
    }
    if (!inbound) return;
    // SSE has no offsets: retry in place a few times, then drop the message and move on.
    let delay = MIN_BACKOFF_MS;
    for (let attempt = 1; attempt <= SINK_ATTEMPTS; attempt++) {
      try {
        await sink(inbound);
        return;
      } catch (e) {
        this.#lastError = `inbound sink failed (attempt ${attempt} of ${SINK_ATTEMPTS})${attempt === SINK_ATTEMPTS ? '; message dropped' : ''}: ${errorMessage(e)}`;
        if (attempt === SINK_ATTEMPTS || signal.aborted) return;
        await this.#sleep(delay, signal);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  #toInbound(event: unknown): InboundMessage | null {
    const note = event as { method?: string; params?: { envelope?: Envelope; account?: string } } | null;
    if (!note || note.method !== 'receive') return null;
    if (note.params?.account !== undefined && note.params.account !== this.account) return null;
    const env = note.params?.envelope;
    if (!env) return null;
    const text = env.dataMessage?.message;
    if (typeof text !== 'string' || text === '') return null;
    const number = env.sourceNumber ?? (env.source && env.source.startsWith('+') ? env.source : undefined) ?? undefined;
    if (number === this.account || env.source === this.account) return null; // never process our own messages
    const senderId = env.sourceUuid ?? number ?? env.source;
    if (!senderId || typeof env.timestamp !== 'number') return null;
    const groupId = env.dataMessage?.groupInfo?.groupId;
    const direct = number ?? env.sourceUuid ?? senderId;
    return {
      channel: this.channel,
      account: this.account,
      chatId: groupId ? `group:${groupId}` : direct,
      externalId: `${senderId}:${env.timestamp}`,
      sender: { id: senderId, ...(env.sourceName ? { displayName: env.sourceName } : {}) },
      text,
      isPrivate: !groupId,
      receivedAt: new Date(env.timestamp).toISOString(),
    };
  }

  async #rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const id = ++this.#rpcId;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/api/v1/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
        signal,
      });
    } catch (e) {
      throw new SignalApiError(0, `Signal ${method} request failed: ${errorMessage(e)}`, undefined, mayHaveReachedServer(e));
    }
    let payload: { result?: unknown; error?: { code?: number; message?: string } } = {};
    let readable = true;
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // Non-JSON body: fall through to the status check.
      readable = false;
    }
    if (payload.error) {
      throw new SignalApiError(res.ok ? 200 : res.status, `Signal ${method} failed: ${payload.error.message ?? 'unknown error'}`, payload.error.code ?? -1);
    }
    if (!res.ok) throw new SignalApiError(res.status, `Signal ${method} failed with ${res.status}`, undefined, AMBIGUOUS_STATUSES.has(res.status));
    // A success status whose body could not be read: the daemon may have sent the message.
    if (!readable) throw new SignalApiError(res.status, `Signal ${method} returned an unreadable response`, undefined, true);
    return payload.result;
  }
}
