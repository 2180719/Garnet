// Pure renderers for the chat's visual blocks. Each returns terminal rows.

import { addUsage, billedTokens, costOf, eventsCost, formatUsd, type Pricing, unknownUsage, type SessionEvent, type TaskRecord, type ToolCallBlock, type ToolResult, type Usage } from '../../contracts/index.ts';
import type { ApprovalRequest } from '../../policy/index.ts';
import { COMMANDS, SCROLL_SHORTCUTS, SHORTCUTS, type SlashCommand } from './commands.ts';
import { renderMarkdown } from './markdown.ts';
import { displayWidth, formatDuration, formatTokens, padEnd, sanitize, truncate, wrapText } from './text.ts';
import type { Theme } from './theme.ts';

export const MARK = '◆';
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Prefixes rows: `first` on row 0, `rest` on the others. */
export function prefixRows(rows: string[], first: string, rest: string): string[] {
  return rows.map((r, i) => (i === 0 ? first : rest) + r);
}

export function banner(theme: Theme, width: number, model: string, sessionId: string, resumed: boolean): string[] {
  const rule = theme.rule('─'.repeat(Math.min(width, 48)));
  return [
    `${theme.bold(theme.accent(`${MARK} GARNET`))} ${theme.muted('/ terminal chat')}`,
    rule,
    truncate(`${theme.muted('model')}   ${model}`, width),
    truncate(`${theme.muted('session')} ${sessionId}${resumed ? theme.muted(' (resumed)') : ''}`, width),
    theme.muted(truncate('/help for commands · Esc interrupts · Ctrl+D exits', width)),
  ];
}

/** The owner's message as it stays in the scrollback. */
export function userBlock(text: string, theme: Theme, width: number, source?: string): string[] {
  const label = source && source !== 'cli' ? theme.muted(` [${source}]`) : '';
  const rows = sanitize(text).split('\n').flatMap((l) => wrapText(l, width - 2));
  return ['', ...prefixRows(rows.map((r, i) => theme.bold(r) + (i === rows.length - 1 ? label : '')), `${theme.accent('›')} `, '  ')];
}

/** Assistant markdown with the Garnet mark on the first row. */
export function assistantRows(rows: string[], theme: Theme, first: boolean): string[] {
  return prefixRows(rows, first ? `${theme.accent(MARK)} ` : '  ', '  ');
}

const KEY_ARGS = ['command', 'path', 'url', 'query', 'pattern', 'name', 'skill', 'id', 'action'];

/** `read_file notes.md` — the tool name and its most telling argument. */
export function describeCall(call: ToolCallBlock): string {
  const input = call.input;
  let arg = '';
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const k = KEY_ARGS.find((key) => typeof obj[key] === 'string' && obj[key]);
    arg = k ? String(obj[k]) : Object.keys(obj).length ? JSON.stringify(obj) : '';
  } else if (input !== undefined && input !== null) {
    arg = typeof input === 'string' ? input : JSON.stringify(input);
  }
  return sanitize(arg ? `${call.name} ${arg.replace(/\s+/g, ' ')}` : call.name);
}

export function toolRunningRow(call: ToolCallBlock, frame: string, elapsedMs: number, theme: Theme, width: number): string {
  const tail = theme.muted(` · ${formatDuration(elapsedMs)}`);
  return `  ${theme.accent(frame)} ${truncate(theme.bold(describeCall(call)), width - 6 - displayWidth(tail))}${tail}`;
}

/**
 * A finished tool call: status, name and argument, then up to `preview`
 * rows of output. Status is spelled out, never shown by color alone.
 */
