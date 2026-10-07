// Shared page chrome and small widgets for the fullscreen screens. Pure.
// Layout degrades with height: full header and progress, then a one-row
// header, then body and key hints only.
import type { Theme } from '../chat/theme.ts';
import { displayWidth, graphemeWidth, graphemes, padEnd, truncate, wrapText } from '../chat/text.ts';
import type { Frame } from './fullscreen.ts';

export type Stage = { index: number; total: number; label: string };

export type Page = {
  theme: Theme;
  width: number;
  height: number;
  /** `SETUP`, `CONFIG`. */
  title: string;
  stage?: Stage | null;
  /** Right side of the header when there is no stage (the config browser's save state). */
  status?: string;
  /** Shown above the core when there is room (the wizard's notes); the last lines win. */
  context?: string[];
  /** The question and its answer widget. Never dropped. */
  core: string[];
  /** Row of `core` that must stay visible when it has to be windowed. */
  focus?: number;
  /** Key hints, plain words. */
  hints: string;
  cursor?: { row: number; col: number };
};

/** `[####------]` (text, so it reads without colour). */
export function progressBar(done: number, total: number, width: number): string {
  const w = Math.max(3, width);
  const filled = total <= 0 ? 0 : Math.min(w, Math.round((done / total) * w));
  return `[${'#'.repeat(filled)}${'-'.repeat(w - filled)}]`;
}

export function renderPage(p: Page): Frame {
  const { theme: t, width, height } = p;
  const inner = Math.max(10, width - 4);
  const fit = (s: string) => truncate(s, width);
  const rows: string[] = [];
  const full = height >= 14;
  const compact = height >= 8;
  const brand = `${t.accent('◆ GARNET')} ${t.muted(`/ ${p.title}`)}`;
  const step = p.stage ? `Step ${p.stage.index} of ${p.stage.total} · ${p.stage.label}` : (p.status ?? '');
  if (compact) {
    const gap = Math.max(1, width - 2 - displayWidth(`◆ GARNET / ${p.title}`) - displayWidth(step));
    rows.push(fit(` ${brand}${' '.repeat(gap)}${t.muted(step)}`));
  }
  if (full) {
    rows.push(fit(p.stage ? ` ${t.accent(progressBar(p.stage.index, p.stage.total, Math.min(30, inner - 6)))} ${t.muted(`${p.stage.index}/${p.stage.total}`)}` : ` ${t.rule('─'.repeat(Math.min(40, inner)))}`));
    rows.push('');
  }
  const footerRows = compact ? 2 : 1;
  const avail = Math.max(1, height - rows.length - footerRows);
  let core = p.core;
  let cursor = p.cursor;
  let coreOffset = 0;
  if (core.length > avail) {
    const focus = Math.min(core.length - 1, p.focus ?? 0);
    // Keep the first row (the question) when the focus fits beneath it, else window around the focus.
    const start = focus < avail ? 0 : Math.min(core.length - avail, focus - Math.floor(avail / 2));
    coreOffset = start;
    core = core.slice(start, start + avail);
  }
  const spare = avail - core.length;
  const room = Math.max(0, spare - 1);
  const context = room ? (p.context ?? []).slice(-room) : [];
  const lead = context.length ? [...context, ''] : [];
  for (const line of [...lead, ...core]) rows.push(fit(`  ${line}`));
  if (cursor) cursor = { row: rows.length - core.length + (cursor.row - coreOffset), col: cursor.col + 2 };
  while (rows.length < height - footerRows) rows.push('');
  if (compact) rows.push(fit(` ${t.rule('─'.repeat(Math.max(1, width - 2)))}`));
  rows.push(fit(` ${t.muted(p.hints)}`));
  const out = rows.slice(0, height);
  const frame: Frame = { rows: out };
  if (cursor && cursor.row >= 0 && cursor.row < height) frame.cursor = { row: cursor.row, col: Math.min(width - 1, cursor.col) };
  return frame;
}

/** Wraps text for the body, indenting continuation rows. */
export function paragraph(text: string, width: number): string[] {
  return wrapText(text, Math.max(10, width - 4));
}

/**
 * One editable line: the text around the cursor that fits in `width`
 * columns (scrolled when long), and the cursor's column within it.
 */
export function inputWindow(chars: string[], cursor: number, width: number, mask?: string): { text: string; col: number } {
  const cells = chars.map((g) => (mask ?? g));
  const w = (g: string) => Math.max(0, graphemeWidth(g));
  const budget = Math.max(4, width - 1);
  let start = 0;
  let used = cells.slice(0, cursor).reduce((n, g) => n + w(g), 0);
  while (used > budget - 1 && start < cursor) {
    used -= w(cells[start]!);
    start++;
  }
  let text = '';
  let shown = 0;
  for (let i = start; i < cells.length; i++) {
    if (shown + w(cells[i]!) > budget) break;
    text += cells[i];
    shown += w(cells[i]!);
  }
  return { text, col: used };
}

/** Splits a typed or pasted string into graphemes with control characters (newlines, escapes) removed. */
export function cleanInput(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  return graphemes(text.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, ''));
}

/** Rows for a windowed list: returns the visible slice start so the highlight stays on screen. */
export function listWindow(count: number, index: number, size: number, prev = 0): number {
  if (count <= size) return 0;
  let start = Math.min(prev, count - size);
  if (index < start) start = index;
  if (index >= start + size) start = index - size + 1;
  return Math.max(0, Math.min(start, count - size));
}

export { padEnd };
