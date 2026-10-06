// Helpers shared by the channel adapters: send-outcome classification, chunked sends, text splitting.
import type { SendResult } from '../contracts/index.ts';

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
export async function sendChunks(
  chunks: string[],
  sendOne: (text: string, index: number) => Promise<string>,
  classify: (e: unknown) => ChunkFailure,
  sleep: (ms: number) => Promise<void>,
): Promise<SendResult> {
  if (chunks.length === 0) return { status: 'failed', retryable: false, error: 'Cannot send an empty message' };
  const externalIds: string[] = [];
  let waited = 0;
  for (const [i, text] of chunks.entries()) {
    for (let attempt = 1; ; attempt++) {
      try {
        externalIds.push(await sendOne(text, i));
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
