// Discord adapter: bot gateway (WebSocket, JSON, no compression) for receive, REST for send.
//
// The bot needs the privileged "Message Content Intent" enabled in the Discord Developer Portal
// (Application > Bot > Privileged Gateway Intents). Without it Discord closes the gateway with
// 4014 and message text arrives empty; this adapter reports that as a fatal `lastError`.
import { createHash } from 'node:crypto';
import {
  RubyError,
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
import { AMBIGUOUS_STATUSES, abortableSleep, fileBlob, mayHaveReachedServer, readCapped, sendChunks, sendUnits, type ChunkFailure } from './delivery.ts';
import { splitMarkdown } from './markdown.ts';

export type DiscordOptions = {
  token: string;
  account?: string;
  /** REST base URL. Default "https://discord.com/api/v10". */
  apiBase?: string;
  fetch?: typeof fetch;
  /** WebSocket constructor. Defaults to the global (Node 22). Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  /** Backoff/heartbeat sleep; must resolve early when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

// Three dot-separated base64url-ish parts: base64(user id) . timestamp . hmac.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const MAX_CHARS = 2000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SINK_ATTEMPTS = 4;
const USER_AGENT = 'DiscordBot (https://github.com/ruby-agent, 0.1.0)';

/** GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15, privileged). */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

// Gateway close codes after which reconnecting cannot help.
const FATAL_CLOSE: Record<number, string> = {
  4004: 'Discord rejected the bot token (gateway close 4004: authentication failed)',
  4010: 'Discord gateway close 4010: invalid shard',
  4011: 'Discord gateway close 4011: sharding required',
  4012: 'Discord gateway close 4012: invalid API version',
  4013: 'Discord gateway close 4013: invalid intents',
  4014: 'Discord refused the requested intents (gateway close 4014): enable "Message Content Intent" for this bot in the Discord Developer Portal (Bot > Privileged Gateway Intents)',
};
// Close codes after which the session cannot be resumed (re-IDENTIFY instead).
const NO_RESUME_CLOSE = new Set([4007, 4009]);

type Payload = { op: number; d?: any; s?: number | null; t?: string | null };
type Outcome = { kind: 'retry'; delayMs?: number } | { kind: 'fatal' } | { kind: 'stop' };

type DiscordMessage = {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  timestamp?: string;
  webhook_id?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean };
  attachments?: { id?: string; filename?: string; content_type?: string; size?: number; url?: string; duration_secs?: number }[];
  sticker_items?: unknown[];
};

/** Bots without a boosted server can upload 10 MiB per file. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Attachment downloads only ever go to Discord's CDN, whatever URL a payload carries. */
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** A REST call that failed. `status` is 0 for network failures. */
class DiscordApiError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  /** The request may have been carried out (timeout, reset, unreadable success response). */
  readonly maybeDelivered: boolean;
  constructor(status: number, message: string, retryAfterSec?: number, maybeDelivered = false) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.maybeDelivered = maybeDelivered;
  }
}

