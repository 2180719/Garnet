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
  /** Use the first X-Forwarded-For address as the client IP (only behind your own reverse proxy). */
  trustProxy?: boolean;
};

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; keyId: string | null; scopes: string[]; ip: string | null };

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
    server.requestTimeout = 0; // long-running agent tasks; idle sockets are still reaped by headersTimeout
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
    const forwarded = this.deps.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    const ctx: Ctx = { req, res, url, keyId: null, scopes: [], ip: forwarded || req.socket.remoteAddress || null };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok', version: this.deps.version });
      if (this.deps.demo && (await this.deps.demo.handle(req, res, url.pathname, ctx.ip ?? 'unknown', () => readJson(req)))) return;
      if (!url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/api/')) {
        if (this.deps.fallback?.(req, res)) return;
        throw new HttpError(404, 'Not found.');
      }
      this.authenticate(ctx);
      await this.route(ctx);
    } catch (e) {
      const status =
        e instanceof HttpError
          ? e.status
          : isRubyError(e, 'invalid_input') || isRubyError(e, 'config') || (e as { status?: number })?.status === 400
            ? 400
            : isRubyError(e, 'denied')
              ? 403
              : 500;
      if (status === 500) this.deps.log?.('error', `API ${req.method} ${url.pathname}: ${errorMessage(e)}`);
      if (!res.headersSent) {
        for (const [k, v] of Object.entries(e instanceof HttpError ? e.headers : {})) res.setHeader(k, v);
        const problems = isRubyError(e, 'config') && Array.isArray(e.detail?.problems) ? { issues: e.detail.problems } : {};
        send(res, status, { error: { message: status === 500 ? 'Internal error.' : errorMessage(e), type: errorType(status), ...problems } });
      } else res.end();
    } finally {
      if (url.pathname !== '/health') {
        this.deps.keyStore.audit({ keyId: ctx.keyId, ip: ctx.ip, method: req.method ?? '?', path: url.pathname, status: res.statusCode });
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

  private async route(ctx: Ctx): Promise<void> {
    const { req, res, url } = ctx;
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/v1/models') {
      if (!ctx.scopes.includes('chat') && !ctx.scopes.includes('read')) this.require(ctx, 'chat');
      return send(res, 200, { object: 'list', data: [{ id: 'ruby', object: 'model', created: 0, owned_by: 'ruby' }] });
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      this.require(ctx, 'chat');
      return this.chatCompletions(ctx);
    }
    if (method === 'GET' && path === '/api/health') {
      this.require(ctx, 'read');
      return send(res, 200, { version: this.deps.version, ...this.deps.gateway.health() });
    }
    if (method === 'GET' && path === '/api/sessions') {
      this.require(ctx, 'read');
      return send(res, 200, { sessions: this.deps.sessions.listSessions(Number(url.searchParams.get('limit') ?? 50)) });
    }
    const events = /^\/api\/sessions\/([A-Za-z0-9_]+)\/events$/.exec(path);
    if (method === 'GET' && events) {
      this.require(ctx, 'read');
      const id = events[1]!;
      if (!this.deps.sessions.getSession(id)) throw new HttpError(404, 'No such session.');
      return send(res, 200, { events: this.deps.sessions.events(id, Number(url.searchParams.get('after') ?? 0)) });
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
      const result = await route.handle({ params: m.slice(1).map((p) => p.replaceAll('\u0000', '/')), query: url.searchParams, body: () => readJson(req) });
      return send(res, 200, result ?? { ok: true });
    }
    throw new HttpError(404, 'Not found.');
  }

  private async chatCompletions(ctx: Ctx): Promise<void> {
    const { req, res } = ctx;
    const parsed = chatBody.safeParse(await readJson(req));
    if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const last = parsed.data.messages.at(-1)!;
    if (last.role !== 'user') throw new HttpError(400, 'The last message must have role "user".');
    const text = typeof last.content === 'string' ? last.content : last.content.flatMap((p) => (p.type === 'text' && 'text' in p ? [String(p.text)] : [])).join('\n');
    if (!text.trim()) throw new HttpError(400, 'The last user message has no text.');
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

    if (parsed.data.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'ruby', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant' });
      let streamed = false;
      const result = await this.deps.gateway.chat(key, text, {
        signal: abort.signal,
        source: 'api',
        onEvent: (e) => {
          if (e.type === 'text') {
            streamed = true;
            chunk({ content: e.text });
          }
        },
      });
      // Status notes (approval needed, stopped early) are not part of the streamed text.
      if (!streamed || result.task.status !== 'completed') chunk({ content: streamed ? `\n\n${statusNote(result.task)}` : result.text });
      chunk({}, finishReason(result.task));
      res.end('data: [DONE]\n\n');
      return;
    }

    const result = await this.deps.gateway.chat(key, text, { signal: abort.signal, source: 'api' });
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}
