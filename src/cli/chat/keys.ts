// Parses raw terminal input into key events. Pure and stateful across chunks
// (an escape sequence or a bracketed paste can be split between reads).
//
// Understands legacy control bytes, CSI/SS3 cursor and editing keys with
// xterm modifiers, xterm modifyOtherKeys (`CSI 27;m;k~`), the kitty keyboard
// protocol (`CSI k;m u`), Alt+key as ESC-prefixed bytes, bracketed paste,
// F1-F4, and mouse reports (SGR `CSI < b;x;y M/m` and legacy X10 `CSI M bxy`):
// the wheel becomes 'wheelup'/'wheeldown', any other mouse event 'mouse'.

export type Key = {
  /** A named key ('enter', 'up', 'backspace', 'a', …) or 'text' for typed or pasted characters. */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** For 'text': the characters. For 'paste': the pasted text. */
  text?: string;
};

const key = (name: string, mods: Partial<Pick<Key, 'ctrl' | 'meta' | 'shift'>> = {}, text?: string): Key => ({
  name,
  ctrl: mods.ctrl ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false,
  ...(text !== undefined ? { text } : {}),
});

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_TILDE: Record<string, string> = {
  '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end',
  '11': 'f1', '12': 'f2', '13': 'f3', '14': 'f4',
};
const CSI_LETTER: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab', P: 'f1', Q: 'f2', R: 'f3', S: 'f4' };
const KITTY_FUNCTIONAL: Record<number, string> = { 9: 'tab', 13: 'enter', 27: 'escape', 127: 'backspace', 57414: 'enter' };

/** xterm modifier parameter (1 + bits: shift 1, alt 2, ctrl 4) → flags. */
function modifiers(param: string | undefined): Pick<Key, 'ctrl' | 'meta' | 'shift'> {
  const m = Math.max(0, (Number(param) || 1) - 1);
  return { shift: Boolean(m & 1), meta: Boolean(m & 2) || Boolean(m & 8), ctrl: Boolean(m & 4) };
}

/** A mouse button code (SGR or X10, without the +32 offset) → a key. Modifier bits: shift 4, meta 8, ctrl 16; 64/65 is the wheel. */
function mouse(code: number): Key {
  const mods = { shift: Boolean(code & 4), meta: Boolean(code & 8), ctrl: Boolean(code & 16) };
  const button = code & ~(4 | 8 | 16);
  if (button === 64) return key('wheelup', mods);
  if (button === 65) return key('wheeldown', mods);
  return key('mouse', mods);
}

/** A single byte/character outside any escape sequence. */
function plain(ch: string, meta = false): Key {
  const code = ch.codePointAt(0)!;
  if (ch === '\r') return key('enter', { meta });
  if (ch === '\n') return key('linefeed', { meta });
  if (ch === '\t') return key('tab', { meta });
  if (ch === '\x7f' || ch === '\b') return key('backspace', { meta });
  if (ch === '\x1b') return key('escape', { meta });
  if (ch === '\x00') return key('space', { ctrl: true, meta });
  if (code < 0x20) return key(String.fromCharCode(code + 96), { ctrl: true, meta });
  if (meta) return key(ch.toLowerCase(), { meta: true, shift: ch !== ch.toLowerCase() });
  return key('text', {}, ch);
}

/** Maps a kitty / modifyOtherKeys codepoint with modifiers to a key. */
function fromCodepoint(code: number, mods: Pick<Key, 'ctrl' | 'meta' | 'shift'>): Key {
  const fn = KITTY_FUNCTIONAL[code];
  if (fn) return key(fn, mods);
  // Garbage (or a sequence we do not know) must never throw out of the input handler.
  if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || (code >= 0xe000 && code <= 0xf8ff)) return key('unknown');
  const ch = String.fromCodePoint(code);
  if (!mods.ctrl && !mods.meta) return key('text', {}, mods.shift ? ch.toUpperCase() : ch);
  return key(ch.toLowerCase(), mods);
}

/** Flush timeout for a lone ESC: short, so the Escape key feels immediate. */
const ESC_TIMEOUT_MS = 30;
/** Flush timeout once a sequence has started (`ESC [`, `ESC O`): a slow terminal or link may split it across reads. */
const SEQUENCE_TIMEOUT_MS = 150;

/**
 * What to swallow from the next read after `flush` dropped an incomplete
 * sequence: the rest of a CSI (parameters, intermediates, final byte) or the
 * remaining raw bytes of an X10 mouse report.
 */
type Leftover = { kind: 'csi' } | { kind: 'bytes'; n: number };

export class KeyParser {
  private buffer = '';
  private paste: string | null = null;
  private leftover: Leftover | null = null;

  /** True when buffered bytes may be the start of an escape sequence (call `flush` after `pendingTimeoutMs`). */
  get pendingEscape(): boolean {
    return this.paste === null && this.buffer.length > 0;
  }

  /** How long to wait for more input before `flush`: short for a lone ESC, longer inside a started sequence. */
  get pendingTimeoutMs(): number {
    return this.buffer === '\x1b' ? ESC_TIMEOUT_MS : SEQUENCE_TIMEOUT_MS;
  }

  feed(chunk: string): Key[] {
    this.buffer += chunk;
    if (this.leftover) this.swallowLeftover();
    return this.drain(false);
  }

  /**
   * Emits anything held back: a lone ESC becomes the Escape key, a bare `ESC [`
   * is Alt+[. A sequence cut off after its parameters (a mouse report split by
   * a slow read) is dropped, never turned into text, and the rest of it is
   * swallowed if it starts the next read.
   */
  flush(): Key[] {
    return this.drain(true);
  }

