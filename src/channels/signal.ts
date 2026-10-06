// Signal adapter: talks to a local signal-cli daemon (HTTP mode): SSE receive, JSON-RPC send.
import {
  GarnetError,
  errorMessage,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHealth,
  type InboundAttachment,
  type InboundMessage,
  type InboundSink,
  type OutboundMessage,
  type SendResult,
  type UnsupportedContent,
} from '../contracts/index.ts';
import { readFile } from 'node:fs/promises';
import { AMBIGUOUS_STATUSES, abortableSleep, mayHaveReachedServer, sendChunks, sendUnits, splitText, type ChunkFailure } from './delivery.ts';
import { markdownToPlain } from './markdown.ts';

export type SignalOptions = {
  /** signal-cli daemon base URL. Plain http is only allowed for loopback hosts. */
  baseUrl?: string;
  /** The bot's own E.164 number, e.g. "+15551234567". */
  account: string;
  fetch?: typeof fetch;
  /** Backoff sleep; must resolve early when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Reconnect when the event stream is silent this long (signal-cli sends a keepalive every 15 s). Default 60 s. */
  idleTimeoutMs?: number;
};

const NUMBER_SHAPE = /^\+[1-9]\d{6,14}$/;
const MAX_CHARS = 4000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SINK_ATTEMPTS = 4;
/** An SSE stream may be idle for long stretches; a connected stream counts as healthy, otherwise traffic must be recent. */
const HEALTH_WINDOW_MS = 120_000;
const IDLE_TIMEOUT_MS = 60_000;

type Envelope = {
  source?: string;
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number;
  dataMessage?: {
    message?: string | null;
    groupInfo?: { groupId?: string } | null;
    attachments?: { id?: string; contentType?: string; filename?: string | null; size?: number; voiceNote?: boolean }[] | null;
    sticker?: unknown;
  } | null;
};

