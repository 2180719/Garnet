// A minimal virtual terminal for tests: enough of VT100/xterm to replay what
// the chat UI writes (text, wide characters, CR/LF, cursor movement and
// absolute positioning, erase below/line, clear screen, the alternate screen
// buffer) and read back the resulting screen as plain text. Styles (SGR) are
// ignored; private modes (cursor, mouse reporting, bracketed paste, ...) are
// recorded in `modes` so tests can check what is left on at exit.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿＀-｠￠-￦]|\p{Emoji_Presentation}/u;

export class VirtualTerminal {
  columns: number;
  rows: number;
  /** All lines ever written (scrollback included). Each cell holds a grapheme or '' (the tail of a wide one). */
  private lines: string[][] = [[]];
  private row = 0;
  private col = 0;
  cursorVisible = true;
  /** Private modes currently set (`CSI ? n h`), e.g. 1049 (alternate screen), 1000/1006 (mouse), 2004 (bracketed paste). */
  readonly modes = new Set<number>();
  /** The normal screen (and its scrollback) while the alternate screen is shown. */
  private saved: { lines: string[][]; row: number; col: number } | null = null;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
  }

  /** First line of the visible screen. */
  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === '\x1b') {
        const csi = /^\x1b\[([?<>=]?)([0-9;]*)([ -/]*)([@-~])/.exec(data.slice(i));
        if (csi) {
          this.csi(csi[1]!, csi[2]!, csi[4]!);
          i += csi[0].length;
          continue;
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(data.slice(i));
        i += osc ? osc[0].length : 2;
        continue;
      }
      if (ch === '\n') {
        this.lineFeed();
        this.col = 0; // the tty translates \n to \r\n (ONLCR)
        i++;
        continue;
      }
      if (ch === '\r') {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === '\x07' || ch < ' ') {
        i++;
        continue;
      }
      // Next grapheme up to the following control character.
      const next = data.slice(i).search(/[\x00-\x1f]/);
      const chunk = next === -1 ? data.slice(i) : data.slice(i, i + next);
      for (const { segment } of segmenter.segment(chunk)) this.put(segment);
      i += chunk.length;
    }
  }

  private put(g: string): void {
    const w = WIDE.test(g) ? 2 : /^\p{M}+$/u.test(g) ? 0 : 1;
    if (w === 0) return;
    if (this.col + w > this.columns) {
      this.lineFeed();
      this.col = 0;
    }
    const line = this.lines[this.row]!;
    while (line.length < this.col) line.push(' ');
    line[this.col] = g;
    if (w === 2) line[this.col + 1] = '';
    this.col += w;
  }

  /** True while the alternate screen buffer is shown. */
  get alternate(): boolean {
    return this.saved !== null;
  }

  private lineFeed(): void {
    this.row++;
    while (this.lines.length <= this.row) this.lines.push([]);
    // The alternate screen has no scrollback: the top line goes away.
    if (this.saved && this.lines.length > this.rows) {
      this.lines.shift();
      this.row--;
    }
  }

  private csi(prefix: string, params: string, final: string): void {
    const n = Number(params.split(';')[0]) || 0;
    if (prefix === '?') {
      for (const m of params.split(';').map(Number)) {
        if (final === 'h') this.modes.add(m);
        if (final === 'l') this.modes.delete(m);
        if (m === 25) this.cursorVisible = final === 'h';
        if (m === 1049 && final === 'h' && !this.saved) {
          this.saved = { lines: this.lines, row: this.row, col: this.col };
          this.lines = Array.from({ length: this.rows }, () => []);
          this.row = 0;
          this.col = 0;
        } else if (m === 1049 && final === 'l' && this.saved) {
          ({ lines: this.lines, row: this.row, col: this.col } = this.saved);
          this.saved = null;
        }
      }
      return;
    }
    if (prefix) return; // kitty keyboard protocol and similar
    switch (final) {
      case 'A':
        this.row = Math.max(this.top, this.row - Math.max(1, n));
        break;
      case 'B':
        this.row += Math.max(1, n);
        while (this.lines.length <= this.row) this.lines.push([]);
        break;
      case 'C':
        this.col = Math.min(this.columns - 1, this.col + Math.max(1, n));
        break;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, n));
        break;
      case 'H': {
        const [r, c] = params.split(';').map((v) => Math.max(1, Number(v) || 1));
        this.row = this.top + Math.min(this.rows, r ?? 1) - 1;
        this.col = Math.min(this.columns, c ?? 1) - 1;
        while (this.lines.length <= this.row) this.lines.push([]);
        break;
      }
      case 'J':
        if (n === 3) {
          const top = this.top;
          this.lines = this.lines.slice(top);
          this.row -= top;
        } else if (n === 2) {
          for (let r = this.top; r < this.lines.length; r++) this.lines[r] = [];
        } else {
          this.lines[this.row] = this.lines[this.row]!.slice(0, this.col);
          this.lines.length = this.row + 1;
        }
        break;
      case 'K': {
        const line = this.lines[this.row]!;
        if (n === 2) this.lines[this.row] = [];
        else if (n === 1) for (let c = 0; c <= this.col && c < line.length; c++) line[c] = ' ';
        else this.lines[this.row] = line.slice(0, this.col);
        break;
      }
    }
  }

  /** Every line written so far (scrollback and screen), trailing spaces and empty tail removed. */
  text(): string {
    const out = this.lines.map((l) => l.join('').replace(/\s+$/, ''));
    while (out.length && !out.at(-1)) out.pop();
    return out.join('\n');
  }

  /** The visible screen. */
  screen(): string[] {
    return this.lines.slice(this.top).map((l) => l.join('').replace(/\s+$/, ''));
  }

  get cursor(): { row: number; col: number } {
    return { row: this.row - this.top, col: this.col };
  }
}
