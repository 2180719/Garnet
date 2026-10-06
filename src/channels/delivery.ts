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