  /** Drops the remainder of a sequence `flush` cut off, from the start of the buffer. Only the read right after the flush can continue it. */
  private swallowLeftover(): void {
    const left = this.leftover!;
    this.leftover = null;
    if (left.kind === 'bytes') {
      const n = Math.min(left.n, this.buffer.length);
      this.buffer = this.buffer.slice(n);
      if (n < left.n) this.leftover = { kind: 'bytes', n: left.n - n };
      return;
    }
    const m = /^[0-9;:?<>=]*[ -/]*/.exec(this.buffer)!;
    const rest = this.buffer.slice(m[0].length);
    if (rest === '') {
      // Still no final byte: keep swallowing in the next read.
      this.buffer = '';
      if (m[0].length) this.leftover = left;
      return;
    }
    // The final byte ends it. Anything else (an ESC starting a new sequence, a control key) means the remainder never came.
    this.buffer = /^[@-~]/.test(rest) ? rest.slice(1) : rest;
  }

  private drain(force: boolean): Key[] {
    const keys: Key[] = [];
    let text = '';
    const pushText = () => {
      if (text) keys.push(key('text', {}, text));
      text = '';
    };
    while (this.buffer.length) {
      if (this.paste !== null) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end === -1) {
          // Hold a possible partial end marker until more input arrives.
          const keep = force ? 0 : partialSuffix(this.buffer, PASTE_END);
          this.paste += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          if (!force) break;
        } else {
          this.paste += this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + PASTE_END.length);
        }
        keys.push(key('paste', {}, this.paste.replace(/\r\n?/g, '\n')));
        this.paste = null;
        continue;
      }
      const ch = String.fromCodePoint(this.buffer.codePointAt(0)!);
      if (ch !== '\x1b') {
        this.buffer = this.buffer.slice(ch.length);
        const k = plain(ch);
        if (k.name === 'text') text += ch;
        else {
          pushText();
          keys.push(k);
        }
        continue;
      }
      pushText();
      const parsed = this.escape(force);
      if (!parsed) break; // incomplete; wait for more input or a flush
      if (parsed !== 'paste' && parsed !== 'dropped') keys.push(parsed);
    }
    pushText();
    return keys;
  }

  /** Parses an escape sequence at the start of the buffer. Null when incomplete. */
  private escape(force: boolean): Key | 'paste' | 'dropped' | null {
    const b = this.buffer;
    if (b.startsWith(PASTE_START)) {
      this.buffer = b.slice(PASTE_START.length);
      this.paste = '';
      return 'paste';
    }
    if (b.length === 1) {
      if (!force) return null;
      this.buffer = '';
      return key('escape');
    }
    const second = b[1]!;
    if (second === '[') {
      if (b.startsWith('\x1b[M')) {
        // Legacy X10 mouse report: three raw bytes follow (button, column, row, each + 32).
        if (b.length < 6) {
          if (!force) return null;
          this.buffer = '';
          this.leftover = { kind: 'bytes', n: 6 - b.length };
          return 'dropped';
        }
        this.buffer = b.slice(6);
        return mouse(b.charCodeAt(3) - 32);
      }
      const m = /^\x1b\[([0-9;:?<>=]*)([ -/]*)([@-~])/.exec(b);
      if (!m) {
        const partial = /^\x1b\[[0-9;:?<>=]*[ -/]*$/.test(b);
        if (!force && partial) return null;
        if (partial && b.length > 2) {
          // Cut off after its parameters: no key a person types looks like this, so drop it and its late remainder.
          this.buffer = '';
          this.leftover = { kind: 'csi' };
          return 'dropped';
        }
        this.buffer = b.slice(2);
        return key('[', { meta: true });
      }
      this.buffer = b.slice(m[0].length);
      return csi(m[1]!, m[3]!);
    }
    if (second === 'O') {
      if (b.length < 3) {
        if (!force) return null;
        this.buffer = b.slice(2);
        return key('o', { meta: true, shift: true });
      }
      this.buffer = b.slice(3);
      const name = CSI_LETTER[b[2]!];
      return name ? key(name) : key('unknown');
    }
    if (second === '\x1b') {
      // ESC ESC: an Escape followed by whatever comes next.
      this.buffer = b.slice(1);
      return key('escape');
    }
    const ch = String.fromCodePoint(b.codePointAt(1)!);
    this.buffer = b.slice(1 + ch.length);
    return plain(ch, true);
  }
}

function csi(params: string, final: string): Key {
  if (params.startsWith('<')) return final === 'M' || final === 'm' ? mouse(Number(params.slice(1).split(';')[0])) : key('unknown');
  const parts = params.split(';');
  if (final === 'u') {
    const code = Number(parts[0]!.split(':')[0]);
    return fromCodepoint(code, modifiers(parts[1]?.split(':')[0]));
  }
  if (final === '~') {
    if (parts[0] === '27' && parts.length >= 3) return fromCodepoint(Number(parts[2]), modifiers(parts[1]));
    const name = CSI_TILDE[parts[0]!];
    return name ? key(name, modifiers(parts[1])) : key('unknown');
  }
  const name = CSI_LETTER[final];
  if (!name) return key('unknown');
  const mods = modifiers(parts[1]);
  if (final === 'Z') mods.shift = true;
  return key(name, mods);
}

/** Length of the longest suffix of `s` that is a proper prefix of `marker`. */
function partialSuffix(s: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(marker.slice(0, n))) return n;
  }
  return 0;
}
