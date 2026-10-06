// Terminal output with an inline "live region": finished output is printed
// once and left to the terminal's scrollback; the bottom few rows (streaming
// text, spinner, input, footer) are redrawn in place. No alternate screen, so
// the conversation stays in the scrollback after exit.

import { displayWidth } from './text.ts';

export type TerminalOut = {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
};

const SYNC_START = '\x1b[?2026h'; // synchronized output: terminals that support it draw without flicker
const SYNC_END = '\x1b[?2026l';

export class Screen {
  private readonly out: TerminalOut;
  /** Display widths of the live rows last drawn (to erase them after a resize reflows them). */
  private liveWidths: number[] = [];
  /** Row of the cursor within the live region, and its column. */
  private cursorRow = 0;
  private cursorCol = 0;
  private drawnColumns: number;
  private live: { rows: string[]; cursor: { row: number; col: number } | null } = { rows: [], cursor: null };

  constructor(out: TerminalOut) {
    this.out = out;
    this.drawnColumns = this.columns;
  }

  get columns(): number {
    return Math.max(20, this.out.columns ?? 80);
  }

  get rows(): number {
    return Math.max(5, this.out.rows ?? 24);
  }

  /** Prints rows above the live region; they become permanent scrollback. */
  commit(rows: string[]): void {
    if (!rows.length) return;
    this.draw(rows);
  }

  /**
   * Prints `committed` rows above the live region (permanent scrollback),
   * then replaces the live region. `cursor` places the terminal cursor (null hides it).
   */
  setLive(rows: string[], cursor: { row: number; col: number } | null, committed: string[] = []): void {
    const max = this.rows - 1;
    let shown = rows;
    let c = cursor;
    if (rows.length > max) {
      // Keep the bottom (input and footer) and the cursor row visible.
      const cut = rows.length - max;
      shown = rows.slice(cut);
      c = cursor && cursor.row >= cut ? { row: cursor.row - cut, col: cursor.col } : null;
    }
    this.live = { rows: shown, cursor: c };
    this.draw(committed);
  }

  /** Redraws after a terminal resize; the old live rows may have been reflowed. */
  resized(): void {
    this.draw([]);
  }

  /** Clears the screen and scrollback. The next `setLive` draws at the top. */
  clearScreen(): void {
    this.out.write('\x1b[2J\x1b[3J\x1b[H');
    this.liveWidths = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.drawnColumns = this.columns;
  }

  /** Erases the live region and leaves the cursor at the start of a fresh line (before exit or suspend). */
  release(): void {
    this.out.write(this.moveToTop() + '\x1b[J\x1b[?25h');
    this.live = { rows: [], cursor: null };
    this.liveWidths = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** Physical rows between the top of the live region and the cursor, at the current width. */
  private moveToTop(): string {
    const cols = this.columns;
    let up = 0;
    if (cols === this.drawnColumns) up = this.cursorRow;
    else {
      // Terminals that reflow on resize re-wrap each old row at the new width.
      for (let i = 0; i < this.cursorRow; i++) up += Math.max(1, Math.ceil((this.liveWidths[i] ?? 0) / cols));
      up += Math.floor(this.cursorCol / cols);
    }
    return (up > 0 ? `\x1b[${up}A` : '') + '\r';
  }

  private draw(committed: string[]): void {
    const cols = this.columns;
    let buf = SYNC_START + '\x1b[?25l' + this.moveToTop() + '\x1b[J';
    for (const row of committed) buf += `${row}\x1b[0m\n`;
    const rows = this.live.rows;
    buf += rows.map((r) => `${r}\x1b[0m`).join('\n');
    this.liveWidths = rows.map((r) => displayWidth(r));
    this.drawnColumns = cols;
    const lastRow = Math.max(0, rows.length - 1);
    const cursor = this.live.cursor;
    if (cursor) {
      const up = lastRow - cursor.row;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += '\r';
      if (cursor.col > 0) buf += `\x1b[${cursor.col}C`;
      buf += '\x1b[?25h';
      this.cursorRow = cursor.row;
      this.cursorCol = cursor.col;
    } else {
      this.cursorRow = lastRow;
      this.cursorCol = this.liveWidths[lastRow] ?? 0;
    }
    this.out.write(buf + SYNC_END);
  }
}
