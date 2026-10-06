import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { GarnetError } from '../../contracts/index.ts';
import { isPublicAddress } from './address.ts';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

export type WebFetcherOptions = {
  /** Largest (decompressed) body read; the rest is cut off and `truncated` is set. */
  maxBytes: number;
  /** Time limit for the whole fetch, redirects included. */
  timeoutMs: number;
  maxRedirects: number;
  userAgent?: string;
  /** DNS resolution (tests inject one). Defaults to the system resolver, all addresses. */
  resolve?: Resolver;
  /** Which resolved addresses may be connected to. Defaults to public unicast only. Tests only. */
  allowAddress?: (ip: string) => boolean;
};

export type FetchRequest = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /**
   * An owner-configured origin (a self-hosted search backend) that may live on
   * a private address. Only requests to exactly this origin skip the address
   * check; a redirect elsewhere is checked as usual.
   */
  trustedOrigin?: string;
};

export type FetchResponse = {
  /** Final URL after redirects. */
  url: string;
  /** Every URL requested before the final one. */
  redirects: string[];
  status: number;
  statusText: string;
  contentType: string;
  body: Buffer;
  /** True when the body was cut off at `maxBytes`. */
  truncated: boolean;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP(S) client that only reaches the public internet (the SSRF guard).
 *
 * For every hop, redirects included: the URL must be http(s) without
 * credentials; the host is resolved once, every resolved address must be
 * public, and the connection is made to that same validated address (pinned
 * through the socket's `lookup`, so DNS rebinding between check and connect is
 * impossible). TLS still verifies the certificate for the host name. Bodies
 * are decompressed with a cap, and the whole fetch has one deadline.
 *
 * Runs in-process with Node's own sockets: it does not use HTTP(S)_PROXY, and
 * the command sandbox's "no network" setting does not apply to it.
 */
export class WebFetcher {
  private readonly o: WebFetcherOptions;
  private readonly resolve: Resolver;
  private readonly allow: (ip: string) => boolean;

  constructor(options: WebFetcherOptions) {
    this.o = options;
    this.resolve = options.resolve ?? (async (host) => (await dnsLookup(host, { all: true, verbatim: true })) as ResolvedAddress[]);
    this.allow = options.allowAddress ?? isPublicAddress;
  }

  async fetch(rawUrl: string, req: FetchRequest = {}): Promise<FetchResponse> {
    const deadline = AbortSignal.timeout(this.o.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    const redirects: string[] = [];
    let url = parseTarget(rawUrl);
    let method = req.method ?? 'GET';
    let body = req.body;
    let headers = req.headers ?? {};
    try {
      for (;;) {
        const trusted = req.trustedOrigin !== undefined && url.origin === new URL(req.trustedOrigin).origin;
        const address = await this.pin(url, trusted, signal);
        const res = await this.send(url, address, { method, headers, body, signal });
        const location = res.headers.location;
        if (REDIRECTS.has(res.statusCode ?? 0) && location) {
          res.destroy();
          if (redirects.length >= this.o.maxRedirects) {
            throw new GarnetError('tool_failed', `Stopped after ${this.o.maxRedirects} redirects (last one pointed to ${clip(location)}).`);
          }
          redirects.push(url.href);
          let next: URL;
          try {
            next = parseTarget(new URL(location, url).href);
          } catch (e) {
            throw new GarnetError('denied', `Refused a redirect from ${url.host}: ${(e as Error).message}`);
          }
          // 303, and 301/302 after a POST, turn into a GET (as browsers do); 307/308 keep the method and body.
          if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
          }
          // Never carry credentials (API keys in headers) to another origin.
          if (next.origin !== url.origin) headers = {};
          url = next;
          continue;
        }
        const { data, truncated } = await readBody(res, this.o.maxBytes, signal);
        return {
          url: url.href,
          redirects,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          contentType: String(res.headers['content-type'] ?? ''),
          body: data,
          truncated,
        };
      }
    } catch (e) {
      if (deadline.aborted && !req.signal?.aborted) throw new GarnetError('timeout', `Fetching ${url.host} took longer than ${Math.round(this.o.timeoutMs / 1000)}s.`);
      if (req.signal?.aborted) throw new GarnetError('cancelled', 'The fetch was cancelled.');
      if (e instanceof GarnetError) throw e;
      throw new GarnetError('tool_failed', networkError(e, url));
    }
  }

  /** Resolves the host once and returns the address to connect to, after checking every resolved address. */
  private async pin(url: URL, trusted: boolean, signal: AbortSignal): Promise<ResolvedAddress> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: ResolvedAddress[];
    if (isIP(host)) {
      addresses = [{ address: host, family: isIP(host) as 4 | 6 }];
    } else {
      try {
        addresses = await abortable(this.resolve(host), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        throw new GarnetError('tool_failed', `Could not resolve the host name ${host} (${(e as { code?: string }).code ?? 'DNS error'}). Check the address.`);
      }
    }
    if (addresses.length === 0) throw new GarnetError('tool_failed', `The host name ${host} has no addresses.`);
    if (!trusted) {
      // Every address must be public: a resolver that answers with a public and a private one is refused outright.
      const bad = addresses.find((a) => !this.allow(a.address));
      if (bad) {
        const what = bad.address === host ? host : `${host} (${bad.address})`;
        throw new GarnetError('denied', `Refused: ${what} is a private, local or reserved address. web_fetch only reaches public internet hosts. Do not retry with another form of this address.`);
      }
    }
    return addresses[0]!;
  }

  private send(url: URL, pinned: ResolvedAddress, r: { method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal }): Promise<IncomingMessage> {
    const headers: OutgoingHttpHeaders = {
      'user-agent': this.o.userAgent ?? 'Garnet/1.0 (personal agent; +https://github.com/2180719/Garnet)',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
      'accept-encoding': 'gzip, deflate, br',
      ...lower(r.headers),
    };
    if (r.body !== undefined) headers['content-length'] = Buffer.byteLength(r.body);
    // The socket connects to the validated address; the URL's host name is still used for Host, SNI and certificate checks.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [pinned]);
      else callback(null, pinned.address, pinned.family);
    };
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = request(url, { method: r.method, headers, lookup, agent: false, signal: r.signal }, resolve);
      req.on('error', reject);
      req.end(r.body);
    });
  }
}