/** Signal's attachment limit is 100 MiB. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

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
  readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_CHARS, dedupesSends: false, typingIndicator: true, maxUploadBytes: MAX_UPLOAD_BYTES };

  #fetch: typeof fetch;
  #base: string;
  #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #idleTimeoutMs: number;
  #rpcId = 0;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #lastSuccessAt: number | null = null;
  #lastError: string | null = null;
  #connected = false;
  #lastEventId: string | null = null;

  constructor(options: SignalOptions) {
    if (typeof options.account !== 'string' || !NUMBER_SHAPE.test(options.account)) {
      throw new GarnetError('config', 'Signal account must be an E.164 phone number such as "+15551234567"');
    }
    this.account = options.account;
    const raw = options.baseUrl ?? 'http://127.0.0.1:8080';
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new GarnetError('config', 'Signal baseUrl is not a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new GarnetError('config', 'Signal baseUrl must be an http(s) URL');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw new GarnetError(
        'config',
        'Refusing non-loopback http Signal baseUrl: the signal-cli JSON-RPC endpoint is unauthenticated. Use a loopback address or an https URL (e.g. behind an authenticating reverse proxy).',
      );
    }
    this.#base = raw.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
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
      throw new GarnetError('config', UNREACHABLE_HINT(this.#base, this.account));
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
    return sendChunks(
      // Signal shows markdown markers literally: send plain text (captions too).
      sendUnits({ ...message, text: markdownToPlain(message.text) }, MAX_CHARS, MAX_CHARS, splitText),
      async (unit) => {
        const params: Record<string, unknown> = { ...this.#target(message.chatId), message: unit.kind === 'text' ? unit.text : (unit.caption ?? '') };
        if (unit.kind === 'file') {
          if (unit.file.size > MAX_UPLOAD_BYTES) throw new SignalApiError(413, `Signal accepts attachments up to 100 MB; ${unit.file.name} is larger`);
          // A data URI (RFC 2397 with a filename) works whether or not the daemon shares this filesystem.
          const data = (await readFile(unit.file.path)).toString('base64');
          params.attachments = [`data:${unit.file.mimeType};filename=${safeFilename(unit.file.name)};base64,${data}`];
        }
        const timeout = AbortSignal.timeout(unit.kind === 'file' ? REQUEST_TIMEOUT_MS * 4 : REQUEST_TIMEOUT_MS);
        const result = (await this.#rpc('send', params, timeout)) as
          | { timestamp?: number; results?: { type?: string }[] }
          | null;
        // One result per recipient (a group has many). It counts as sent if anyone got it: resending
        // because one member failed would duplicate it for everyone else.
        const results = (result?.results ?? []).filter((r) => typeof r?.type === 'string');
        if (results.length > 0 && !results.some((r) => r.type === 'SUCCESS')) {
          const type = String(results[0]!.type);
          throw new SignalApiError(type === 'NETWORK_FAILURE' || type === 'RATE_LIMIT_FAILURE' ? 0 : 400, `Signal send failed for recipient: ${type}`);
        }
        this.#lastSuccessAt = Date.now();
        return `${this.account}:${result?.timestamp ?? this.#rpcId}`;
      },
      (e) => this.#classify(e),
      (ms) => this.#sleep(ms, new AbortController().signal),
    );
  }

  async fetchAttachment(ref: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ data: Uint8Array; mimeType?: string }> {
    let parsed: { id?: unknown; recipient?: unknown; groupId?: unknown };
    try {
      parsed = JSON.parse(ref) as typeof parsed;
    } catch {
      throw new Error('not a Signal attachment reference');
    }
    if (typeof parsed.id !== 'string') throw new Error('not a Signal attachment reference');
    const params: Record<string, unknown> = { id: parsed.id };
    if (typeof parsed.groupId === 'string') params.groupId = parsed.groupId;
    else if (typeof parsed.recipient === 'string') params.recipient = parsed.recipient;
    let result: unknown;
    try {
      result = await this.#rpc('getAttachment', params, AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4)]));
    } catch (e) {
      throw new Error(`signal-cli could not provide the attachment: ${errorMessage(e)}`);
    }
    // signal-cli returns the bytes as base64: `{ data }` (or a bare string on some versions).
    const b64 = typeof result === 'string' ? result : (result as { data?: unknown } | null)?.data;
    if (typeof b64 !== 'string') throw new Error('signal-cli returned no attachment data');
    if (Math.floor((b64.length * 3) / 4) > options.maxBytes + 2) throw new Error(`the file is too large (the limit is ${(options.maxBytes / 1048576).toFixed(1)} MB)`);
    const data = new Uint8Array(Buffer.from(b64, 'base64'));
    if (data.byteLength > options.maxBytes) throw new Error(`the file is too large (the limit is ${(options.maxBytes / 1048576).toFixed(1)} MB)`);
    return { data };
  }

  #classify(e: unknown): ChunkFailure {
    const err = e instanceof SignalApiError ? e : new SignalApiError(0, errorMessage(e), undefined, true);
    let retryable = err.status === 0 || err.status === 429 || err.status >= 500;
    if (err.rpcCode !== undefined) retryable = /network|timed? ?out|connection|unavailable/i.test(err.message);
    if (/unregistered|not registered|invalid (number|recipient|group)|unknown group|not a member/i.test(err.message)) retryable = false;
    return { message: err.message, maybeDelivered: err.maybeDelivered, retryable };
  }

  #target(chatId: string): Record<string, unknown> {
    return chatId.startsWith('group:') ? { groupId: chatId.slice('group:'.length) } : { recipient: [chatId] };
  }

  async #receiveLoop(sink: InboundSink, signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    const wait = (ms: number) => this.#sleep(ms, signal);
    while (!signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      // Aborted by stop() or by the idle watchdog (a half-open connection would otherwise hang forever).
      const conn = new AbortController();
      const onStop = () => conn.abort();
      signal.addEventListener('abort', onStop, { once: true });
      let idle = false;
      try {
        const headers: Record<string, string> = { accept: 'text/event-stream' };
        if (this.#lastEventId !== null) headers['last-event-id'] = this.#lastEventId;
        // `account` selects our account on a multi-account daemon; a single-account daemon ignores it.
        const url = `${this.#base}/api/v1/events?account=${encodeURIComponent(this.account)}`;
        const res = await this.#fetch(url, { headers, signal: conn.signal });
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
        const read = (r: ReadableStreamDefaultReader<Uint8Array>) => {
          const timer = setTimeout(() => {
            idle = true;
            conn.abort();
          }, this.#idleTimeoutMs);
          timer.unref();
          return r.read().finally(() => clearTimeout(timer));
        };
        for (;;) {
          const { done, value } = await read(reader);
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
        this.#lastError = idle ? `events stream was silent for ${this.#idleTimeoutMs} ms; reconnecting` : `events stream failed: ${errorMessage(e)}`;
      } finally {
        signal.removeEventListener('abort', onStop);
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
    // signal-cli's SSE `receive` events carry `{ account, envelope }`; a JSON-RPC
    // notification (`{ method: 'receive', params: { account, envelope } }`) is accepted too.
    const raw = event as { method?: unknown; params?: unknown; envelope?: unknown } | null;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.method !== undefined && raw.method !== 'receive') return null;
    const note = (raw.method === 'receive' ? raw.params : raw) as { envelope?: Envelope; account?: string } | null | undefined;
    if (note?.account !== undefined && note.account !== this.account) return null;
    const env = note?.envelope;
    if (!env) return null;
    const dm = env.dataMessage;
    if (!dm) return null;
    const text = typeof dm.message === 'string' ? dm.message : '';
    const rawAttachments = Array.isArray(dm.attachments) ? dm.attachments.filter((a) => typeof a?.id === 'string') : [];
    const unsupported = !text && rawAttachments.length === 0 && dm.sticker ? ('sticker' as UnsupportedContent) : undefined;
    if (text === '' && rawAttachments.length === 0 && !unsupported) return null;
    const number = env.sourceNumber ?? (env.source && env.source.startsWith('+') ? env.source : undefined) ?? undefined;
    if (number === this.account || env.source === this.account) return null; // never process our own messages
    const senderId = env.sourceUuid ?? number ?? env.source;
    if (!senderId || typeof env.timestamp !== 'number') return null;
    const groupId = env.dataMessage?.groupInfo?.groupId;
    const direct = number ?? env.sourceUuid ?? senderId;
    const attachments: InboundAttachment[] = rawAttachments.map((a) => {
      const mime = typeof a.contentType === 'string' ? a.contentType : undefined;
      const kind: InboundAttachment['kind'] = a.voiceNote || mime?.startsWith('audio/') ? 'audio' : mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : mime === 'application/pdf' || mime?.startsWith('text/') ? 'document' : 'file';
      return {
        kind,
        // getAttachment needs the id plus the sender (or the group) it came from.
        ref: JSON.stringify(groupId ? { id: a.id, groupId } : { id: a.id, recipient: direct }),
        ...(typeof a.filename === 'string' && a.filename ? { name: a.filename } : a.voiceNote ? { name: 'voice.m4a' } : {}),
        ...(mime ? { mimeType: mime } : {}),
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
        ...(a.voiceNote === true ? { liveVoice: true } : {}),
      };
    });
    return {
      channel: this.channel,
      account: this.account,
      chatId: groupId ? `group:${groupId}` : direct,
      externalId: `${senderId}:${env.timestamp}`,
      sender: { id: senderId, ...(env.sourceName ? { displayName: env.sourceName } : {}) },
      text,
      ...(attachments.length ? { attachments } : {}),
      isPrivate: !groupId,
      receivedAt: new Date(env.timestamp).toISOString(),
      ...(unsupported ? { unsupported } : {}),
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

/** A filename safe inside a data URI parameter. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
}
