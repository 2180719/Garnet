import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';

export type SessionHit = {
  sessionId: string;
  title: string | null;
  at: string;
  role: 'user' | 'assistant';
  snippet: string;
  /** The hit's session read untrusted content, so its text may carry some. */
  tainted: boolean;
};

export type SessionSearchDeps = {
  /** Best matches in the sessions `sessionId` may search; null when the index is unavailable. */
  search: (sessionId: string, query: string, opts: { limit: number; sinceIso?: string }) => SessionHit[] | null;
  now?: () => number;
};

/**
 * `session_search`: find what was said in earlier conversations. Which sessions it reaches is decided by `search`
 * (a chat sees only its own history), never by the model. It reads Garnet's own state, so it needs no permission;
 * a hit from a session that read untrusted content makes the result untrusted for this one.
 */
export function sessionSearchTool(deps: SessionSearchDeps): ToolDefinition<{ query: string; limit: number; since_days?: number }> {
  const now = deps.now ?? Date.now;
  return {
    name: 'session_search',
    version: 1,
    description: 'Search earlier conversations in this chat (or, in the terminal, earlier terminal sessions) for words you or the user used. Every word must appear; matches by stem. Returns short snippets with date and who said it. Use it when asked "what did we decide about X" or when earlier context may exist; check memory first for lasting facts.',
    input: z.object({
      query: z.string().min(1).max(200).describe('Words to look for, e.g. "flight lisbon".'),
      limit: z.number().int().min(1).max(20).default(8),
      since_days: z.number().int().min(1).max(3650).optional().describe('Only messages from the last N days.'),
    }),
    capability: 'fs.read',
    capabilitiesFor: () => [],
    idempotent: true,
    maxOutputChars: 8_000,
    async run({ query, limit, since_days }, ctx) {
      const sinceIso = since_days ? new Date(now() - since_days * 86_400_000).toISOString() : undefined;
      const hits = deps.search(ctx.sessionId, query, { limit, ...(sinceIso ? { sinceIso } : {}) });
      if (hits === null) throw new GarnetError('tool_failed', 'Session search is unavailable right now (the search index could not be used). Try again later or rely on memory.');
      if (hits.length === 0) return { content: 'No matches in past conversations.' };
      const lines = hits.map((h) => `- ${h.at.slice(0, 10)} ${h.role}${h.sessionId === ctx.sessionId ? ' (this session)' : ''}${h.title ? ` in "${h.title}"` : ''}: ${h.snippet.replace(/\s+/g, ' ')}`);
      const dirty = hits.filter((h) => h.tainted);
      return {
        content: lines.join('\n'),
        ...(dirty.length ? { untrusted: { source: `past conversation that read untrusted content${dirty[0]!.title ? ` ("${dirty[0]!.title}")` : ''}` } } : {}),
      };
    },
  };
}
