import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { errorMessage, isRubyError, newId, RubyError, type TaskRecord } from '../contracts/index.ts';
import type { KeyStore, SessionStore } from '../store/index.ts';
import type { ChatResult, Gateway } from './gateway.ts';
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
/** SSE comment interval while a streamed task runs, so proxies and clients do not cut an idle stream. */
const KEEPALIVE_MS = 15_000;
/** Paths a browser app on an allowed origin may call (`api.corsOrigins`). */
const CORS_PATHS = new Set(['/v1/chat/completions', '/v1/models']);
/** Earlier client messages replayed into a conversation Ruby has not seen, newest kept. */
const MAX_REPLAY_CHARS = 12_000;

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
  /** Browser origins allowed to call the OpenAI-compatible routes. Empty: no CORS headers. */
  corsOrigins?: string[];
  /** SSE keepalive interval (default 15 s). */
  keepaliveMs?: number;
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

// Clients send history with `content: null` (assistant turns that carried tool calls) and
// content-part arrays; only text parts are read. Images and files are not supported here yet.
const contentPart = z.object({ type: z.string() }).loose();
const chatBody = z.object({
  model: z.string().optional(),
  messages: z
    .array(z.object({ role: z.string(), content: z.union([z.string(), z.array(contentPart), z.null()]).optional() }).loose())
    .min(1),
  stream: z.boolean().optional(),
  user: z.string().max(256).optional(),
});
type ChatMessageIn = z.infer<typeof chatBody>['messages'][number];

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
    const readBody = () => readJson(req, this.deps.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, { status: 'ok', version: this.deps.version });
      if (this.deps.demo && (await this.deps.demo.handle(req, res, url.pathname, ctx.ip ?? 'unknown', readBody))) return;
      if (this.cors(req, res, url.pathname)) return;
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
   * Opt-in CORS for browser chat apps: only listed origins, only the
   * OpenAI-compatible routes. Answers the preflight (returns true); the
   * actual request still needs a valid key.
   */
  private cors(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const allowed = this.deps.corsOrigins ?? [];
    if (allowed.length === 0 || !CORS_PATHS.has(path)) return false;
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !allowed.some((o) => o.replace(/\/+$/, '') === origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method !== 'OPTIONS') return false;
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Ruby-Conversation, X-OpenWebUI-Chat-Id',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return true;
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

  private async route(ctx: Ctx, readBody: () => Promise<unknown>): Promise<void> {
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

  private async chatCompletions(ctx: Ctx, readBody: () => Promise<unknown>): Promise<void> {
    const { req, res } = ctx;
    const parsed = chatBody.safeParse(await readBody());
    if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const { messages, stream } = parsed.data;
    const last = messages.at(-1)!;
    if (last.role !== 'user') throw new HttpError(400, 'The last message must have role "user".');
    const text = contentText(last.content);
    if (!text.trim()) {
      throw new HttpError(400, hasMedia(last.content) ? "Ruby can't read images or files sent over the API yet. Send the text instead." : 'The last user message has no text.');
    }

    const id = `chatcmpl-${newId('r')}`;
    const created = Math.floor(Date.now() / 1000);
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    // Open WebUI's background tasks (titles, tags, follow-ups...) are answered here, cheaply:
    // they must not become agent turns with tools and memory, nor land in the conversation.
    const task = clientTask(text);
    if (task !== null) return this.reply(res, { id, created, stream: stream === true, text: task });

    const { conversation, derived } = conversationFor(req, ctx.keyId ?? '', parsed.data.user, messages);
    const key = `api:${ctx.keyId}:${conversation}`;
    // A stateless client's chat that Ruby has not seen (it began elsewhere, or its first message was
    // edited): replay the earlier messages once so the answer has their context.
    const input = derived && !this.deps.gateway.hasConversation(key) ? withReplay(messages.slice(0, -1), text) : text;
    const approval = /^\/(approve|deny)\s+([A-Za-z0-9]{4,12})\s*$/i.exec(text.trim());
    const run = (onEvent?: (e: { type: string; text?: string }) => void): Promise<ChatResult | { text: string }> => {
      const options = { signal: abort.signal, source: 'api', ...(onEvent ? { onEvent } : {}) };
      // Approvals work in API chats like in any other chat, for approvals raised in this conversation.
      if (approval) return this.deps.gateway.approveInConversation(key, approval[2]!, approval[1]!.toLowerCase() === 'approve' ? 'approved' : 'denied', options);
      return this.deps.gateway.chat(key, input, options);
    };

    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'ruby', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant' });
      // Comment lines keep reverse proxies and clients from timing out during long tool runs.
      const keepalive = setInterval(() => res.write(': keepalive\n\n'), this.deps.keepaliveMs ?? KEEPALIVE_MS);
      let streamed = false;
      let result: ChatResult | { text: string };
      try {
        result = await run((e) => {
          if (e.type === 'text' && e.text) {
            streamed = true;
            chunk({ content: e.text });
          }
        });
      } finally {
        clearInterval(keepalive);
      }
      const done = 'task' in result ? result.task : null;
      // Status notes (approval needed, stopped early) are not part of the streamed text.
      if (!streamed || (done && done.status !== 'completed')) chunk({ content: streamed && done ? `\n\n${statusNote(done)}` : result.text });
      chunk({}, done ? finishReason(done) : 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }

    const result = await run();
    if (!('task' in result)) return this.reply(res, { id, created, stream: false, text: result.text });
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

  /** A reply that did not run a task (client tasks, approval errors): no model was called. */
  private reply(res: ServerResponse, r: { id: string; created: number; stream: boolean; text: string }): void {
    if (r.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id: r.id, object: 'chat.completion.chunk', created: r.created, model: 'ruby', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant', content: r.text });
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
      return;
    }
    send(res, 200, {
      id: r.id,
      object: 'chat.completion',
      created: r.created,
      model: 'ruby',
      choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

/** Text parts of an OpenAI message's content, joined by newlines. Other parts (images, files) are ignored. */
function contentText(content: ChatMessageIn['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((p) => (p.type === 'text' && typeof p.text === 'string' ? [p.text] : [])).join('\n');
}

function hasMedia(content: ChatMessageIn['content']): boolean {
  return Array.isArray(content) && content.some((p) => p.type !== 'text');
}

const shortHash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 20);

/**
 * Which server-side conversation a request continues. In order:
 * 1. `X-Ruby-Conversation` (Ruby-aware clients, the dashboard): used as is.
 * 2. `X-OpenWebUI-Chat-Id` (Open WebUI with ENABLE_FORWARD_USER_INFO_HEADERS): one conversation per chat.
 * 3. Otherwise the client is assumed to resend the whole chat each time (Open WebUI, LibreChat
 *    and most OpenAI frontends do): the conversation is a hash of the key, the `user` field and
 *    the chat's first user message, which stays the same for every turn of that chat.
 * `user` only scopes the hash: it names a person, not a chat, so keying on it alone would merge
 * every chat of that person. A client that sends only its newest message must name the
 * conversation with `X-Ruby-Conversation`, or each message starts a new one.
 */
export function conversationFor(
  req: IncomingMessage,
  keyId: string,
  user: string | undefined,
  messages: ChatMessageIn[],
): { conversation: string; derived: boolean } {
  const named = req.headers['x-ruby-conversation'];
  if (named !== undefined) {
    const name = String(named);
    if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new HttpError(400, 'X-Ruby-Conversation must match [a-z0-9-]{1,40}.');
    return { conversation: name, derived: false };
  }
  const chatId = String(req.headers['x-openwebui-chat-id'] ?? '').trim();
  // Open WebUI's temporary chats have no stable id ("local:..."); they fall through to the hash.
  if (chatId && !chatId.startsWith('local')) return { conversation: `owui-${shortHash(keyId, chatId)}`, derived: true };
  const first = messages.find((m) => m.role === 'user');
  return { conversation: `chat-${shortHash(keyId, user ?? '', contentText(first?.content ?? ''))}`, derived: true };
}

/** Prefixes the newest message with the client's earlier messages (newest kept within the cap). */
function withReplay(earlier: ChatMessageIn[], text: string): string {
  const lines = earlier
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ who: m.role === 'user' ? 'Owner' : 'Assistant', text: contentText(m.content).trim() }))
    .filter((m) => m.text)
    .map((m) => `${m.who}: ${m.text}`);
  if (lines.length === 0) return text;
  let transcript = lines.join('\n\n');
  if (transcript.length > MAX_REPLAY_CHARS) transcript = `[…]\n${transcript.slice(-MAX_REPLAY_CHARS)}`;
  return `[Earlier messages in this chat, sent by the client app. You had not seen them before:]\n${transcript}\n[End of earlier messages.]\n\n${text}`;
}

/**
 * Detects Open WebUI's background task prompts (title, tags, follow-ups,
 * search queries, image prompt, autocomplete). Its default templates begin
 * with "### Task:" and embed the chat in <chat_history>. Returns the cheap
 * answer in the JSON shape the template asks for, or null for a normal message.
 */
export function clientTask(text: string): string | null {
  const t = text.trimStart();
  if (!/^###\s*Task:/i.test(t) || !t.includes('<chat_history>')) return null;
  if (t.includes('"follow_ups"')) return JSON.stringify({ follow_ups: [] });
  if (t.includes('"tags"')) return JSON.stringify({ tags: ['General'] });
  if (t.includes('"queries"')) return JSON.stringify({ queries: [] });
  if (t.includes('"title"')) return JSON.stringify({ title: titleFrom(t) });
  if (t.includes('"prompt"')) return JSON.stringify({ prompt: '' });
  if (t.includes('"text"')) return JSON.stringify({ text: '' });
  return '{}';
}

/** A short title from the chat history's last user line (Open WebUI renders history as "USER: ..." lines). */
function titleFrom(prompt: string): string {
  const history = /<chat_history>([\s\S]*?)<\/chat_history>/.exec(prompt)?.[1] ?? '';
  const userLines = history.split('\n').filter((l) => /^USER:/.test(l));
  const words = (userLines.at(0) ?? '').replace(/^USER:\s*/, '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean);
  const title = words.slice(0, 5).join(' ');
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'New chat';
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

/** Reads a JSON body of at most MAX_BODY bytes that must arrive within `timeoutMs`. */
async function readJson(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_BODY) throw new HttpError(413, 'Request body too large.', { Connection: 'close' });
  const read = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.', { Connection: 'close' });
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
