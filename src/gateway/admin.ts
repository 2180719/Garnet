import type { Scope } from './keys.ts';

/**
 * Everything the dashboard can see and change, implemented by the
 * composition root so the gateway does not depend on memory, skills or the
 * scheduler. Methods throw RubyError('invalid_input') for bad requests.
 */
export interface AdminBackend {
  overview(): unknown;
  getConfig(): { config: unknown; schema: unknown };
  putConfig(raw: unknown): { restartRequired: boolean };
  approvals(): unknown;
  decideApproval(code: string, decision: 'approved' | 'denied'): Promise<unknown>;
  memory(ns: string): unknown;
  writeMemory(ns: string, file: string, content: string): unknown;
  rollbackMemory(ns: string, file: string, id: string): unknown;
  skills(): unknown;
  skill(name: string): unknown;
  skillAction(name: string, action: 'accept' | 'reject' | 'archive' | 'unarchive'): unknown;
  jobs(): unknown;
  jobAction(id: string, action: 'run' | 'resume'): Promise<unknown>;
  keys(): unknown;
  createKey(name: string, scopes: Scope[], expiresInDays?: number): unknown;
  revokeKey(id: string): boolean;
  pairing(): unknown;
  approvePairing(code: string): unknown;
  revokeIdentity(channel: string, senderId: string): boolean;
  usage(days: number): unknown;
  /** Paged session list (`q` matches id, title or conversation). */
  sessions(opts: Page & { q?: string }): unknown;
  /** One page of a session's event log, with secrets redacted and thinking omitted. `after` is a sequence number. */
  sessionEvents(id: string, after: number, limit: number): unknown;
  /** Paged API audit log. */
  audit(opts: Page & { status?: string; method?: string; keyId?: string; q?: string }): unknown;
  /** Paged task and outbox delivery failures. */
  failures(opts: Page & { kind?: string; status?: string }): unknown;
  /** Configured routes, conversation bindings (paged), identities and pending pairing requests. */
  routing(opts: Page): unknown;
  /** Forgets a conversation binding; the next message starts a fresh session. */
  unlinkConversation(key: string): boolean;
  /** Denies a pending pairing request. */
  denyPairing(code: string): boolean;
  achievements(): unknown;
  /** Harmless easter eggs only; earned achievements cannot be unlocked this way. */
  unlockEasterEgg(id: string): boolean;
}

export type Page = { limit: number; offset: number };

type Handler = (p: { params: string[]; query: URLSearchParams; body: () => Promise<unknown> }) => unknown;
export type AdminRoute = { method: string; pattern: RegExp; scope: Scope; handle: Handler };

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw Object.assign(new Error(`"${name}" must be a string.`), { status: 400 });
  return v;
};

/** Reads `limit` (1..200, default 50) and `offset` (>= 0) from a query string. */
function page(query: URLSearchParams): Page {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = query.get(name);
    if (raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw Object.assign(new Error(`"${name}" must be an integer from ${min} to ${max}.`), { status: 400 });
    return n;
  };
  return { limit: int('limit', 50, 1, 200), offset: int('offset', 0, 0, 10_000_000) };
}
const opt = (query: URLSearchParams, name: string): string | undefined => query.get(name)?.slice(0, 200) || undefined;

