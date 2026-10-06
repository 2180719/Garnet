// Lightweight, line-oriented markdown rendering for assistant text. Pure.
// Supports headings, paragraphs, bold/italic/strike, inline code, links,
// bullet/ordered/task lists, blockquotes, rules, fenced code and pipe tables.
// It renders as text arrives: complete lines are final, the partial last
// line is shown provisionally.

import { displayWidth, padEnd, wrapText } from './text.ts';
import type { Theme } from './theme.ts';

/** Inline markdown → styled text. Code spans are protected from other rules. */
export function renderInline(text: string, theme: Theme): string {
  const codes: string[] = [];
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
    const body = code.length > 2 && code.startsWith(' ') && code.endsWith(' ') ? code.slice(1, -1) : code;
    codes.push(theme.color ? theme.code(body) : `\`${body}\``);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => (label === url ? theme.underline(url) : `${theme.underline(label)}${theme.muted(` (${url})`)}`))
    .replace(/\*\*\*(?=\S)([^*\n]*?\S)\*\*\*/g, (_, t: string) => theme.bold(theme.italic(t)))
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, (_, t: string) => theme.bold(t))
    .replace(/(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, (_, t: string) => theme.bold(t))
    .replace(/(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, (_, t: string) => theme.italic(t))
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, (_, t: string) => theme.italic(t))
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, (_, t: string) => theme.strike(t));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * Renders markdown incrementally. `push` returns rows that are final;
 * `pending` returns provisional rows for text that may still change.
 */
export class MarkdownStream {
  private readonly theme: Theme;
  private width: number;
  private partial = '';
  private fence: { marker: string; indent: number } | null = null;
  private table: string[] = [];
  private lastBlank = true; // suppress leading and repeated blank rows
  /** A blank row is emitted only once more content follows, so output never ends with one. */
  private blankPending = false;

  constructor(options: { width: number; theme: Theme }) {
    this.width = Math.max(10, options.width);
    this.theme = options.theme;
  }

  /** Width for future rows (terminal resize). Committed rows are not re-rendered. */
  setWidth(width: number): void {
    this.width = Math.max(10, width);
  }

  push(text: string): string[] {
    this.partial += text.replace(/\r\n?/g, '\n');
    const rows: string[] = [];
    let nl: number;
    while ((nl = this.partial.indexOf('\n')) !== -1) {
      const line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      rows.push(...this.line(line));
    }
    return rows;
  }

  /** Provisional rows: a table still being written, then the partial line. */
  pending(): string[] {
    const rows: string[] = [];
    if (this.table.length) rows.push(...this.table.flatMap((l) => wrapText(this.theme.muted(l), this.width)));
    if (this.partial) {
      // Render the partial line as if complete, without changing state.
      const saved = { fence: this.fence, table: this.table, lastBlank: this.lastBlank, blankPending: this.blankPending };
      this.table = [];
      rows.push(...this.line(this.partial, true));
      this.fence = saved.fence;
      this.table = saved.table;
      this.lastBlank = saved.lastBlank;
      this.blankPending = saved.blankPending;
    }
    return rows;
  }

  /** Commits everything, including a partial line and an open table. */
  finish(): string[] {
    const rows = this.partial ? this.push('\n') : [];
    rows.push(...this.flushTable());
    this.blankPending = false;
    return rows;
  }

