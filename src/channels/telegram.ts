// Telegram Bot API adapter: long-polling receive with durable offset acks, chunked send (markdown as Telegram HTML, plain-text fallback).
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
import { AMBIGUOUS_STATUSES, abortableSleep, fileBlob, mayHaveReachedServer, readCapped, sendChunks, sendUnits, type ChunkFailure, type SendUnit } from './delivery.ts';
import { markdownToPlain, markdownToTelegramHtml, splitMarkdown } from './markdown.ts';

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
type TgFile = { file_id: string; file_size?: number; mime_type?: string; file_name?: string; duration?: number };
type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TgUser;
  chat: { id: number; type: string };
  photo?: (TgFile & { width: number; height: number })[];
  document?: TgFile;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  sticker?: unknown;
  location?: unknown;
  venue?: unknown;
  contact?: unknown;
  poll?: unknown;
  dice?: unknown;
};

/** Bot API limits: bots download files up to 20 MB, upload photos up to 10 MB and other files up to 50 MB; captions hold 1024 characters. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CAPTION = 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
type TgUpdate = { update_id: number; message?: TgMessage };

/** A Bot API call that did not produce `ok: true`. `status` is 0 for network failures. */
class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfterSec: number | undefined;
  /** The request may have been carried out (timeout, reset, unreadable success response). */
  readonly maybeDelivered: boolean;
  constructor(status: number, message: string, retryAfterSec?: number, maybeDelivered = false) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.maybeDelivered = maybeDelivered;
  }
}

