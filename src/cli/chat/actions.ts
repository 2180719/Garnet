// Executes slash commands against Ruby. Shared by the interactive and plain chats.

import type { ToolCallBlock, ToolResult } from '../../contracts/index.ts';
import type { Ruby } from '../../main.ts';
import type { ParsedSlash } from './commands.ts';
import { helpRows, sessionTotals, toolExpandedRows, transcriptRows } from './render.ts';
import { formatDuration, formatTokens, padEnd, truncate, wrapText } from './text.ts';
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

export type CommandResult = { rows: string[]; effect?: 'exit' | 'clear' };

export async function executeCommand(parsed: NonNullable<ParsedSlash>, ctx: CommandContext): Promise<CommandResult> {
  const { ruby, theme: t, width: w } = ctx;
  if ('unknown' in parsed) return { rows: ['', `  ${t.error('✗')} Unknown command /${parsed.unknown}. Type ${t.bold('/help')} for the list.`] };
  const { command, args } = parsed;
  switch (command.name) {
    case 'help':
      return { rows: helpRows(t, w) };
    case 'exit':
      return { rows: [], effect: 'exit' };
    case 'clear':
      return { rows: [], effect: 'clear' };
    case 'new': {
      const s = ruby.store.createSession('Terminal chat');
      ctx.switchTo(s.id);
      return { rows: ['', `  ${t.accent('◆')} New session ${t.bold(s.id)}`, ''] };
    }
    case 'sessions': {
      const rows = ruby.store.listSessions(15);
      if (!rows.length) return { rows: ['', t.muted('  No sessions yet.')] };
      const list = rows.map((s) => {
        const mark = s.id === ctx.sessionId ? t.accent('●') : ' ';
        return truncate(`  ${mark} ${padEnd(s.id, 30)} ${t.muted(s.updatedAt.replace('T', ' ').slice(0, 16))}  ${s.title ?? ''}`, w);
      });
      return { rows: ['', t.bold('  Recent sessions'), ...list, t.muted('  /resume <id> to switch (Tab completes ids)'), ''] };
    }
    case 'resume': {
      if (!args) return { rows: ['', t.muted('  Usage: /resume <session-id>  (see /sessions)')] };
      const s = ruby.store.getSession(args);
      if (!s) return { rows: ['', `  ${t.error('✗')} No session "${args}". See /sessions.`] };
      ctx.switchTo(s.id);
      return { rows: ['', ...transcriptRows(ruby.store.events(s.id), t, w), `  ${t.accent('◆')} Resumed ${t.bold(s.id)}`, ''] };
    }
    case 'model': {
      const m = ruby.model;
      const row = (k: string, v: string) => `  ${padEnd(k, 16)}${v}`;
      return {
        rows: [
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
        rows: [
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
      return { rows: ['', ...wrapText(`  ${msg}`, w), ''] };
    }
    case 'expand': {
      const n = args ? Number(args) : 1;
      const log = ctx.toolLog;
      const entry = Number.isInteger(n) && n >= 1 ? log[log.length - n] : undefined;
      if (!entry) return { rows: ['', t.muted(log.length ? `  Use /expand 1 to /expand ${log.length}.` : '  No tool calls in this chat yet.')] };
      return { rows: ['', ...toolExpandedRows(entry.call, entry.result, t, w), ''] };
    }
  }
  return { rows: [] };
}