export function toolDoneRows(call: ToolCallBlock, result: ToolResult, theme: Theme, width: number, preview = 3): string[] {
  const ok = result.status === 'ok';
  const icon = ok ? theme.ok('✓') : theme.error('✗');
  const meta = ok
    ? theme.muted(` · ${formatDuration(result.durationMs)}${result.truncated ? ' · truncated' : ''}`)
    : ` ${theme.error(result.category === 'denied' ? 'denied' : `failed (${result.category})`)}`;
  const head = `  ${icon} ${truncate(theme.bold(describeCall(call)), width - 6 - displayWidth(meta))}${meta}`;
  const body = sanitize(result.content).replace(/\s+$/, '');
  if (!body || preview <= 0) return [head];
  const lines = body.split('\n');
  const shown = lines.slice(0, preview).map((l) => truncate(l.replace(/\t/g, '    '), width - 6));
  const rows = prefixRows(shown.map((l) => (ok ? theme.muted(l) : theme.error(l))), `    ${theme.rule('⎿')} `, '      ');
  const more = lines.length - preview;
  if (more > 0) rows.push(theme.muted(`      … ${more} more line${more === 1 ? '' : 's'} (/expand)`));
  if (result.artifactId) rows.push(theme.muted(`      full output saved as ${result.artifactId}`));
  return [head, ...rows];
}

/** Full output of a tool call for /expand. */
export function toolExpandedRows(call: ToolCallBlock, result: ToolResult, theme: Theme, width: number): string[] {
  const rows = [`  ${theme.bold(describeCall(call))} ${theme.muted(result.status === 'ok' ? '(ok)' : `(${result.category})`)}`];
  const input = sanitize(JSON.stringify(call.input, null, 2) ?? '');
  rows.push(theme.muted('  input'));
  for (const l of input.split('\n')) rows.push(...wrapText(l, width - 4).map((r) => `    ${theme.muted(r)}`));
  rows.push(theme.muted('  output'));
  for (const l of sanitize(result.content || '(empty)').split('\n')) rows.push(...wrapText(l.replace(/\t/g, '    '), width - 4).map((r) => `    ${r}`));
  return rows;
}

export function turnSummary(task: TaskRecord, elapsedMs: number, theme: Theme, width: number, pricing?: Pricing): string[] {
  const u = task.usage;
  const tools = task.toolCalls ? ` · ${task.toolCalls} tool call${task.toolCalls === 1 ? '' : 's'}` : '';
  const cached = u.cacheReadTokens ? ` (${formatTokens(u.cacheReadTokens)} cached)` : '';
  const tokens = ` · ${formatTokens(u.inputTokens)} in${cached} · ${formatTokens(u.outputTokens)} out${task.modelCalls ? ` · ${formatUsd(costOf(u, pricing))}` : ''}`;
  const stats = `${formatDuration(elapsedMs)}${tools}${tokens}`;
  const status = statusLabel(task.status, theme);
  const reason = task.reason ? ` — ${sanitize(task.reason)}` : '';
  return ['', ...hangingRows(`  ${status} `, theme.muted(`· ${stats}${reason}`), width)];
}

export function statusLabel(status: TaskRecord['status'], theme: Theme): string {
  switch (status) {
    case 'completed':
      return theme.ok('✓ done');
    case 'cancelled':
      return theme.warn('■ interrupted');
    case 'budget_exhausted':
      return theme.warn('■ budget reached');
    case 'waiting_for_approval':
      return theme.warn('■ waiting for approval');
    case 'waiting_for_user':
      return theme.warn('■ waiting for you');
    case 'failed':
      return theme.error('✗ failed');
    default:
      return theme.muted(status);
  }
}

/** Committed to the scrollback when a tool asks for approval. The full summary is shown, never truncated. */
export function approvalRows(req: ApprovalRequest, theme: Theme, width: number): string[] {
  const head = hangingRows(`  ${theme.warn('?')} `, `${theme.bold(sanitize(req.tool))} ${theme.muted(`needs approval (${req.capability})`)}`, width);
  const body = sanitize(req.summary).split('\n').flatMap((l) => wrapText(l, width - 6)).map((r) => `    ${theme.rule('│')} ${r}`);
  return ['', ...head, ...body];
}

