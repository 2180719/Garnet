import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { errorMessage, isRubyError, newId, RubyError, type TaskRecord } from '../contracts/index.ts';
import type { KeyStore, SessionStore } from '../store/index.ts';
import type { Gateway } from './gateway.ts';
import { RateLimiter, type ApiKeys, type Scope } from './keys.ts';
import { adminRoutes, type AdminBackend, type AdminRoute } from './admin.ts';
import type { DemoChat } from './demo.ts';

const MAX_BODY = 1_000_000;
/** A request body must arrive within this long, so a client cannot hold a socket open by trickling bytes. */
const BODY_TIMEOUT_MS = 30_000;
const AUDIT_RETENTION_MS = 90 * 86_400_000;
const AUDIT_MAX_ROWS = 100_000;
const AUDIT_PRUNE_EVERY_MS = 3_600_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export type ApiServerDeps = {
  gateway: Gateway;
  keys: ApiKeys;
  keyStore: KeyStore;
  sessions: SessionStore;
  rateLimitPerMinute: number;
  version: string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Optional handler for non-API paths (the dashboard). */
  fallback?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Dashboard/admin operations under /api/*. */
  admin?: AdminBackend;
  /** Public website demo (keyless, tool-less, rate-limited). */
  demo?: DemoChat;
  /**
   * Take the client IP from X-Forwarded-For (only behind your own reverse proxy). The rightmost
   * entry is used: it is the one your proxy appended; entries to its left are client-supplied.
   */
  trustProxy?: boolean;
  /** Deadline for reading a request body (default 30 s). */
  bodyTimeoutMs?: number;
  /** Body cap for /v1/chat/completions, which may carry images as data URLs. Default 1 MB (no files). */
  maxChatBodyBytes?: number;
};

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; keyId: string | null; scopes: string[]; ip: string | null; authAttempted: boolean };

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const chatBody = z.object({
  model: z.string().optional(),
  messages: z
    .array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.union([textPart, z.object({ type: z.string() }).loose()]))]) }))
    .min(1),
  stream: z.boolean().optional(),
});

/**
 * The opt-in HTTP API: an OpenAI-compatible chat endpoint plus a small native
 * API. Every route except /health requires a scoped API key.
 */
export class ApiServer {
  private readonly deps: ApiServerDeps;
  private readonly limiter: RateLimiter;
  private readonly authFailures = new RateLimiter(20);
  /** Failed authentications are audited, but at most a few rows per IP and per minute overall. */
  private readonly failureAuditPerIp = new RateLimiter(5);
  private readonly failureAuditTotal = new RateLimiter(60);
  private lastAuditPrune = 0;
  private server: Server | null = null;
  private readonly adminRoutes: AdminRoute[];

  constructor(deps: ApiServerDeps) {
    this.deps = deps;
    this.adminRoutes = deps.admin ? adminRoutes(deps.admin) : [];
    this.limiter = new RateLimiter(deps.rateLimitPerMinute);
  }

  /** Starts listening. Refuses a non-loopback bind unless at least one active key exists. */
  async listen(host: string, port: number): Promise<AddressInfo> {
    if (!LOOPBACK.has(host) && this.deps.keys.activeCount() === 0) {
      throw new RubyError('config', `Refusing to listen on ${host} without an API key. Create one with \`ruby api key create\`, or bind to 127.0.0.1.`);
    }
    const server = createServer((req, res) => void this.handle(req, res));
    // No overall request timeout: agent tasks can run for a long time. headersTimeout bounds the
    // header phase, readJson bounds the body phase (BODY_TIMEOUT_MS), keepAliveTimeout reaps idle sockets.
    server.requestTimeout = 0;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    return server.address() as AddressInfo;
  }