/** Parses a URL a fetch may target: http(s) only, no embedded credentials. */
export function parseTarget(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GarnetError('invalid_input', `"${clip(raw)}" is not a valid URL. Use a full address such as https://example.com/page.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GarnetError('invalid_input', `Only http and https URLs can be fetched, not ${url.protocol.replace(':', '')}.`);
  }
  if (url.username || url.password) throw new GarnetError('invalid_input', 'URLs with a user name or password are not fetched.');
  url.hash = '';
  return url;
}

async function readBody(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<{ data: Buffer; truncated: boolean }> {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  let stream: Readable = res;
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip());
  else if (encoding === 'deflate') stream = res.pipe(createInflate());
  else if (encoding === 'br') stream = res.pipe(createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw signal.reason;
      const buf = chunk as Buffer;
      if (size + buf.length > maxBytes) {
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } catch (e) {
    if (signal.aborted) throw e;
    // A broken compressed stream after some data: keep what decoded cleanly.
    if (size === 0) throw new GarnetError('tool_failed', `The response body could not be read (${(e as Error).message}).`);
    truncated = true;
  } finally {
    res.destroy();
    if (stream !== res) stream.destroy();
  }
  return { data: Buffer.concat(chunks, size), truncated };
}

function networkError(e: unknown, url: URL): string {
  const code = (e as { code?: string }).code;
  const host = url.host;
  switch (code) {
    case 'ECONNREFUSED':
      return `${host} refused the connection.`;
    case 'ECONNRESET':
      return `${host} closed the connection unexpectedly.`;
    case 'ETIMEDOUT':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return `Could not reach ${host} (${code}).`;
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `${host} has an invalid TLS certificate (${code}); not fetched.`;
    default:
      return `Fetching ${host} failed: ${(e as Error).message ?? String(e)}`;
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);
