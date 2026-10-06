// Executes slash commands against Garnet. Shared by the interactive and plain chats.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { errorMessage, formatBytes, formatUsd, startOfDayIso, type ContentBlock, type ToolCallBlock, type ToolResult } from '../../contracts/index.ts';
import { detectMime } from '../../media/index.ts';
import type { Garnet } from '../../main.ts';
import { StatsStore } from '../../store/index.ts';
import type { ParsedSlash } from './commands.ts';
import { helpRows, sessionTotals, toolExpandedRows, transcriptRows } from './render.ts';
import { formatDuration, formatTokens, padEnd, sanitize, truncate, wrapText } from './text.ts';
import type { Theme } from './theme.ts';

export type CommandContext = {
  garnet: Garnet;
  sessionId: string;
  theme: Theme;
  width: number;
  toolLog: readonly { call: ToolCallBlock; result: ToolResult }[];
  /** Makes `id` the active session. */
  switchTo: (id: string) => void;
  signal?: AbortSignal;
  /** Files attached with /attach, sent with the next message. Owned by the chat; this list is changed in place. */
  attachments?: PendingFile[];
};

export type PendingFile = { data: Uint8Array; name: string; mimeType: string };

/**
 * The turn for a message plus files attached with /attach: stored, transcribed
 * or extracted by the media ingest. `reply` is an honest answer when nothing
 * in it is readable (then the model is not called).
 */
export async function prepareTurn(
  garnet: Garnet,
  sessionId: string,
  text: string,
  files: PendingFile[],
  signal: AbortSignal,
): Promise<{ turn: string | ContentBlock[] } | { reply: string }> {
  if (files.length === 0 || !garnet.media) return { turn: text };
  const blocks: ContentBlock[] = [...(text ? [{ type: 'text' as const, text }] : []), ...(await garnet.media.ingest(files, { sessionId, signal }))];
  const reply = garnet.media.unreadableReply(blocks);
  return reply ? { reply } : { turn: blocks };
}

/** Accepts what a terminal pastes for a dropped file: quotes, backslash-escaped spaces, a leading ~. */
export function pastedPath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) p = p.slice(1, -1);
  else p = p.replace(/\\(.)/g, '$1');
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice('file://'.length));
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  return resolve(p);
}

/** `rows` renders the output at a width, so a narrower terminal can redraw it cleanly. */
export type CommandResult = { rows: (width: number) => string[]; effect?: 'exit' | 'clear' };

const none = (): string[] => [];