export function approvalChoices(req: ApprovalRequest, theme: Theme, width: number): string[] {
  // After untrusted content, every escalated operation is decided on its own: no standing "always".
  if (req.taint?.length) return hangingRows(`  ${theme.warn('Allow?')} `, `${theme.bold('y')} allow once · ${theme.bold('n')} deny`, width);
  const always = req.capability === 'exec' ? 'this exact command' : sanitize(req.tool);
  const choices = `${theme.bold('y')} allow once · ${theme.bold('a')} always allow ${always} in this chat · ${theme.bold('n')} deny`;
  return hangingRows(`  ${theme.warn('Allow?')} `, choices, width);
}

export function approvalOutcome(decision: 'once' | 'always' | 'denied', theme: Theme): string {
  if (decision === 'denied') return `    ${theme.error('✗ denied')}`;
  return `    ${theme.ok('✓ approved')}${theme.muted(decision === 'always' ? ' (for the rest of this chat)' : ' (once)')}`;
}

export type SessionTotals = {
  usage: Usage;
  contextTokens: number | null;
  turns: number;
  /** Sources of untrusted content this session has read (empty: none). */
  untrusted: string[];
  /** USD for the session's model calls; null if unknown (no price, or unreported tokens). */
  costUsd: number | null;
};

/** Token totals for a session (assistant turns and compaction calls) and the size of the latest request. */
export function sessionTotals(events: SessionEvent[], pricing?: Pricing): SessionTotals {
  let usage = unknownUsage();
  let contextTokens: number | null = null;
  let turns = 0;
  const untrusted: string[] = [];
  for (const e of events) {
    if (e.type === 'assistant_message') {
      usage = addUsage(usage, e.usage);
      const u = e.usage;
      contextTokens = u.inputTokens === null && u.cacheReadTokens === null ? null : (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) + (u.outputTokens ?? 0);
    } else if (e.type === 'checkpoint') {
      usage = addUsage(usage, e.usage);
      contextTokens = null; // unknown until the next request
    } else if (e.type === 'user_message') {
      turns++;
    } else if (e.type === 'tainted' && !untrusted.includes(e.source)) {
      untrusted.push(e.source);
    }
  }
  return { usage, contextTokens, turns, untrusted, costUsd: eventsCost(events, pricing) };
}

export type FooterInfo = { model: string; sessionId: string; totals: SessionTotals; contextWindow: number; notice?: string | undefined };

/** Context use, tokens and cost in words. Unknown values are "?", never 0. */
function usageStats(t: SessionTotals, contextWindow: number, unknownCost: boolean): string[] {
  const stats: string[] = [];
  if (t.contextTokens !== null) {
    const pct = Math.round((t.contextTokens / contextWindow) * 100);
    stats.push(`context ${formatTokens(t.contextTokens)}/${formatTokens(contextWindow)} (${pct}%)`);
  }
  if (t.turns) stats.push(`${formatTokens(billedTokens(t.usage))} tokens`);
  if (t.turns && (t.costUsd !== null || unknownCost)) stats.push(t.costUsd === null ? 'cost ?' : formatUsd(t.costUsd));
  return stats;
}

export function footer(info: FooterInfo, theme: Theme, width: number): string {
  if (info.notice) return truncate(`  ${info.notice}`, width);
  const t = info.totals;
  const stats: string[] = [];
  // Spelled out, not just colored: risky actions now ask first (see taintedRows).
  if (t.untrusted.length) stats.push('⚠ untrusted content read');
  // The exact cost or "?" is in /usage; the footer has little room, so an unknown cost is left out.
  stats.push(...usageStats(t, info.contextWindow, false));
  // Most detail that fits; the least useful parts go first when narrow.
  const variants = [
    [info.model, info.sessionId, ...stats, '/help'],
    [info.model, info.sessionId, ...stats],
    [info.sessionId, ...stats],
    [info.model, ...stats],
    stats.length ? stats : [info.model],
  ];
  const text = variants.map((v) => `  ${v.join(' · ')}`).find((v) => displayWidth(v) <= width) ?? `  ${variants.at(-1)!.join(' · ')}`;
  return theme.muted(truncate(text, width));
}