export class DiscordChannel implements ChannelAdapter {
  readonly channel = 'discord';
  readonly account: string;
  // dedupesSends stays false: Discord documents `nonce` (<= 25 chars) + `enforce_nonce` as a uniqueness check
  // over "recent minutes" only (developers/resources/message), so it is best effort, not a durable guarantee.
  readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_CHARS, dedupesSends: false, typingIndicator: true, maxUploadBytes: MAX_UPLOAD_BYTES };

  #token: string;
  #fetch: typeof fetch;
  #WS: typeof WebSocket;
  #base: string;
  #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #lastSuccessAt: number | null = null;
  #lastError: string | null = null;
  #fatal = false;
  // Gateway session state, kept across reconnects so we can RESUME.
  #botId: string | null = null;
  #sessionId: string | null = null;
  #resumeUrl: string | null = null;
  #seq: number | null = null;
  #gatewayUrl = '';
  // Per-connection health.
  #ready = false;
  #heartbeatMs = 0;
  #lastAckAt = 0;

  constructor(options: DiscordOptions) {
    if (typeof options.token !== 'string' || !TOKEN_SHAPE.test(options.token)) {
      throw new RubyError('config', 'Discord bot token is missing or malformed (expected three dot-separated parts from the Developer Portal)');
    }
    this.#token = options.token;
    this.account = options.account ?? 'default';
    this.#base = (options.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#WS = options.WebSocketImpl ?? WebSocket;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  async start(sink: InboundSink): Promise<void> {
    if (this.#loop) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#fatal = false;
    const timeout = () => AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
      const me = (await this.#api('GET', '/users/@me', undefined, timeout())) as { id?: string } | null;
      this.#botId = typeof me?.id === 'string' ? me.id : null;
      const gw = (await this.#api('GET', '/gateway/bot', undefined, timeout())) as { url?: string } | null;
      const url = new URL(String(gw?.url));
      if (url.protocol !== 'wss:') throw new Error('gateway URL is not wss');
      this.#gatewayUrl = gw!.url!;
    } catch (e) {
      this.#controller = null;
      if (e instanceof DiscordApiError && e.status === 401) throw new RubyError('config', 'Discord rejected the bot token');
      throw new RubyError('provider_transient', `Discord startup failed: ${this.#redact(errorMessage(e))}`);
    }
    this.#lastSuccessAt = Date.now();
    this.#lastError = null;
    this.#sessionId = null;
    this.#seq = null;
    this.#loop = this.#gatewayLoop(sink, controller.signal).finally(() => {
      this.#loop = null;
      this.#ready = false;
    });
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    const loop = this.#loop;
    this.#controller = null;
    if (loop) await loop;
  }

  health(): ChannelHealth {
    const ackWindow = this.#heartbeatMs * 2 + 10_000;
    const fresh = this.#ready && Date.now() - this.#lastAckAt <= ackWindow;
    return {
      ok: fresh && !this.#fatal,
      lastSuccessAt: this.#lastSuccessAt === null ? null : new Date(this.#lastSuccessAt).toISOString(),
      lastError: this.#lastError,
    };
  }

  async typing(chatId: string): Promise<void> {
    if (!/^\d+$/.test(chatId)) return;
    try {
      await this.#api('POST', `/channels/${chatId}/typing`, undefined, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch {
      // A missing typing hint is harmless.
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!/^\d+$/.test(message.chatId)) return { status: 'failed', retryable: false, error: 'Invalid Discord channel id' };
    const replyTo = message.replyToExternalId !== undefined && /^\d+$/.test(message.replyToExternalId) ? message.replyToExternalId : undefined;
    return sendChunks(
      sendUnits(message, MAX_CHARS, MAX_CHARS, splitMarkdown), // Discord renders markdown itself; keep code blocks whole per chunk
      async (unit, i) => {
        const body: Record<string, unknown> = {
          content: unit.kind === 'text' ? unit.text : (unit.caption ?? ''),
          // Never let model output ping @everyone, roles or users.
          allowed_mentions: { parse: [] },
          nonce: createHash('sha256').update(`${message.deliveryId}:${i}`).digest('base64url').slice(0, 25),
          enforce_nonce: true,
        };
        if (i === 0 && replyTo) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
        let payload: Record<string, unknown> | FormData = body;
        if (unit.kind === 'file') {
          if (unit.file.size > MAX_UPLOAD_BYTES) throw new DiscordApiError(413, `Discord bots can upload files up to 10 MB; ${unit.file.name} is larger`);
          // Multipart: the JSON goes in payload_json and refers to files[0] by its index.
          body.attachments = [{ id: 0, filename: unit.file.name }];
          const form = new FormData();
          form.append('payload_json', JSON.stringify(body));
          form.append('files[0]', await fileBlob(unit.file.path, unit.file.mimeType), unit.file.name);
          payload = form;
        }
        const timeout = AbortSignal.timeout(unit.kind === 'file' ? REQUEST_TIMEOUT_MS * 4 : REQUEST_TIMEOUT_MS);
        const sent = (await this.#api('POST', `/channels/${message.chatId}/messages`, payload, timeout)) as { id?: string } | null;
        if (typeof sent?.id !== 'string') throw new DiscordApiError(502, 'Discord returned no message id', undefined, true);
        this.#lastSuccessAt = Date.now();
        return sent.id;
      },
      (e) => this.#classify(e),
      (ms) => this.#sleep(ms, new AbortController().signal),
    );
  }

  async fetchAttachment(ref: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ data: Uint8Array; mimeType?: string }> {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      throw new Error('not a Discord attachment URL');
    }
    if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname)) throw new Error('not a Discord CDN URL');
    let res: Response;
    try {
      // No redirects: the host check above must hold for the URL actually fetched.
      res = await this.#fetch(url, { signal: AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4)]), headers: { 'user-agent': USER_AGENT }, redirect: 'error' });
    } catch (e) {
      throw new Error(`download failed: ${this.#redact(errorMessage(e))}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`download failed with HTTP ${res.status}${res.status === 403 || res.status === 404 ? ' (the link may have expired)' : ''}`);
    }
    return { data: await readCapped(res, options.maxBytes, 'The file') };
  }

  #classify(e: unknown): ChunkFailure {
    const err = e instanceof DiscordApiError ? e : new DiscordApiError(0, this.#redact(errorMessage(e)), undefined, true);
    return {
      message: err.message,
      maybeDelivered: err.maybeDelivered,
      retryable: err.status === 0 || err.status === 429 || err.status >= 500,
      retryAfterMs: err.status === 429 && err.retryAfterSec !== undefined ? Math.ceil(err.retryAfterSec * 1000) : undefined,
    };
  }

  async #gatewayLoop(sink: InboundSink, signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!signal.aborted) {
      const base = this.#sessionId && this.#resumeUrl ? this.#resumeUrl : this.#gatewayUrl;
      const url = new URL(base);
      url.searchParams.set('v', '10');
      url.searchParams.set('encoding', 'json');
      this.#ready = false;
      const startedAt = Date.now();
      this.#lastAckAt = 0;
      const outcome = await this.#connection(url.toString(), sink, signal);
      this.#ready = false;
      if (outcome.kind !== 'retry' || signal.aborted) break;
      if (this.#lastAckAt >= startedAt) backoff = MIN_BACKOFF_MS; // the connection got READY/RESUMED
      const delay = outcome.delayMs ?? backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      await this.#sleep(delay, signal);
    }
  }

  /** Runs one WebSocket connection to its end and says what the loop should do next. */
  #connection(url: string, sink: InboundSink, signal: AbortSignal): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new this.#WS(url);
      } catch (e) {
        this.#lastError = `gateway connect failed: ${this.#redact(errorMessage(e))}`;
        return resolve({ kind: 'retry' });
      }
      const conn = new AbortController();
      let done = false;
      let acked = true;
      let sentResume = false;
      let confirmed = false; // READY or RESUMED seen
      let chain: Promise<void> = Promise.resolve();
      let beat: Promise<void> = Promise.resolve();

      const send = (p: Payload) => {
        try {
          ws.send(JSON.stringify(p));
        } catch {
          // The close event will follow.
        }
      };
      const finish = (outcome: Outcome, closeCode?: number) => {
        if (done) return;
        done = true;
        conn.abort();
        signal.removeEventListener('abort', onAbort);
        if (closeCode !== undefined) {
          try {
            ws.close(closeCode);
          } catch {
            // Already closed.
          }
        }
        void Promise.all([chain, beat]).then(() => resolve(outcome));
      };
      const onAbort = () => finish({ kind: 'stop' }, 1000);
      signal.addEventListener('abort', onAbort, { once: true });

      const heartbeats = async (interval: number) => {
        await this.#sleep(Math.floor(interval * Math.random()), conn.signal);
        while (!conn.signal.aborted) {
          if (!acked) {
            this.#lastError = 'gateway heartbeat was not acknowledged; reconnecting';
            finish({ kind: 'retry' }, 4000);
            return;
          }
          acked = false;
          send({ op: 1, d: this.#seq });
          await this.#sleep(interval, conn.signal);
        }
      };

      const dispatch = async (t: string, d: any) => {
        if (t === 'READY') {
          this.#sessionId = typeof d?.session_id === 'string' ? d.session_id : null;
          this.#resumeUrl = typeof d?.resume_gateway_url === 'string' ? d.resume_gateway_url : null;
          if (typeof d?.user?.id === 'string') this.#botId = d.user.id;
          this.#markReady();
          confirmed = true;
        } else if (t === 'RESUMED') {
          this.#markReady();
          confirmed = true;
        } else if (t === 'MESSAGE_CREATE') {
          const inbound = this.#toInbound(d as DiscordMessage);
          if (inbound) await this.#deliver(inbound, sink, signal);
        }
      };

      const onPayload = (p: Payload) => {
        if (typeof p.s === 'number') this.#seq = p.s;
        switch (p.op) {
          case 10: {
            const interval = Number(p.d?.heartbeat_interval);
            if (!Number.isFinite(interval) || interval <= 0) return finish({ kind: 'retry' }, 4000);
            this.#heartbeatMs = interval;
            beat = heartbeats(interval);
            if (this.#sessionId && this.#seq !== null) {
              sentResume = true;
              send({ op: 6, d: { token: this.#token, session_id: this.#sessionId, seq: this.#seq } });
            } else {
              send({
                op: 2,
                d: { token: this.#token, intents: DISCORD_INTENTS, properties: { os: 'linux', browser: 'ruby', device: 'ruby' } },
              });
            }
            return;
          }
          case 11:
            acked = true;
            this.#lastAckAt = Date.now();
            this.#lastSuccessAt = this.#lastAckAt;
            return;
          case 1: // server asks for an immediate heartbeat
            send({ op: 1, d: this.#seq });
            return;
          case 7: // RECONNECT: resume on a new connection
            return finish({ kind: 'retry', delayMs: 0 }, 4000);
          case 9: {
            // INVALID_SESSION: d=true means resumable, but a rejected RESUME must not be retried forever.
            if (p.d !== true || (sentResume && !confirmed)) {
              this.#sessionId = null;
              this.#seq = null;
            }
            return finish({ kind: 'retry', delayMs: 1000 + Math.floor(Math.random() * 4000) }, 4000);
          }
          case 0:
            if (typeof p.t === 'string') {
              const t = p.t;
              chain = chain.then(() => dispatch(t, p.d)).catch((e) => {
                this.#lastError = `gateway event handling failed: ${this.#redact(errorMessage(e))}`;
              });
            }
            return;
          default:
            return;
        }
      };

      ws.addEventListener('message', (ev: MessageEvent) => {
        if (done) return;
        try {
          onPayload(JSON.parse(String(ev.data)) as Payload);
        } catch {
          this.#lastError = 'ignored malformed gateway payload';
        }
      });
      ws.addEventListener('error', () => {
        if (!done) this.#lastError = 'gateway socket error';
      });
      ws.addEventListener('close', (ev: { code: number }) => {
        if (done) return;
        const code = ev.code;
        const fatal = FATAL_CLOSE[code];
        if (fatal) {
          this.#fatal = true;
          this.#lastError = fatal;
          return finish({ kind: 'fatal' });
        }
        if (NO_RESUME_CLOSE.has(code)) {
          this.#sessionId = null;
          this.#seq = null;
        }
        this.#lastError = `gateway closed (code ${code}); reconnecting`;
        finish({ kind: 'retry' });
      });
    });
  }

  #markReady(): void {
    this.#ready = true;
    this.#lastAckAt = Date.now();
    this.#lastSuccessAt = this.#lastAckAt;
    this.#lastError = null;
  }

  /** At-most-once: the gateway has no offsets, so a failing sink is retried a few times, then the message is dropped. */
  async #deliver(inbound: InboundMessage, sink: InboundSink, signal: AbortSignal): Promise<void> {
    let delay = MIN_BACKOFF_MS;
    for (let attempt = 1; attempt <= SINK_ATTEMPTS; attempt++) {
      try {
        await sink(inbound);
        return;
      } catch (e) {
        this.#lastError = `inbound sink failed (attempt ${attempt} of ${SINK_ATTEMPTS})${attempt === SINK_ATTEMPTS ? '; message dropped' : ''}: ${this.#redact(errorMessage(e))}`;
        if (attempt === SINK_ATTEMPTS || signal.aborted) return;
        await this.#sleep(delay, signal);
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
  }

  #toInbound(m: DiscordMessage): InboundMessage | null {
    const author = m?.author;
    if (!author || typeof author.id !== 'string' || typeof m.id !== 'string' || typeof m.channel_id !== 'string') return null;
    if (author.bot || m.webhook_id || author.id === this.#botId) return null;
    const text = typeof m.content === 'string' ? m.content : '';
    const attachments: InboundAttachment[] = (Array.isArray(m.attachments) ? m.attachments : []).flatMap((a) => {
      if (typeof a?.url !== 'string') return [];
      const mime = typeof a.content_type === 'string' ? a.content_type.split(';')[0]!.trim() : undefined;
      const kind: InboundAttachment['kind'] = !mime ? 'file' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : mime === 'application/pdf' || mime.startsWith('text/') ? 'document' : 'file';
      return [
        {
          kind,
          ref: a.url,
          ...(typeof a.filename === 'string' ? { name: a.filename } : {}),
          ...(mime ? { mimeType: mime } : {}),
          ...(typeof a.size === 'number' ? { size: a.size } : {}),
          ...(typeof a.duration_secs === 'number' ? { durationSec: a.duration_secs } : {}),
        },
      ];
    });
    const unsupported: UnsupportedContent | undefined = !text && attachments.length === 0 && Array.isArray(m.sticker_items) && m.sticker_items.length ? 'sticker' : undefined;
    if (text === '' && attachments.length === 0 && !unsupported) return null;
    const name = author.global_name ?? author.username;
    const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
    return {
      channel: this.channel,
      account: this.account,
      chatId: m.channel_id,
      externalId: m.id,
      sender: { id: author.id, ...(name ? { displayName: name } : {}) },
      text,
      ...(attachments.length ? { attachments } : {}),
      isPrivate: m.guild_id === undefined || m.guild_id === null,
      receivedAt: new Date(Number.isNaN(ts) ? Date.now() : ts).toISOString(),
      ...(unsupported ? { unsupported } : {}),
    };
  }

  #redact(text: string): string {
    return text.split(this.#token).join('<token>');
  }

  async #api(method: string, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const label = `${method} ${path.replace(/\/\d+/g, '/:id')}`;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.#token}`,
          'user-agent': USER_AGENT,
          // FormData sets its own multipart content type with the boundary.
          ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
        signal,
      });
    } catch (e) {
      throw new DiscordApiError(0, `Discord ${label} request failed: ${this.#redact(errorMessage(e))}`, undefined, mayHaveReachedServer(e));
    }
    let payload: { message?: string; retry_after?: number } & Record<string, unknown> = {};
    try {
      const text = await res.text();
      if (text !== '') payload = JSON.parse(text);
    } catch {
      // Empty or non-JSON body (204, proxy error page): fall through to the status check.
    }
    if (res.ok) return payload;
    let retryAfter = typeof payload.retry_after === 'number' ? payload.retry_after : undefined;
    if (retryAfter === undefined && res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      if (Number.isFinite(header) && header >= 0) retryAfter = header;
    }
    const description = this.#redact(typeof payload.message === 'string' ? payload.message : (res.statusText ?? ''));
    throw new DiscordApiError(res.status, `Discord ${label} failed with ${res.status}${description ? `: ${description}` : ''}`, retryAfter, AMBIGUOUS_STATUSES.has(res.status));
  }
}
