// Terminal output for the fullscreen chat: the alternate screen buffer, SGR
// mouse reporting, and whole frames drawn row by row (only changed rows are
// rewritten) inside synchronized output. Layout is decided in layout.ts.

import type { Cursor } from './layout.ts';
import type { TerminalOut } from './screen.ts';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
// 1000: report button presses (the wheel is buttons 4 and 5); 1006: SGR encoding (no limit on coordinates, no raw bytes).
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/** Mouse reporting off and back to the normal screen. Safe to write once when the chat did not get to clean up. */
export const FULLSCREEN_OFF = MOUSE_OFF + ALT_OFF;

export class FullScreen {
  private readonly out: TerminalOut;
  /** Rows last drawn, to rewrite only what changed. Empty forces a full redraw. */
  private last: string[] = [];
  private active = false;

  constructor(out: TerminalOut) {
    this.out = out;
  }

  get columns(): number {
    return Math.max(20, this.out.columns ?? 80);
  }

  get rows(): number {
    return Math.max(5, this.out.rows ?? 24);
  }

  /** Switches to the alternate screen (cleared) and sets mouse reporting. */
  enter(mouse: boolean): void {
    this.out.write(`${ALT_ON}\x1b[2J\x1b[H${mouse ? MOUSE_ON : MOUSE_OFF}`);
    this.active = true;
    this.last = [];
  }

  setMouse(on: boolean): void {
    if (this.active) this.out.write(on ? MOUSE_ON : MOUSE_OFF);
  }

  /** Mouse reporting off, back to the normal screen with its scrollback, cursor shown. */
  leave(): void {
    if (!this.active) return;
    this.out.write(`${FULLSCREEN_OFF}\x1b[?25h`);
    this.active = false;
    this.last = [];
  }

  /** The next draw rewrites every row (after a resize, a suspend or a clear). */
  invalidate(): void {
    this.last = [];
  }

  /** Draws a whole frame (`rows` is the full screen height) and places the cursor (null hides it). */
  draw(rows: string[], cursor: Cursor | null): void {
    if (!this.active) return;
    let buf = `${SYNC_START}\x1b[?25l`;
    if (!this.last.length) buf += '\x1b[2J';
    rows.forEach((row, i) => {
      if (this.last[i] === row && this.last.length === rows.length) return;
      buf += `\x1b[${i + 1};1H${row}\x1b[0m\x1b[K`;
    });
    if (cursor) buf += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    this.last = rows.slice();
    this.out.write(buf + SYNC_END);
  }
}
