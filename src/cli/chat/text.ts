// Unicode- and ANSI-aware text measurement and wrapping. Pure functions.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Splits text into user-perceived characters (grapheme clusters). */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

// East Asian Wide and Fullwidth blocks that are not emoji (emoji are detected by property).
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1b000, 0x1b2ff], [0x1f200, 0x1f251],
  [0x20000, 0x3fffd],
];
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** Terminal columns a single grapheme cluster occupies (0, 1 or 2). */
export function graphemeWidth(g: string): number {
  if (g === '\t') return 4; // rendered as four spaces by callers
  if (EMOJI_PRESENTATION.test(g) || (g.includes('️') && PICTOGRAPHIC.test(g))) return 2;
  let width = 0;
  for (const ch of g) {
    if (ZERO_WIDTH.test(ch)) continue;
    width = Math.max(width, isWide(ch.codePointAt(0)!) ? 2 : 1);
  }
  return width;
}

// CSI sequences (colors, cursor moves) and OSC sequences (hyperlinks, titles).
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Makes untrusted text (model output, tool results, approval summaries) safe
 * to print: control characters other than newline and tab are shown as their
 * Unicode control pictures (ESC as `␛`, CR as `␍`) instead of reaching the
 * terminal, where they could erase or rewrite what the owner sees (for
 * example the command in an approval prompt) or set the clipboard. C1
 * controls become `�`. Apply it to the data before adding Garnet's own styles.
 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g, (c) => {
    const code = c.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    return code === 0x7f ? '␡' : '�';
  });
}

/** Display width in terminal columns, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const g of graphemes(stripAnsi(text))) width += graphemeWidth(g);
  return width;
}

type Token = { kind: 'ansi'; text: string } | { kind: 'char'; text: string; width: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  const pushText = (s: string) => {
    for (const g of graphemes(s)) tokens.push({ kind: 'char', text: g === '\t' ? '    ' : g, width: graphemeWidth(g) });
  };
  for (const m of text.matchAll(ANSI)) {
    pushText(text.slice(last, m.index));
    tokens.push({ kind: 'ansi', text: m[0] });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return tokens;
}

const CLOSERS: Record<string, string> = { '22': 'intensity', '23': 'italic', '24': 'underline', '27': 'inverse', '29': 'strike', '39': 'fg', '49': 'bg' };

function sgrCategory(seq: string): string {
  const p = Number(seq.slice(2, -1).split(';')[0]);
  if (p === 1 || p === 2) return 'intensity';
  if (p === 3) return 'italic';
  if (p === 4) return 'underline';
  if (p === 7) return 'inverse';
  if (p === 9) return 'strike';
  if ((p >= 30 && p <= 38) || (p >= 90 && p <= 97)) return 'fg';
  if ((p >= 40 && p <= 48) || (p >= 100 && p <= 107)) return 'bg';
  return 'other';
}

/** Tracks which SGR (style) codes are active so a style can be carried across a line break. */
class SgrState {
  private codes: string[] = [];
  apply(seq: string): void {
    if (!seq.endsWith('m') || !seq.startsWith('\x1b[')) return;
    const params = seq.slice(2, -1);
    if (params === '' || params === '0') {
      this.codes = [];
      return;
    }
    const closes = CLOSERS[params];
    if (closes) this.codes = this.codes.filter((c) => sgrCategory(c) !== closes);
    else this.codes.push(seq);
  }
  get open(): string {
    return this.codes.join('');
  }
  get active(): boolean {
    return this.codes.length > 0;
  }
}

/**
 * Word-wraps text (which may contain ANSI styles) to `width` columns. Breaks
 * at spaces, hard-breaks words longer than a line, keeps leading indentation,
 * and closes/reopens styles at each break so every row is self-contained.
 * Newlines in the input start new rows.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  const sgr = new SgrState();
  for (const line of text.split('\n')) {
    let row = sgr.open;
    let rowWidth = 0;
    let rowHasContent = false;
    const breakRow = () => {
      rows.push(row + (sgr.active ? '\x1b[0m' : ''));
      row = sgr.open;
      rowWidth = 0;
      rowHasContent = false;
    };
    // Group tokens into words (non-space runs, ANSI attached) and spaces.
    const tokens = tokenize(line);
    let i = 0;
    let leading = true;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.kind === 'char' && t.text === ' ') {
        let j = i;
        let spaces = 0;
        while (j < tokens.length && tokens[j]!.kind === 'char' && tokens[j]!.text === ' ') {
          spaces++;
          j++;
        }
        if (leading || rowWidth + spaces < w) {
          const fit = Math.min(spaces, w - rowWidth - (leading ? 1 : 0));
          row += ' '.repeat(Math.max(0, fit));
          rowWidth += Math.max(0, fit);
        } else if (j < tokens.length) {
          breakRow();
        }
        i = j;
        continue;
      }
      leading = false;
      // Collect one word.
      const word: Token[] = [];
      let wordWidth = 0;
      while (i < tokens.length && !(tokens[i]!.kind === 'char' && tokens[i]!.text === ' ')) {
        const tok = tokens[i]!;
        word.push(tok);
        if (tok.kind === 'char') wordWidth += tok.width;
        i++;
      }
      if (rowWidth + wordWidth > w && rowHasContent && wordWidth <= w) {
        // Drop trailing spaces before the break.
        row = row.replace(/ +$/, '');
        breakRow();
      }
      for (const tok of word) {
        if (tok.kind === 'ansi') {
          row += tok.text;
          sgr.apply(tok.text);
          continue;
        }
        if (rowWidth + tok.width > w && rowWidth > 0) breakRow();
        row += tok.text;
        rowWidth += tok.width;
        rowHasContent = true;
      }
    }
    rows.push(row + (sgr.active ? '\x1b[0m' : ''));
  }
  return rows;
}

/** Truncates to `width` columns (ANSI-aware), adding `…` when cut. */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 0) return '';
  let out = '';
  let used = 0;
  let styled = false;
  for (const tok of tokenize(text)) {
    if (tok.kind === 'ansi') {
      out += tok.text;
      styled = true;
      continue;
    }
    if (used + tok.width > width - 1) break;
    out += tok.text;
    used += tok.width;
  }
  return `${out}…${styled ? '\x1b[0m' : ''}`;
}

/** Pads with spaces to `width` columns (no-op when already wider). */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Compact token counts: 950, 1.2k, 34k, 1.5M. Null (unknown) renders as "?". */
export function formatTokens(n: number | null): string {
  if (n === null) return '?';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}
