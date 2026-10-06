// Executes slash commands against Ruby. Shared by the interactive and plain chats.

import type { ToolCallBlock, ToolResult } from '../../contracts/index.ts';
import type { Ruby } from '../../main.ts';
import type { ParsedSlash } from './commands.ts';
import { helpRows, sessionTotals, toolExpandedRows, transcriptRows } from './render.ts';
import { formatDuration, formatTokens, padEnd, sanitize, truncate, wrapText } from './text.ts';
import type { Theme } from './theme.ts';

export type CommandContext = {
  ruby: Ruby;
  sessionId: string;
  theme: Theme;
  width: number;
  toolLog: readonly { call: ToolCallBlock; result: ToolResult }[];
  /** Makes `id` the active session. */
  switchTo: (id: string) => void;
  signal?: AbortSignal;
};

/** `rows` renders the output at a width, so a narrower terminal can redraw it cleanly. */
export type CommandResult = { rows: (width: number) => string[]; effect?: 'exit' | 'clear' };

const none = (): string[] => [];

export async function executeCommand(parsed: NonNullable<ParsedSlash>, ctx: CommandContext): Promise<CommandResult> {
  const { ruby, theme: t } = ctx;
  if ('unknown' in parsed) return { rows: (w: number) => ['', `  ${t.error('✗')} Unknown command /${sanitize(parsed.unknown)}. Type ${t.bold('/help')} for the list.`] };
  const { command, args } = parsed;
  switch (command.name) {
    case 'help':
      return { rows: (w: number) => helpRows(t, w) };
    case 'exit':
      return { rows: none, effect: 'exit' };
    case 'clear':
      return { rows: none, effect: 'clear' };
    case 'new': {
      const s = ruby.store.createSession('Terminal chat');
      ctx.switchTo(s.id);
      return { rows: (w: number) => ['', `  ${t.accent('◆')} New session ${t.bold(s.id)}`, ''] };
    }
    case 'sessions': {
      const rows = ruby.store.listSessions(15);
      if (!rows.length) return { rows: (w: number) => ['', t.muted('  No sessions yet.')] };
      const list = (w: number) => rows.map((s) => {
        const mark = s.id === ctx.sessionId ? t.accent('●') : ' ';
        return truncate(`  ${mark} ${padEnd(s.id, 30)} ${t.muted(s.updatedAt.replace('T', ' ').slice(0, 16))}  ${sanitize(s.title ?? '')}`, w);
      });
      return { rows: (w: number) => ['', t.bold('  Recent sessions'), ...list(w), t.muted('  /resume <id> to switch (Tab completes ids)'), ''] };
    }
    case 'resume': {
      if (!args) return { rows: (w: number) => ['', t.muted('  Usage: /resume <session-id>  (see /sessions)')] };
      const s = ruby.store.getSession(args);
      if (!s) return { rows: (w: number) => ['', `  ${t.error('✗')} No session "${sanitize(args)}". See /sessions.`] };
      ctx.switchTo(s.id);
      const events = ruby.store.events(s.id);
      return { rows: (w: number) => ['', ...transcriptRows(events, t, w), `  ${t.accent('◆')} Resumed ${t.bold(s.id)}`, ''] };
    }
    case 'model': {
      const m = ruby.model;
      const row = (k: string, v: string) => `  ${padEnd(k, 16)}${v}`;
      return {
        rows: (w: number) => [
          '', t.bold('  Model'),
          row('id', m.id),
          row('context window', `${formatTokens(m.capabilities.contextWindow)} tokens`),
          row('max output', `${formatTokens(ruby.config.model.maxOutputTokens)} tokens per model call`),
          row('streaming', m.capabilities.streaming ? 'yes' : 'no'),
          row('prompt caching', m.capabilities.promptCaching ? 'yes' : 'no'),
          ...wrapText(t.muted('  The model is set in config.json (model.provider, model.name) and fixed for this chat; restart to change it.'), w),
          '',
        ],
      };
    }
    case 'usage': {
      const totals = sessionTotals(ruby.store.events(ctx.sessionId));
      const u = totals.usage;
      const b = ruby.config.budgets;
      const row = (k: string, v: string) => `  ${padEnd(k, 18)}${v}`;
      const window = ruby.model.capabilities.contextWindow;
      return {
        rows: (w: number) => [
          '', t.bold('  This session'),
          row('input', `${formatTokens(u.inputTokens)} tokens`),
          row('cache read', `${formatTokens(u.cacheReadTokens)} tokens`),
          row('cache write', `${formatTokens(u.cacheWriteTokens)} tokens`),
          row('output', `${formatTokens(u.outputTokens)} tokens`),
          row('context (latest)', totals.contextTokens === null ? 'unknown' : `${formatTokens(totals.contextTokens)} of ${formatTokens(window)}`),
          '', t.bold('  Budget per task'),
          row('tokens', formatTokens(b.maxTokens)),
          row('model calls', String(b.maxModelCalls)),
          row('tool calls', String(b.maxToolCalls)),
          row('time', formatDuration(b.maxWallMs)),
          ...wrapText(t.muted('  "?" means the provider did not report a value; Ruby never counts unknown as zero.'), w),
          '',
        ],
      };
    }
    case 'compact': {
      const outcome = await ruby.agent.compact(ctx.sessionId, ctx.signal ? { signal: ctx.signal } : {});
      const msg = {
        compacted: `${t.ok('✓')} Compacted older turns into a summary; the next message starts from it.`,
        nothing_to_compact: `${t.muted('·')} Nothing to compact yet: only the most recent turns are in the history.`,
        failed: `${t.error('✗')} Compaction failed; the full history is kept.`,
      }[outcome.status];
      return { rows: (w: number) => ['', ...wrapText(`  ${msg}`, w), ''] };
    }
    case 'expand': {
      const n = args ? Number(args) : 1;
      const log = ctx.toolLog;
      const entry = Number.isInteger(n) && n >= 1 ? log[log.length - n] : undefined;
      if (!entry) return { rows: (w: number) => ['', t.muted(log.length ? `  Use /expand 1 to /expand ${log.length}.` : '  No tool calls in this chat yet.')] };
      return { rows: (w: number) => ['', ...toolExpandedRows(entry.call, entry.result, t, w), ''] };
    }
  }
  return { rows: none };
}
