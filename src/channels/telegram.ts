// Telegram Bot API adapter: long-polling receive with durable offset acks, chunked plain-text send.
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

export type TelegramOptions = {
  token: string;
  account?: string;
  fetch?: typeof fetch;
  pollTimeoutSec?: number;
  apiBase?: string;
  /** Backoff sleep; must resolve early when the signal aborts. Injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const MAX_CHARS = 4096;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const CONFLICT_BACKOFF_MS = 5000;
const REQUEST_TIMEOUT_MS = 30_000;

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgMessage = { message_id: number; date: number; text?: string; from?: TgUser; chat: { id: number; type: string } };
type TgUpdate = { update_id: number; message?: TgMessage };

/** A Bot API call that did not produce `ok: true`. `status` is 0 for network failures. */
class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  constructor(status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

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

export class TelegramChannel implements ChannelAdapter {
  readonly channel = 'telegram';
  readonly account: string;
  readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_CHARS, dedupesSends: false, typingIndicator: true };

  #token: string;
  #fetch: typeof fetch;
  #base: string;
  #pollTimeoutSec: number;
  #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #offset = 0;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #lastSuccessAt: number | null = null;
  #lastError: string | null = null;
  #fatal = false;

  constructor(options: TelegramOptions) {
    if (typeof options.token !== 'string' || !TOKEN_SHAPE.test(options.token)) {
      throw new RubyError('config', 'Telegram bot token is missing or malformed (expected "<digits>:<secret>" from @BotFather)');
    }
    this.#token = options.token;
    this.account = options.account ?? 'default';
    this.#fetch = options.fetch ?? fetch;
    this.#base = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.#pollTimeoutSec = options.pollTimeoutSec ?? 30;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async start(sink: InboundSink): Promise<void> {
    if (this.#loop) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.#fatal = false;
    try {
      await this.#call('getMe', {}, AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    } catch (e) {
      this.#controller = null;
      if (e instanceof TelegramApiError && (e.status === 401 || e.status === 404)) {
        throw new RubyError('config', 'Telegram rejected the bot token');
      }
      throw new RubyError('provider_transient', `Telegram getMe failed: ${errorMessage(e)}`);
    }
    this.#lastSuccessAt = Date.now();
    this.#lastError = null;
    // A leftover webhook would make getUpdates fail with 409.
    try {
      await this.#call('deleteWebhook', { drop_pending_updates: false }, AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    } catch (e) {
      this.#lastError = `deleteWebhook failed: ${errorMessage(e)}`;
    }
    this.#loop = this.#poll(sink, controller.signal).finally(() => {
      this.#loop = null;
    });
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    const loop = this.#loop;
    this.#controller = null;
    if (loop) await loop;
  }

  health(): ChannelHealth {
    const windowMs = (2 * this.#pollTimeoutSec + 30) * 1000;
    const fresh = this.#lastSuccessAt !== null && Date.now() - this.#lastSuccessAt <= windowMs;
    return {
      ok: fresh && !this.#fatal,
      lastSuccessAt: this.#lastSuccessAt === null ? null : new Date(this.#lastSuccessAt).toISOString(),
      lastError: this.#lastError,
    };
  }

  async typing(chatId: string): Promise<void> {
    try {
      await this.#call('sendChatAction', { chat_id: chatId, action: 'typing' }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch {
      // A missing typing hint is harmless.
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const chunks = splitText(message.text, MAX_CHARS);
    if (chunks.length === 0) return { status: 'failed', retryable: false, error: 'Cannot send an empty message' };
    const externalIds: string[] = [];
    for (const [i, text] of chunks.entries()) {
      const body: Record<string, unknown> = { chat_id: message.chatId, text };
      const replyTo = Number(message.replyToExternalId);
      if (i === 0 && message.replyToExternalId !== undefined && Number.isInteger(replyTo)) {
        body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      }
      try {
        const sent = (await this.#call('sendMessage', body, AbortSignal.timeout(REQUEST_TIMEOUT_MS))) as { message_id: number };
        externalIds.push(String(sent.message_id));
        this.#lastSuccessAt = Date.now();
      } catch (e) {
        const err = e instanceof TelegramApiError ? e : new TelegramApiError(0, errorMessage(e));
        const partial = externalIds.length ? ` (after sending ${externalIds.length} of ${chunks.length} chunks)` : '';
        const retryable = err.status === 0 || err.status === 429 || err.status >= 500;
        return {
          status: 'failed',
          retryable,
          error: `${err.message}${partial}`,
          ...(err.status === 429 && err.retryAfterSec !== undefined ? { retryAfterMs: err.retryAfterSec * 1000 } : {}),
        };
      }
    }
    return { status: 'sent', externalIds };
  }

  async #poll(sink: InboundSink, signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    const wait = (ms: number) => this.#sleep(ms, signal);
    while (!signal.aborted) {
      let updates: TgUpdate[];
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout((this.#pollTimeoutSec + 15) * 1000)]);
        updates = (await this.#call(
          'getUpdates',
          { offset: this.#offset, timeout: this.#pollTimeoutSec, allowed_updates: ['message'] },
          requestSignal,
        )) as TgUpdate[];
      } catch (e) {
        if (signal.aborted) break;
        const err = e instanceof TelegramApiError ? e : new TelegramApiError(0, errorMessage(e));
        if (err.status === 401 || err.status === 404) {
          this.#fatal = true;
          this.#lastError = 'Telegram rejected the bot token';
          break;
        }
        let delay = backoff;
        if (err.status === 409) {
          this.#lastError = 'Telegram conflict (409): another process or webhook is receiving updates for this bot token';
          delay = CONFLICT_BACKOFF_MS;
        } else {
          this.#lastError = `getUpdates failed: ${err.message}`;
          if (err.status === 429 && err.retryAfterSec !== undefined) delay = err.retryAfterSec * 1000;
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await wait(delay);
        continue;
      }
      this.#lastSuccessAt = Date.now();
      this.#lastError = null;
      backoff = MIN_BACKOFF_MS;
      for (const update of updates) {
        const inbound = this.#toInbound(update);
        if (inbound) {
          try {
            await sink(inbound);
          } catch (e) {
            // Leave the offset alone: this update is redelivered on the next poll.
            this.#lastError = `inbound sink failed: ${errorMessage(e)}`;
            await wait(backoff);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            break;
          }
        }
        this.#offset = update.update_id + 1;
      }
    }
  }

  #toInbound(update: TgUpdate): InboundMessage | null {
    const m = update.message;
    if (!m || typeof m.text !== 'string' || !m.from) return null;
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username;
    return {
      channel: this.channel,
      account: this.account,
      chatId: String(m.chat.id),
      externalId: String(m.message_id),
      sender: { id: String(m.from.id), ...(name ? { displayName: name } : {}) },
      text: m.text,
      isPrivate: m.chat.type === 'private',
      receivedAt: new Date(m.date * 1000).toISOString(),
    };
  }

  #redact(text: string): string {
    return text.split(this.#token).join('<token>');
  }

  async #call(method: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new TelegramApiError(0, `Telegram ${method} request failed: ${this.#redact(errorMessage(e))}`);
    }
    let payload: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // Non-JSON body (proxy error page): fall through to the status check.
    }
    if (res.ok && payload.ok) return payload.result;
    const description = this.#redact(payload.description ?? res.statusText ?? '');
    throw new TelegramApiError(res.status, `Telegram ${method} failed with ${res.status}${description ? `: ${description}` : ''}`, payload.parameters?.retry_after);
  }
}
