// Helpers shared by the channel adapters: send-outcome classification, chunked sends, text splitting.
import { readFile } from 'node:fs/promises';
import type { OutboundAttachment, SendResult } from '../contracts/index.ts';

/**
 * Error codes that mean the request never left this machine or never reached
 * the server (name resolution, connection refused or unreachable, TLS
 * verification). Anything else (a timeout, a reset or closed socket, an
 * unknown error) may have happened after the server received the request.
 */
const NOT_SENT = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_INVALID_ARG',
  'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Whether a failed `fetch` may still have delivered the request. Conservative:
 * only errors that certainly happened before the server saw the request
 * return false, so a send is never retried when it might duplicate a message.
 */
export function mayHaveReachedServer(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; cur = (cur as { cause?: unknown }).cause, depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT.has(code)) return false;
  }
  return true;
}

/**
 * HTTP statuses after which the request may still have been carried out: a
 * proxy or gateway in front of the platform lost track of the upstream.
 */
export const AMBIGUOUS_STATUSES = new Set([502, 504]);

/** Sleeps for `ms`, resolving early (never rejecting) when `signal` aborts. */
export const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
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

/**
 * Splits text into chunks of at most `max` UTF-16 units, preferring paragraph,
 * then line, then word boundaries, and never splitting a surrogate pair.
 * Whitespace at a cut is dropped; empty chunks are omitted.
 */
export function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) {
      // A word boundary only if it keeps the chunk reasonably full; otherwise a hard cut.
      const space = window.lastIndexOf(' ');
      cut = space > max / 2 ? space : -1;
    }
    if (cut <= 0) {
      cut = max;
      const last = window.charCodeAt(max - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // do not split a surrogate pair
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  chunks.push(rest);
  return chunks.map((c) => c.trimEnd()).filter((c) => c.length > 0);
}

/** How a failed chunk send should be treated. */
export type ChunkFailure = { message: string; maybeDelivered: boolean; retryable: boolean; retryAfterMs?: number | undefined };

/** Total time `sendChunks` may wait to finish a partly sent message (well under the gateway's send timeout). */
const PARTIAL_WAIT_BUDGET_MS = 30_000;
const PARTIAL_ATTEMPTS = 4;

/**
 * Sends a message as consecutive chunks and maps the outcome to a `SendResult`.
 *
 * A failure before anything was sent is returned as is, so the gateway can
 * retry the whole message. Once a chunk is out, a gateway retry would send it
 * again, so retryable failures (rate limits, 5xx) of later chunks are retried
 * here within a bounded wait; if that does not succeed, the result is a
 * non-retryable failure that says how much was delivered.
 */
export async function sendChunks<T = string>(
  chunks: T[],
  sendOne: (chunk: T, index: number) => Promise<string>,
  classify: (e: unknown) => ChunkFailure,
  sleep: (ms: number) => Promise<void>,
): Promise<SendResult> {
  if (chunks.length === 0) return { status: 'failed', retryable: false, error: 'Cannot send an empty message' };
  const externalIds: string[] = [];
  let waited = 0;
  for (const [i, chunk] of chunks.entries()) {
    for (let attempt = 1; ; attempt++) {
      try {
        externalIds.push(await sendOne(chunk, i));
        break;
      } catch (e) {
        const f = classify(e);
        const partial = externalIds.length ? ` (after sending ${externalIds.length} of ${chunks.length} chunks)` : '';
        // Resending after an ambiguous failure could duplicate the message; the gateway leaves it for the owner.
        if (f.maybeDelivered) return { status: 'uncertain', error: `${f.message}${partial}` };
        if (externalIds.length === 0) {
          return { status: 'failed', retryable: f.retryable, error: f.message, ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) };
        }
        const delay = f.retryAfterMs ?? 1000 * 2 ** (attempt - 1);
        if (f.retryable && attempt < PARTIAL_ATTEMPTS && waited + delay <= PARTIAL_WAIT_BUDGET_MS) {
          waited += delay;
          await sleep(delay);
          continue;
        }
        return { status: 'failed', retryable: false, error: `${f.message}${partial}; the rest was not sent` };
      }
    }
  }
  return { status: 'sent', externalIds };
}

/**
 * Reads a response body, failing as soon as it exceeds `maxBytes` (a size
 * header can lie or be missing), so a large download never fills memory.
 */
export async function readCapped(res: Response, maxBytes: number, what = 'File'): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${what} is too large (${tooLarge(declared, maxBytes)})`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} is too large (over ${tooLarge(size, maxBytes)})`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const tooLarge = (size: number, max: number) => `${mb(size)}; the limit is ${mb(max)}`;

/** A file part for multipart uploads (FormData), read from the media store. */
export async function fileBlob(path: string, mimeType: string): Promise<Blob> {
  return new Blob([await readFile(path)], { type: mimeType });
}

/** What one outbound unit is: a file (with an optional caption) or a chunk of text. */
export type SendUnit = { kind: 'file'; file: OutboundAttachment; caption?: string } | { kind: 'text'; text: string };

/**
 * Orders a message with files: each file in turn, then the text. When the
 * text fits in a caption it rides on the last file instead of a separate
 * message (a lone caption reads better and costs one request less).
 */
export function sendUnits(message: { text: string; attachments?: OutboundAttachment[] | undefined }, maxChars: number, maxCaption: number): SendUnit[] {
  const files = message.attachments ?? [];
  const text = message.text.trim();
  if (files.length === 0) return splitText(message.text, maxChars).map((t) => ({ kind: 'text', text: t }));
  const units: SendUnit[] = files.map((file) => ({ kind: 'file', file }));
  if (text && text.length <= maxCaption) (units[units.length - 1] as { caption?: string }).caption = text;
  else if (text) units.push(...splitText(text, maxChars).map((t): SendUnit => ({ kind: 'text', text: t })));
  return units;
}