  /** Stops accepting connections, lets in-flight requests finish for up to `graceMs`, then closes the rest. */
  async close(graceMs = 20_000): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    await closed;
    clearTimeout(timer);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ruby.local');
    // The rightmost X-Forwarded-For entry is the one the trusted proxy appended; anything left of it is client-controlled.
    const forwarded = this.deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)?.trim() : '';
    const ctx: Ctx = { req, res, url, keyId: null, scopes: [], ip: forwarded || req.socket.remoteAddress || null, authAttempted: false };
    const readBody = (maxBytes = MAX_BODY) => readJson(req, this.deps.bodyTimeoutMs ?? BODY_TIMEOUT_MS, maxBytes);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok', version: this.deps.version });
      if (this.deps.demo && (await this.deps.demo.handle(req, res, url.pathname, ctx.ip ?? 'unknown', readBody))) return;
      if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/')) {
        if (this.deps.fallback?.(req, res)) return;
        throw new HttpError(404, 'Not found.');
      }
      ctx.authAttempted = true;
      this.authenticate(ctx);
      await this.route(ctx, readBody);
    } catch (e) {
      const status =
        e instanceof HttpError
          ? e.status
          : isRubyError(e, 'invalid_input') || isRubyError(e, 'config') || (e as { status?: number })?.status === 400
            ? 400
            : isRubyError(e, 'denied')
              ? 403
              : isRubyError(e, 'conflict')
                ? 409
                : 500;
      if (status === 500) this.deps.log?.('error', `API ${req.method} ${url.pathname}: ${errorMessage(e)}`);
      if (!res.headersSent) {
        for (const [k, v] of Object.entries(e instanceof HttpError ? e.headers : {})) res.setHeader(k, v);
        const problems = isRubyError(e, 'config') && Array.isArray(e.detail?.problems) ? { issues: e.detail.problems } : {};
        send(res, status, { error: { message: status === 500 ? 'Internal error.' : errorMessage(e), type: errorType(status), ...problems } });
      } else res.end();
    } finally {
      this.audit(ctx);
    }
  }

  /**
   * Audits authenticated requests, and failed authentication attempts at a
   * limited rate. Keyless traffic (health, static files, the demo, unknown
   * paths) is not audited, so it cannot grow the table. Old rows are pruned.
   */
  private audit(ctx: Ctx): void {
    const ip = ctx.ip ?? 'unknown';
    const failed = !ctx.keyId && ctx.authAttempted;
    if (!ctx.keyId && !(failed && this.failureAuditPerIp.take(ip) === 0 && this.failureAuditTotal.take('*') === 0)) return;
    const { keyStore } = this.deps;
    keyStore.audit({ keyId: ctx.keyId, ip: ctx.ip, method: ctx.req.method ?? '?', path: ctx.url.pathname, status: ctx.res.statusCode });
    const now = Date.now();
    if (now - this.lastAuditPrune >= AUDIT_PRUNE_EVERY_MS) {
      this.lastAuditPrune = now;
      try {
        keyStore.pruneAudit(new Date(now - AUDIT_RETENTION_MS).toISOString(), AUDIT_MAX_ROWS);
      } catch (e) {
        this.deps.log?.('warn', `Pruning the API audit log failed: ${errorMessage(e)}`);
      }
    }
  }

  private authenticate(ctx: Ctx): void {
    const ip = ctx.ip ?? 'unknown';
    const header = ctx.req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const row = presented ? this.deps.keys.verify(presented) : null;
    if (!row) {
      const wait = this.authFailures.take(ip);
      if (wait > 0) throw new HttpError(429, 'Too many failed attempts.', { 'Retry-After': String(Math.ceil(wait / 1000)) });
      throw new HttpError(401, 'A valid API key is required (Authorization: Bearer ruby_…).', { 'WWW-Authenticate': 'Bearer' });
    }
    ctx.keyId = row.id;
    ctx.scopes = row.scopes;
    const wait = this.limiter.take(row.id);
    if (wait > 0) throw new HttpError(429, 'Rate limit exceeded.', { 'Retry-After': String(Math.ceil(wait / 1000)) });
  }

  private require(ctx: Ctx, scope: Scope): void {
    if (!ctx.scopes.includes(scope) && !ctx.scopes.includes('admin')) throw new HttpError(403, `This key lacks the "${scope}" scope.`);
  }

  private async route(ctx: Ctx, readBody: (maxBytes?: number) => Promise<unknown>): Promise<void> {
    const { req, res, url } = ctx;
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/v1/models') {
      if (!ctx.scopes.includes('chat') && !ctx.scopes.includes('read')) this.require(ctx, 'chat');
      return send(res, 200, { object: 'list', data: [{ id: 'ruby', object: 'model', created: 0, owned_by: 'ruby' }] });
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      this.require(ctx, 'chat');
      return this.chatCompletions(ctx, readBody);
    }
    if (method === 'GET' && path === '/api/health') {
      this.require(ctx, 'read');
      return send(res, 200, { version: this.deps.version, ...this.deps.gateway.health() });
    }
    if (method === 'GET' && path === '/api/sessions') {
      this.require(ctx, 'read');
      return send(res, 200, { sessions: this.deps.sessions.listSessions(intParam(url, 'limit', 50, 1, 200)) });
    }
    const events = /^\/api\/sessions\/([A-Za-z0-9_]+)\/events$/.exec(path);
    if (method === 'GET' && events) {
      this.require(ctx, 'read');
      const id = events[1]!;
      if (!this.deps.sessions.getSession(id)) throw new HttpError(404, 'No such session.');
      const after = intParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
      // Sanitized view (no thinking, no frozen prompt) for read keys; raw events only for admin without a backend.
      if (this.deps.admin) return send(res, 200, this.deps.admin.sessionEvents(id, after, 200));
      this.require(ctx, 'admin');
      return send(res, 200, { events: this.deps.sessions.events(id, after) });
    }
    // Match per decoded segment so encoded characters (e.g. %40) work but an encoded "/" cannot split a segment.
    let decoded: string;
    try {
      decoded = path.split('/').map((seg) => decodeURIComponent(seg).replaceAll('/', '\u0000')).join('/');
    } catch {
      throw new HttpError(400, 'Malformed URL.');
    }
    for (const route of this.adminRoutes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(decoded);
      if (!m) continue;
      this.require(ctx, route.scope);
      const result = await route.handle({ params: m.slice(1).map((p) => p.replaceAll('\u0000', '/')), query: url.searchParams, body: readBody });
      return send(res, 200, result ?? { ok: true });
    }
    throw new HttpError(404, 'Not found.');
  }

  private async chatCompletions(ctx: Ctx, readBody: (maxBytes?: number) => Promise<unknown>): Promise<void> {
    const { req, res } = ctx;
    const parsed = chatBody.safeParse(await readBody(Math.max(MAX_BODY, this.deps.maxChatBodyBytes ?? MAX_BODY)));
    if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const last = parsed.data.messages.at(-1)!;
    if (last.role !== 'user') throw new HttpError(400, 'The last message must have role "user".');
    const text = typeof last.content === 'string' ? last.content : last.content.flatMap((p) => (p.type === 'text' && 'text' in p ? [String(p.text)] : [])).join('\n');
    const files = typeof last.content === 'string' ? [] : last.content.flatMap((p) => filePart(p));
    if (!text.trim() && files.length === 0) throw new HttpError(400, 'The last user message has no text.');
    // Ruby keeps conversation state server-side: only the newest user message is used.
    const conversation = String(req.headers['x-ruby-conversation'] ?? 'default');
    if (!/^[a-z0-9-]{1,40}$/.test(conversation)) throw new HttpError(400, 'X-Ruby-Conversation must match [a-z0-9-]{1,40}.');

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const id = `chatcmpl-${newId('r')}`;
    const created = Math.floor(Date.now() / 1000);
    const key = `api:${ctx.keyId}:${conversation}`;
    const input = files.length ? { text, files } : text;

    if (parsed.data.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'ruby', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant' });
      let streamed = false;
      let result: Awaited<ReturnType<Gateway['chat']>>;
      try {
        result = await this.deps.gateway.chat(key, input, {
          signal: abort.signal,
          source: 'api',
          onEvent: (e) => {
            if (e.type === 'text') {
              streamed = true;
              chunk({ content: e.text });
            }
          },
        });
      } catch (e) {
        // Headers are out: an attachment nobody can read (e.g. an image for a text-only model) is answered in the stream.
        if (!isRubyError(e, 'invalid_input') || streamed) throw e;
        chunk({ content: errorMessage(e) });
        chunk({}, 'stop');
        res.end('data: [DONE]\n\n');
        return;
      }
      // Status notes (approval needed, stopped early) are not part of the streamed text.
      if (!streamed || result.task.status !== 'completed') chunk({ content: streamed ? `\n\n${statusNote(result.task)}` : result.text });
      chunk({}, finishReason(result.task));
      res.end('data: [DONE]\n\n');
      return;
    }

    const result = await this.deps.gateway.chat(key, input, { signal: abort.signal, source: 'api' });
    const u = result.task.usage;
    const prompt = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    send(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: 'ruby',
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: finishReason(result.task) }],
      usage: { prompt_tokens: prompt, completion_tokens: u.outputTokens ?? 0, total_tokens: prompt + (u.outputTokens ?? 0) },
      ruby: { task_id: result.task.id, session_id: result.sessionId, status: result.task.status },
    });
  }
}