export async function executeCommand(parsed: NonNullable<ParsedSlash>, ctx: CommandContext): Promise<CommandResult> {
  const { garnet, theme: t } = ctx;
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
      const s = garnet.store.createSession('Terminal chat');
      ctx.switchTo(s.id);
      return { rows: (w: number) => ['', `  ${t.accent('◆')} New session ${t.bold(s.id)}`, ''] };
    }
    case 'sessions': {
      const rows = garnet.store.listSessions(15);
      if (!rows.length) return { rows: (w: number) => ['', t.muted('  No sessions yet.')] };
      const list = (w: number) => rows.map((s) => {
        const mark = s.id === ctx.sessionId ? t.accent('●') : ' ';
        return truncate(`  ${mark} ${padEnd(s.id, 30)} ${t.muted(s.updatedAt.replace('T', ' ').slice(0, 16))}  ${sanitize(s.title ?? '')}`, w);
      });
      return { rows: (w: number) => ['', t.bold('  Recent sessions'), ...list(w), t.muted('  /resume <id> to switch (Tab completes ids)'), ''] };
    }
    case 'resume': {
      if (!args) return { rows: (w: number) => ['', t.muted('  Usage: /resume <session-id>  (see /sessions)')] };
      const s = garnet.store.getSession(args);
      if (!s) return { rows: (w: number) => ['', `  ${t.error('✗')} No session "${sanitize(args)}". See /sessions.`] };
      ctx.switchTo(s.id);
      const events = garnet.store.events(s.id);
      return { rows: (w: number) => ['', ...transcriptRows(events, t, w), `  ${t.accent('◆')} Resumed ${t.bold(s.id)}`, ''] };
    }
    case 'model': {
      const m = garnet.model;
      const row = (k: string, v: string) => `  ${padEnd(k, 16)}${v}`;
      return {
        rows: (w: number) => [
          '', t.bold('  Model'),
          row('id', m.id),
          row('context window', `${formatTokens(m.capabilities.contextWindow)} tokens`),
          row('max output', `${formatTokens(garnet.config.model.maxOutputTokens)} tokens per model call`),
          row('streaming', m.capabilities.streaming ? 'yes' : 'no'),
          row('prompt caching', m.capabilities.promptCaching ? 'yes' : 'no'),
          ...wrapText(t.muted('  The model is set in config.json (model.provider, model.name) and fixed for this chat; restart to change it.'), w),
          '',
        ],
      };
    }
    case 'usage': {
      const totals = sessionTotals(garnet.store.events(ctx.sessionId), garnet.pricing);
      const today = new StatsStore(garnet.db).knownCostSince(startOfDayIso(garnet.timezone), garnet.pricing);
      const u = totals.usage;
      const b = garnet.config.budgets;
      const row = (k: string, v: string) => `  ${padEnd(k, 18)}${v}`;
      const window = garnet.model.capabilities.contextWindow;
      return {
        rows: (w: number) => [
          '', t.bold('  This session'),
          row('input', `${formatTokens(u.inputTokens)} tokens`),
          row('cache read', `${formatTokens(u.cacheReadTokens)} tokens`),
          row('cache write', `${formatTokens(u.cacheWriteTokens)} tokens`),
          row('output', `${formatTokens(u.outputTokens)} tokens`),
          row('cost', formatUsd(totals.costUsd)),
          row(`cost today (${garnet.timezone})`, `${formatUsd(today)}${b.dailyUsd === undefined ? '' : ` of ${formatUsd(b.dailyUsd)} cap`}`),
          row('context (latest)', totals.contextTokens === null ? 'unknown' : `${formatTokens(totals.contextTokens)} of ${formatTokens(window)}`),
          '', t.bold('  Budget per task'),
          row('tokens', formatTokens(b.maxTokens)),
          row('model calls', String(b.maxModelCalls)),
          row('tool calls', String(b.maxToolCalls)),
          row('time', formatDuration(b.maxWallMs)),
          ...wrapText(t.muted(`  "?" means the provider did not report a value${garnet.pricing ? '' : ' or the model has no known price (set model.pricing in config.json)'}; Garnet never counts unknown as zero.`), w),
          '',
        ],
      };
    }
    case 'attach': {
      const pending = ctx.attachments;
      const media = garnet.media;
      if (!media || !pending) return { rows: (w: number) => ['', `  ${t.error('✗')} Attachments are off (media.enabled in config.json).`] };
      if (!args) {
        if (!pending.length) return { rows: (w: number) => ['', t.muted('  Usage: /attach <path>  (drag a file into the terminal to paste its path). /attach clear removes attached files.')] };
        return { rows: (w: number) => ['', t.bold('  Attached to your next message'), ...pending.map((f) => truncate(`  · ${sanitize(f.name)} ${t.muted(`${f.mimeType}, ${formatBytes(f.data.byteLength)}`)}`, w)), ''] };
      }
      if (args === 'clear') {
        const n = pending.splice(0).length;
        return { rows: (w: number) => ['', t.muted(`  Removed ${n} attached file(s).`)] };
      }
      const path = pastedPath(args);
      try {
        const info = await stat(path);
        if (!info.isFile()) return { rows: (w: number) => ['', `  ${t.error('✗')} ${sanitize(path)} is not a file.`] };
        if (info.size > media.maxBytes) {
          return { rows: (w: number) => ['', `  ${t.error('✗')} ${sanitize(basename(path))} is ${formatBytes(info.size)}; the limit is ${formatBytes(media.maxBytes)} (media.maxBytes).`] };
        }
        const data = new Uint8Array(await readFile(path));
        const file = { data, name: basename(path), mimeType: detectMime(data, undefined, basename(path)) };
        pending.push(file);
        return {
          rows: (w: number) => ['', ...wrapText(`  ${t.accent('+')} Attached ${t.bold(sanitize(file.name))} ${t.muted(`(${file.mimeType}, ${formatBytes(data.byteLength)})`)}. It goes with your next message.`, w), ''],
        };
      } catch (e) {
        return { rows: (w: number) => ['', `  ${t.error('✗')} Cannot read ${sanitize(path)}: ${sanitize(errorMessage(e))}`] };
      }
    }
    case 'compact': {
      const outcome = await garnet.agent.compact(ctx.sessionId, ctx.signal ? { signal: ctx.signal } : {});
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