  private line(raw: string, provisional = false): string[] {
    const t = this.theme;
    const w = this.width;
    // Fenced code.
    if (this.fence) {
      const close = FENCE.exec(raw);
      if (close && close[2]!.startsWith(this.fence.marker[0]!) && close[2]!.length >= this.fence.marker.length && !close[3]) {
        this.fence = null;
        return this.emit([t.rule('╰─')]);
      }
      const code = raw.slice(Math.min(this.fence.indent, raw.length - raw.trimStart().length));
      return this.emit(hardWrap(code, w - 2).map((r) => `${t.rule('│')} ${t.code(r)}`));
    }
    const fence = FENCE.exec(raw);
    if (fence) {
      if (!provisional) this.fence = { marker: fence[2]!, indent: fence[1]!.length };
      return [...this.flushTable(), ...this.emit([t.rule('╭─') + (fence[3] ? ` ${t.muted(fence[3])}` : '')])];
    }
    // Tables are held until they end so columns can be aligned.
    if (TABLE_ROW.test(raw) && !provisional) {
      this.table.push(raw);
      return [];
    }
    const rows = this.flushTable();
    if (TABLE_ROW.test(raw)) return [...rows, ...this.emit(wrapText(t.muted(raw), w))];

    const trimmed = raw.trim();
    if (!trimmed) {
      if (!this.lastBlank) this.blankPending = true;
      this.lastBlank = true;
      return rows;
    }
    return [...rows, ...this.emit(this.block(raw))];
  }

  private block(raw: string): string[] {
    const t = this.theme;
    const w = this.width;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const text = renderInline(heading[2]!, t);
      const styled = heading[1]!.length <= 2 ? t.bold(t.accent(text)) : t.bold(text);
      return wrapText(styled, w);
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return [t.rule('─'.repeat(Math.min(w, 40)))];
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) return wrapText(t.italic(renderInline(quote[1]!, t)), w - 2).map((r) => `${t.rule('│')} ${r}`);
    const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw);
    if (item) {
      const indent = ' '.repeat(Math.min(item[1]!.replace(/\t/g, '    ').length, 12));
      const ordered = /\d/.test(item[2]!);
      let marker = ordered ? item[2]! : '•';
      if (item[3]) marker = /x/i.test(item[3]) ? '☑' : '☐';
      const bullet = ordered ? t.muted(marker) : t.accent(marker);
      const lead = `${indent}${bullet} `;
      const leadWidth = displayWidth(lead);
      const body = wrapText(renderInline(item[4]!, t), w - leadWidth);
      return body.map((r, i) => (i === 0 ? lead : ' '.repeat(leadWidth)) + r);
    }
    return wrapText(renderInline(raw, t), w);
  }

  private flushTable(): string[] {
    if (!this.table.length) return [];
    const lines = this.table;
    this.table = [];
    return this.emit(renderTable(lines, this.width, this.theme));
  }

  private emit(rows: string[]): string[] {
    if (!rows.length) return rows;
    this.lastBlank = false;
    if (this.blankPending) {
      this.blankPending = false;
      return ['', ...rows];
    }
    return rows;
  }
}

function hardWrap(text: string, width: number): string[] {
  return wrapText(text.replace(/ /g, ' '), width).map((r) => r.replace(/ /g, ' '));
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Aligned table when it fits; otherwise each row as `a │ b │ c`. */
export function renderTable(lines: string[], width: number, theme: Theme): string[] {
  const rows = lines.filter((l) => !TABLE_RULE.test(l)).map((l) => splitRow(l).map((c) => renderInline(c, theme)));
  const hasHeader = lines.length > 1 && TABLE_RULE.test(lines[1]!);
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(1, ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const sep = ` ${theme.rule('│')} `;
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (cols - 1);
  if (total > width) {
    return rows.flatMap((r, i) => wrapText(r.map((c) => (i === 0 && hasHeader ? theme.bold(c) : c)).join(sep), width));
  }
  const out: string[] = [];
  rows.forEach((r, i) => {
    const cells = widths.map((cw, c) => padEnd(i === 0 && hasHeader ? theme.bold(r[c] ?? '') : (r[c] ?? ''), cw));
    out.push(cells.join(sep).replace(/\s+$/, ''));
    if (i === 0 && hasHeader) out.push(theme.rule(widths.map((cw) => '─'.repeat(cw)).join('─┼─')));
  });
  return out;
}

/** Renders a complete markdown document. */
export function renderMarkdown(text: string, width: number, theme: Theme): string[] {
  const stream = new MarkdownStream({ width, theme });
  return [...stream.push(text), ...stream.finish()];
}