export class TelegramChannel implements ChannelAdapter {
  readonly channel = 'telegram';
  readonly account: string;
  readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_CHARS, dedupesSends: false, typingIndicator: true, maxUploadBytes: MAX_UPLOAD_BYTES };

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
      throw new GarnetError('config', 'Telegram bot token is missing or malformed (expected "<digits>:<secret>" from @BotFather)');
    }
    this.#token = options.token;
    this.account = options.account ?? 'default';
    this.#fetch = options.fetch ?? fetch;
    this.#base = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.#pollTimeoutSec = options.pollTimeoutSec ?? 30;
    this.#sleep = options.sleep ?? abortableSleep;
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
        throw new GarnetError('config', 'Telegram rejected the bot token');
      }
      throw new GarnetError('provider_transient', `Telegram getMe failed: ${errorMessage(e)}`);
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
    const replyTo = Number(message.replyToExternalId);
    const replyParameters = message.replyToExternalId !== undefined && Number.isInteger(replyTo) ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;
    return sendChunks(
      sendUnits(message, MAX_CHARS, MAX_CAPTION, splitMarkdown),
      async (unit, i) => {
        const sent = (await this.#sendUnit(message.chatId, unit, i === 0 ? replyParameters : undefined)) as { message_id: number };
        this.#lastSuccessAt = Date.now();
        return String(sent.message_id);
      },
      (e) => this.#classify(e),
      (ms) => this.#sleep(ms, new AbortController().signal),
    );
  }

  async #sendUnit(chatId: string, unit: SendUnit, replyParameters: Record<string, unknown> | undefined): Promise<unknown> {
    if (unit.kind === 'text') {
      const base: Record<string, unknown> = { chat_id: chatId };
      if (replyParameters) base.reply_parameters = replyParameters;
      // Replies are markdown; Telegram renders its HTML subset. A rejected entity is a definite 400 (nothing was sent): resend as plain text.
      return this.#withPlainFallback(
        () => this.#call('sendMessage', { ...base, text: markdownToTelegramHtml(unit.text), parse_mode: 'HTML' }, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
        () => this.#call('sendMessage', { ...base, text: markdownToPlain(unit.text) }, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      );
    }
    const f = unit.file;
    if (f.size > MAX_UPLOAD_BYTES) throw new TelegramApiError(413, `Telegram bots can send files up to 50 MB; ${f.name} is larger`);
    // Photos are recompressed and shown inline; voice notes play inline; everything else goes as a document.
    const [method, field] =
      f.kind === 'image' && PHOTO_TYPES.has(f.mimeType) && f.size <= MAX_PHOTO_BYTES
        ? ['sendPhoto', 'photo']
        : f.mimeType === 'audio/ogg'
          ? ['sendVoice', 'voice']
          : f.mimeType === 'audio/mpeg' || f.mimeType === 'audio/mp4'
            ? ['sendAudio', 'audio']
            : ['sendDocument', 'document'];
    const upload = async (caption: { text: string; html: boolean } | null) => {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append(field, await fileBlob(f.path, f.mimeType), f.name);
      if (caption) form.append('caption', caption.text);
      if (caption?.html) form.append('parse_mode', 'HTML');
      if (replyParameters) form.append('reply_parameters', JSON.stringify(replyParameters));
      // Uploads take longer than a text message; still bounded so the gateway never waits forever.
      return this.#call(method, form, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4));
    };
    const caption = unit.caption;
    if (!caption) return upload(null);
    return this.#withPlainFallback(
      () => upload({ text: markdownToTelegramHtml(caption), html: true }),
      () => upload({ text: markdownToPlain(caption), html: false }),
    );
  }

  /** Runs `html`; if Telegram rejects its entities (a 400, so nothing was sent), runs `plain` instead. */
  async #withPlainFallback(html: () => Promise<unknown>, plain: () => Promise<unknown>): Promise<unknown> {
    try {
      return await html();
    } catch (e) {
      if (!(e instanceof TelegramApiError && e.status === 400 && /parse entities|start tag|end tag|entity/i.test(e.message))) throw e;
      return plain();
    }
  }

  async fetchAttachment(ref: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ data: Uint8Array; mimeType?: string }> {
    const max = Math.min(options.maxBytes, MAX_DOWNLOAD_BYTES);
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4)]);
    let file: { file_path?: string; file_size?: number };
    try {
      file = (await this.#call('getFile', { file_id: ref }, signal)) as typeof file;
    } catch (e) {
      // getFile refuses files over the bot download limit.
      if (e instanceof TelegramApiError && e.status === 400 && /too big/i.test(e.message)) throw new Error('the file is larger than the 20 MB Telegram lets bots download');
      throw new Error(this.#redact(errorMessage(e)));
    }
    if (typeof file.file_size === 'number' && file.file_size > max) {
      throw new Error(`the file is too large (${(file.file_size / 1048576).toFixed(1)} MB; the limit is ${(max / 1048576).toFixed(1)} MB)`);
    }
    if (!file.file_path) throw new Error('Telegram did not provide a download path for the file');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/file/bot${this.#token}/${file.file_path.split('/').map(encodeURIComponent).join('/')}`, { signal });
    } catch (e) {
      throw new Error(`download failed: ${this.#redact(errorMessage(e))}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`download failed with HTTP ${res.status}`);
    }
    try {
      return { data: await readCapped(res, max, 'The file') };
    } catch (e) {
      throw new Error(this.#redact(errorMessage(e)));
    }
  }

  #classify(e: unknown): ChunkFailure {
    const err = e instanceof TelegramApiError ? e : new TelegramApiError(0, this.#redact(errorMessage(e)), undefined, true);
    return {
      message: err.message,
      maybeDelivered: err.maybeDelivered,
      retryable: err.status === 0 || err.status === 429 || err.status >= 500,
      retryAfterMs: err.status === 429 && err.retryAfterSec !== undefined ? err.retryAfterSec * 1000 : undefined,
    };
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
    if (!m || !m.from) return null;
    const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
    const attachments = this.#attachments(m);
    // Files are attachments; only content with nothing to download (stickers, locations, polls) is unsupported.
    const unsupported = attachments.length ? undefined : unsupportedOf(m);
    if (text === '' && attachments.length === 0 && !unsupported) return null; // service messages (joins, pins...)
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username;
    return {
      channel: this.channel,
      account: this.account,
      chatId: String(m.chat.id),
      externalId: String(m.message_id),
      sender: { id: String(m.from.id), ...(name ? { displayName: name } : {}) },
      text,
      ...(attachments.length ? { attachments } : {}),
      isPrivate: m.chat.type === 'private',
      receivedAt: new Date(m.date * 1000).toISOString(),
      ...(unsupported ? { unsupported } : {}),
    };
  }

  #attachments(m: TgMessage): InboundAttachment[] {
    const out: InboundAttachment[] = [];
    const add = (f: TgFile | undefined, kind: InboundAttachment['kind'], fallbackName: string, mimeType?: string) => {
      if (!f || typeof f.file_id !== 'string') return;
      const mime = f.mime_type ?? mimeType;
      out.push({
        kind,
        ref: f.file_id,
        name: f.file_name ?? fallbackName,
        ...(mime ? { mimeType: mime } : {}),
        ...(typeof f.file_size === 'number' ? { size: f.file_size } : {}),
        ...(typeof f.duration === 'number' ? { durationSec: f.duration } : {}),
      });
    };
    // Photo sizes come smallest first; the largest is the original resolution (Telegram's own JPEG).
    if (Array.isArray(m.photo) && m.photo.length) add(m.photo.at(-1), 'image', 'photo.jpg', 'image/jpeg');
    if (m.document) add(m.document, kindOfClaim(m.document.mime_type), 'document');
    add(m.voice, 'audio', 'voice.ogg', 'audio/ogg');
    // Only a voice note recorded in this message counts as live; a forwarded one was made by someone else.
    const forwarded = m.forward_origin !== undefined || m.forward_from !== undefined || m.forward_from_chat !== undefined || m.forward_sender_name !== undefined || m.forward_date !== undefined;
    const voice = out.find((a) => a.ref === m.voice?.file_id);
    if (voice && !forwarded) voice.liveVoice = true;
    add(m.audio, 'audio', 'audio');
    add(m.video ?? m.video_note ?? m.animation, 'video', 'video.mp4', 'video/mp4');
    return out;
  }

  #redact(text: string): string {
    return text.split(this.#token).join('<token>');
  }

  async #call(method: string, body: Record<string, unknown> | FormData, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      // FormData sets its own multipart content type with the boundary.
      res = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData ? { body } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
      });
    } catch (e) {
      throw new TelegramApiError(0, `Telegram ${method} request failed: ${this.#redact(errorMessage(e))}`, undefined, mayHaveReachedServer(e));
    }
    let payload: { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // Non-JSON body (proxy error page): fall through to the status check.
    }
    if (res.ok && payload.ok) return payload.result;
    const description = this.#redact(payload.description ?? res.statusText ?? '');
    // A success status with an unreadable body, or a gateway error, may hide a request that was carried out.
    const maybeDelivered = res.ok || AMBIGUOUS_STATUSES.has(res.status);
    throw new TelegramApiError(res.status, `Telegram ${method} failed with ${res.status}${description ? `: ${description}` : ''}`, payload.parameters?.retry_after, maybeDelivered);
  }
}

function kindOfClaim(mime: string | undefined): InboundAttachment['kind'] {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
  return 'file';
}

/** Message types with no file or text Garnet could read. */
function unsupportedOf(m: TgMessage): UnsupportedContent | undefined {
  if (m.sticker) return 'sticker';
  if (m.location || m.venue || m.contact || m.poll || m.dice) return 'other';
  return undefined;
}