function pick<K extends string>(query: URLSearchParams, names: K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const n of names) {
    const v = opt(query, n);
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** Route table for /api/*. Reads need `read`; changes need `admin`. */
export function adminRoutes(b: AdminBackend): AdminRoute[] {
  const r = (method: string, pattern: RegExp, scope: Scope, handle: Handler): AdminRoute => ({ method, pattern, scope, handle });
  // Matched against the decoded path, so IDs with characters like @ work.
  const NAME = '([^/]+)';
  return [
    r('GET', /^\/api\/overview$/, 'read', () => b.overview()),
    r('GET', /^\/api\/config$/, 'read', () => b.getConfig()),
    r('PUT', /^\/api\/config$/, 'admin', async ({ body }) => b.putConfig(await body())),
    r('GET', /^\/api\/approvals$/, 'read', () => b.approvals()),
    r('POST', new RegExp(`^/api/approvals/${NAME}/(approve|deny)$`), 'admin', ({ params }) =>
      b.decideApproval(params[0]!, params[1] === 'approve' ? 'approved' : 'denied'),
    ),
    r('GET', /^\/api\/memory$/, 'read', ({ query }) => b.memory(query.get('ns') ?? 'default')),
    r('PUT', /^\/api\/memory\/(memory|user)$/, 'admin', async ({ params, query, body }) =>
      b.writeMemory(query.get('ns') ?? 'default', params[0]!, str(((await body()) as { content?: unknown })?.content, 'content')),
    ),
    r('POST', /^\/api\/memory\/(memory|user)\/rollback$/, 'admin', async ({ params, query, body }) =>
      b.rollbackMemory(query.get('ns') ?? 'default', params[0]!, str(((await body()) as { id?: unknown })?.id, 'id')),
    ),
    r('GET', /^\/api\/skills$/, 'read', () => b.skills()),
    r('GET', new RegExp(`^/api/skills/${NAME}$`), 'read', ({ params }) => b.skill(params[0]!)),
    r('POST', new RegExp(`^/api/skills/${NAME}/(accept|reject|archive|unarchive)$`), 'admin', ({ params }) =>
      b.skillAction(params[0]!, params[1] as 'accept' | 'reject' | 'archive' | 'unarchive'),
    ),
    r('GET', /^\/api\/jobs$/, 'read', () => b.jobs()),
    r('POST', new RegExp(`^/api/jobs/${NAME}/(run|resume)$`), 'admin', ({ params }) => b.jobAction(params[0]!, params[1] as 'run' | 'resume')),
    r('GET', /^\/api\/keys$/, 'admin', () => b.keys()),
    r('POST', /^\/api\/keys$/, 'admin', async ({ body }) => {
      const v = (await body()) as { name?: unknown; scopes?: unknown; expiresInDays?: unknown };
      const scopes = Array.isArray(v?.scopes) ? (v.scopes as Scope[]) : ['chat' as Scope];
      return b.createKey(str(v?.name, 'name'), scopes, typeof v?.expiresInDays === 'number' ? v.expiresInDays : undefined);
    }),
    r('DELETE', new RegExp(`^/api/keys/${NAME}$`), 'admin', ({ params }) => ({ revoked: b.revokeKey(params[0]!) })),
    r('GET', /^\/api\/pairing$/, 'read', () => b.pairing()),
    r('POST', new RegExp(`^/api/pairing/${NAME}/approve$`), 'admin', ({ params }) => b.approvePairing(params[0]!)),
    r('DELETE', new RegExp(`^/api/identities/${NAME}/${NAME}$`), 'admin', ({ params }) => ({ revoked: b.revokeIdentity(params[0]!, params[1]!) })),
    r('GET', /^\/api\/usage$/, 'read', ({ query }) => b.usage(Math.min(365, Number(query.get('days') ?? 30) || 30))),
    r('GET', /^\/api\/log\/sessions$/, 'read', ({ query }) => b.sessions({ ...page(query), ...(opt(query, 'q') ? { q: opt(query, 'q')! } : {}) })),
    r('GET', new RegExp(`^/api/log/sessions/${NAME}/events$`), 'read', ({ params, query }) => {
      const after = Number(query.get('after') ?? 0);
      if (!Number.isInteger(after) || after < 0) throw Object.assign(new Error('"after" must be a non-negative integer.'), { status: 400 });
      return b.sessionEvents(params[0]!, after, page(query).limit);
    }),
    r('GET', /^\/api\/log\/audit$/, 'read', ({ query }) =>
      b.audit({ ...page(query), ...pick(query, ['status', 'method', 'keyId', 'q']) }),
    ),
    r('GET', /^\/api\/log\/failures$/, 'read', ({ query }) => b.failures({ ...page(query), ...pick(query, ['kind', 'status']) })),
    r('GET', /^\/api\/routing$/, 'read', ({ query }) => b.routing(page(query))),
    r('DELETE', new RegExp(`^/api/conversations/${NAME}$`), 'admin', ({ params }) => ({ removed: b.unlinkConversation(params[0]!) })),
    r('DELETE', new RegExp(`^/api/pairing/${NAME}$`), 'admin', ({ params }) => ({ removed: b.denyPairing(params[0]!) })),
    r('GET', /^\/api\/achievements$/, 'read', () => b.achievements()),
    r('POST', new RegExp(`^/api/achievements/${NAME}/unlock$`), 'read', ({ params }) => ({ unlocked: b.unlockEasterEgg(params[0]!) })),
  ];
}