/** An integer query parameter within [min, max]; 400 otherwise (NaN or a negative LIMIT would reach SQLite). */
function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `"${name}" must be an integer from ${min} to ${max}.`);
  return n;
}

function statusNote(task: TaskRecord): string {
  return task.status === 'completed' ? '' : `(${task.status.replaceAll('_', ' ')}${task.reason ? `: ${task.reason}` : ''})`;
}

function finishReason(task: TaskRecord): string {
  return task.status === 'budget_exhausted' ? 'length' : 'stop';
}

function errorType(status: number): string {
  return status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

/**
 * Files in an OpenAI-style content part: `image_url` and `file` parts, as
 * base64 data URLs only. Ruby never fetches a client-supplied URL (that would
 * let any chat key make the host request internal addresses). Other part
 * types are refused rather than silently dropped.
 */
function filePart(p: { type: string } & Record<string, unknown>): { data: Uint8Array; mimeType?: string; name?: string }[] {
  if (p.type === 'text') return [];
  if (p.type === 'image_url') {
    const v = p.image_url as { url?: unknown } | string | undefined;
    const url = typeof v === 'string' ? v : v?.url;
    if (typeof url !== 'string') throw new HttpError(400, 'image_url parts need image_url.url.');
    return [decodeDataUrl(url, 'image')];
  }
  if (p.type === 'file') {
    const f = p.file as { file_data?: unknown; filename?: unknown } | undefined;
    if (typeof f?.file_data !== 'string') throw new HttpError(400, 'unsupported_content_type: file parts need file.file_data as a data URL (file_id uploads are not supported).');
    const decoded = decodeDataUrl(f.file_data, 'file');
    return [{ ...decoded, ...(typeof f.filename === 'string' ? { name: f.filename } : {}) }];
  }
  throw new HttpError(400, `unsupported_content_type: "${String(p.type).slice(0, 40)}" parts are not supported (use text, image_url or file with data URLs).`);
}

function decodeDataUrl(url: string, what: string): { data: Uint8Array; mimeType?: string } {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,]*)*);base64,([A-Za-z0-9+/=\s]*)$/i.exec(url);
  if (!m) {
    const remote = /^https?:/i.test(url);
    throw new HttpError(400, remote ? `unsupported_content_type: ${what} URLs are not fetched; send the ${what} inline as a base64 data URL.` : `Malformed ${what} data URL (expected data:<type>;base64,<data>).`);
  }
  const data = new Uint8Array(Buffer.from(m[3]!, 'base64'));
  if (data.byteLength === 0) throw new HttpError(400, `Empty ${what} data URL.`);
  return { data, ...(m[1] ? { mimeType: m[1].toLowerCase() } : {}) };
}

/** Reads a JSON body of at most `maxBytes` that must arrive within `timeoutMs`. */
async function readJson(req: IncomingMessage, timeoutMs: number, maxBytes = MAX_BODY): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new HttpError(413, 'Request body too large.', { Connection: 'close' });
  const read = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'Request body too large.', { Connection: 'close' });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  })();
  read.catch(() => {}); // after a timeout the read may still fail when the socket closes
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Connection: close makes the server drop the socket after the 408, ending the trickle.
    timer = setTimeout(() => reject(new HttpError(408, 'Timed out reading the request body.', { Connection: 'close' })), timeoutMs);
  });
  let body: Buffer;
  try {
    body = await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}