export type StatusInfo = {
  /** The assistant's name (persona). */
  name: string;
  model: string;
  sessionId: string;
  totals: SessionTotals;
  contextWindow: number;
  /** What the chat is doing, in words: "ready", "thinking", "running read_file", ... */
  state: string;
  /** True while a turn runs; false when idle. */
  busy: boolean;
  /** An approval is waiting for the owner. */
  approval: boolean;
};

/**
 * The fullscreen status bar. `full` is two rows and a rule: name, model,
 * session and state; then the taint warning, context, tokens and cost.
 * `compact` is one row for short terminals and keeps the name, the state
 * and the taint warning. Every state is in words, not color alone.
 */
export function statusBar(info: StatusInfo, theme: Theme, width: number): { full: string[]; compact: string[] } {
  const state = info.approval
    ? theme.warn(`? ${info.state}`)
    : info.busy ? `${theme.accent('●')} ${info.state}` : theme.muted(`○ ${info.state}`);
  const name = theme.bold(theme.accent(`${MARK} ${sanitize(info.name)}`));
  const taint = info.totals.untrusted.length ? theme.warn('⚠ untrusted content read') : '';
  // The most detail that fits on the left, the state always on the right.
  const line = (variants: string[][], right: string): string => {
    const room = width - 2 - displayWidth(right);
    const joined = variants.map((parts) => parts.join(theme.muted(' · ')));
    const head = joined.find((v) => displayWidth(v) <= room - 2) ?? truncate(joined.at(-1)!, Math.max(0, room - 2));
    return truncate(`  ${padEnd(head, room)}${right}`, width);
  };
  const model = theme.muted(info.model);
  const row0 = line([[name, model, theme.muted(info.sessionId)], [name, model], [name]], state);
  const stats = usageStats(info.totals, info.contextWindow, true);
  const row1 = truncate(`  ${[taint, ...stats.map((s) => theme.muted(s))].filter(Boolean).join(theme.muted(' · ')) || theme.muted('/help for commands')}`, width);
  const compact = line(taint ? [[name, taint, model], [name, taint], [taint]] : [[name, model], [name]], state);
  return { full: [row0, row1, theme.rule('─'.repeat(width))], compact: [compact] };
}

/** The last transcript row while scrolled up: says there is more below and how to get back. */
export function scrollIndicator(below: number, unseen: number, theme: Theme, width: number): string {
  const lines = `${below} line${below === 1 ? '' : 's'}`;
  const text = unseen > 0 ? `↓ new messages below (${lines}) · PgDn or Ctrl+End to follow` : `↓ ${lines} below · PgDn or Ctrl+End to follow`;
  return truncate(`  ${unseen > 0 ? theme.accent(text) : theme.muted(text)}`, width);
}

/** The fullscreen footer: a notice, or the keys that matter there. */
export function fullscreenFooter(info: { notice?: string | undefined; mouse: boolean }, theme: Theme, width: number): string {
  if (info.notice) return truncate(`  ${info.notice}`, width);
  const mouse = `F2 mouse ${info.mouse ? 'on' : 'off'}`;
  const variants = [
    ['PgUp/PgDn scroll', mouse, '/help', 'Ctrl+D exits'],
    ['PgUp/PgDn scroll', mouse, '/help'],
    ['PgUp/PgDn', mouse],
    ['/help'],
  ].map((v) => `  ${v.join(' · ')}`);
  return theme.muted(truncate(variants.find((v) => displayWidth(v) <= width) ?? variants.at(-1)!, width));
}

/** Committed when untrusted content first enters the conversation from a source. */
export function taintedRows(source: string, first: boolean, theme: Theme, width: number): string[] {
  const why = first ? ' From now on in this conversation, risky actions ask first (/new starts clean).' : '';
  return hangingRows(`  ${theme.warn('⚠')} `, theme.muted(`Read untrusted content: ${sanitize(source)}.${why}`), width);
}

/** `lead` then `text` wrapped so continuation rows align under the text. */
export function hangingRows(lead: string, text: string, width: number): string[] {
  const indent = displayWidth(lead);
  if (width - indent < 8) return wrapText(lead + text, width);
  return prefixRows(wrapText(text, width - indent), lead, ' '.repeat(indent));
}

/** The command palette under the input while a /command is being typed. */
export function suggestionRows(commands: readonly SlashCommand[], theme: Theme, width: number): string[] {
  const usage = (c: SlashCommand) => `/${c.name}${c.args ? ` ${c.args}` : ''}`;
  const col = Math.max(...commands.map((c) => usage(c).length)) + 2;
  return commands.map((c) =>
    width - 2 - col >= 12 ? truncate(`  ${theme.accent(padEnd(usage(c), col))}${theme.muted(c.description)}`, width) : truncate(`  ${theme.accent(usage(c))}`, width),
  );
}

export function helpRows(theme: Theme, width: number, fullscreen = false): string[] {
  const usage = (c: SlashCommand) => `/${c.name}${c.args ? ` ${c.args}` : ''}`;
  const col = Math.max(...COMMANDS.map((c) => usage(c).length)) + 2;
  const rows = ['', theme.bold('  Commands')];
  for (const c of COMMANDS) {
    const aliases = c.aliases?.length ? theme.muted(` (also ${c.aliases.map((a) => `/${a}`).join(', ')})`) : '';
    rows.push(...hangingRows(`  ${theme.accent(padEnd(usage(c), col))}`, `${c.description}${aliases}`, width));
  }
  const section = (title: string, keys: readonly (readonly [string, string])[]) => {
    rows.push('', theme.bold(`  ${title}`));
    const kcol = Math.min(24, Math.max(...keys.map(([k]) => k.length)) + 2);
    for (const [k, d] of keys) {
      if (k.length + 2 > kcol) rows.push(...wrapText(`  ${theme.muted(k)}`, width), ...hangingRows(' '.repeat(kcol + 2), d, width));
      else rows.push(...hangingRows(`  ${theme.muted(padEnd(k, kcol))}`, d, width));
    }
  };
  section('Keys', SHORTCUTS);
  if (fullscreen) section('Scrolling', SCROLL_SHORTCUTS);
  return [...rows, ''];
}

/** Recent turns of a session, for resuming: user messages, assistant text and tool calls. */
export function transcriptRows(events: SessionEvent[], theme: Theme, width: number, maxTurns = 6): string[] {
  const userSeqs = events.filter((e) => e.type === 'user_message').map((e) => e.seq);
  const from = userSeqs.length > maxTurns ? userSeqs[userSeqs.length - maxTurns]! : 0;
  const rows: string[] = [];
  const hidden = Math.max(0, userSeqs.length - maxTurns);
  if (hidden) rows.push(theme.muted(`  … ${hidden} earlier turn${hidden === 1 ? '' : 's'} not shown`));
  const calls = new Map<string, ToolCallBlock>();
  for (const e of events) {
    if (e.seq < from) continue;
    if (e.type === 'user_message') {
      const text = e.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      rows.push(...userBlock(text, theme, width, e.source));
      rows.push('');
    } else if (e.type === 'assistant_message') {
      const text = e.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (text.trim()) rows.push(...assistantRows(renderMarkdown(text, width - 2, theme), theme, true));
    } else if (e.type === 'tool_started') {
      calls.set(e.call.id, e.call);
    } else if (e.type === 'tool_finished') {
      const call = calls.get(e.callId);
      if (call) rows.push(...toolDoneRows(call, e.result, theme, width, 0));
    } else if (e.type === 'checkpoint') {
      rows.push(theme.muted('  ── earlier turns were compacted into a summary ──'));
    } else if (e.type === 'tainted') {
      rows.push(...taintedRows(e.source, false, theme, width));
    } else if (e.type === 'task_status' && e.status !== 'completed' && e.status !== 'running') {
      rows.push(`  ${statusLabel(e.status, theme)}${e.reason ? theme.muted(` — ${sanitize(e.reason)}`) : ''}`);
    }
  }
  if (rows.length) rows.push('', theme.rule('  ─── resumed ───'), '');
  return rows;
}
