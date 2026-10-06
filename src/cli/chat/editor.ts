// Multi-line input editor: pure state transitions and layout.

import { graphemes, graphemeWidth } from './text.ts';
import type { Key } from './keys.ts';

export type EditorState = {
  text: string;
  /** Cursor offset in UTF-16 code units, always on a grapheme boundary. */
  cursor: number;
  /** Position while browsing history: entries.length means the draft. */
  historyIndex: number;
  /** The unsent text saved when history browsing started. */
  draft: string;
};

export const emptyEditor = (historyLength = 0): EditorState => ({ text: '', cursor: 0, historyIndex: historyLength, draft: '' });

/** What a key did to the editor. Keys the editor does not handle return `unhandled`. */
export type EditorAction = 'edit' | 'move' | 'submit' | 'unhandled';

const set = (s: EditorState, text: string, cursor: number): EditorState => ({ ...s, text, cursor });

export function insert(s: EditorState, text: string): EditorState {
  return set(s, s.text.slice(0, s.cursor) + text + s.text.slice(s.cursor), s.cursor + text.length);
}

/** Offsets of grapheme boundaries in `text`. */
function boundaries(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const g of graphemes(text)) out.push((at += g.length));
  return out;
}

function prevBoundary(text: string, cursor: number): number {
  const b = boundaries(text);
  for (let i = b.length - 1; i >= 0; i--) if (b[i]! < cursor) return b[i]!;
  return 0;
}

function nextBoundary(text: string, cursor: number): number {
  for (const x of boundaries(text)) if (x > cursor) return x;
  return text.length;
}

const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

export function wordLeft(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && !isWordChar(text[i - 1]!)) i--;
  while (i > 0 && isWordChar(text[i - 1]!)) i--;
  return i;
}

export function wordRight(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && !isWordChar(text[i]!)) i++;
  while (i < text.length && isWordChar(text[i]!)) i++;
  return i;
}

const lineStart = (text: string, cursor: number) => text.lastIndexOf('\n', cursor - 1) + 1;
const lineEnd = (text: string, cursor: number) => {
  const nl = text.indexOf('\n', cursor);
  return nl === -1 ? text.length : nl;
};

/** Moves the cursor one logical line up or down, keeping its column. Null at the first/last line. */
function verticalMove(s: EditorState, dir: -1 | 1): number | null {
  const start = lineStart(s.text, s.cursor);
  const column = graphemes(s.text.slice(start, s.cursor)).length;
  let targetStart: number;
  if (dir === -1) {
    if (start === 0) return null;
    targetStart = lineStart(s.text, start - 1);
  } else {
    const end = lineEnd(s.text, s.cursor);
    if (end === s.text.length) return null;
    targetStart = end + 1;
  }
  const target = s.text.slice(targetStart, lineEnd(s.text, targetStart));
  const gs = graphemes(target).slice(0, column);
  return targetStart + gs.join('').length;
}

export function historyMove(s: EditorState, history: readonly string[], dir: -1 | 1): EditorState {
  const index = s.historyIndex + dir;
  if (index < 0 || index > history.length) return s;
  const draft = s.historyIndex === history.length ? s.text : s.draft;
  const text = index === history.length ? draft : history[index]!;
  return { text, cursor: text.length, historyIndex: index, draft };
}

/**
 * Applies one key. Enter submits unless the text ends with a backslash
 * (continuation); Shift+Enter, Alt+Enter and Ctrl+J insert a newline.
 */
export function applyKey(s: EditorState, k: Key, history: readonly string[] = []): { state: EditorState; action: EditorAction } {
  const edit = (state: EditorState) => ({ state, action: 'edit' as const });
  const move = (cursor: number) => ({ state: { ...s, cursor }, action: 'move' as const });
  const { text, cursor } = s;

  if (k.name === 'text' || k.name === 'paste') {
    const t = (k.text ?? '').replace(/\r\n?/g, '\n');
    return edit(insert(s, k.name === 'paste' ? t : t.replace(/\n/g, '')));
  }
  if (k.name === 'space' && !k.ctrl) return edit(insert(s, ' '));
  if ((k.name === 'enter' && (k.shift || k.meta)) || k.name === 'linefeed' || (k.ctrl && k.name === 'j')) {
    return edit(insert(s, '\n'));
  }
  if (k.name === 'enter') {
    // A trailing backslash continues onto a new line (works in every terminal).
    if (cursor === text.length && text.endsWith('\\')) return edit(set(s, `${text.slice(0, -1)}\n`, text.length));
    return { state: s, action: 'submit' };
  }
  if (k.name === 'backspace') {
    if (k.meta || k.ctrl) {
      const to = wordLeft(text, cursor);
      return edit(set(s, text.slice(0, to) + text.slice(cursor), to));
    }
    if (cursor === 0) return { state: s, action: 'move' };
    const to = prevBoundary(text, cursor);
    return edit(set(s, text.slice(0, to) + text.slice(cursor), to));
  }
  if (k.name === 'delete' || (k.ctrl && k.name === 'd' && text)) {
    if (cursor === text.length) return { state: s, action: 'move' };
    const to = nextBoundary(text, cursor);
    return edit(set(s, text.slice(0, cursor) + text.slice(to), cursor));
  }
  if (k.meta && k.name === 'd') {
    const to = wordRight(text, cursor);
    return edit(set(s, text.slice(0, cursor) + text.slice(to), cursor));
  }
  if (k.ctrl && k.name === 'w') {
    const to = wordLeft(text, cursor);
    return edit(set(s, text.slice(0, to) + text.slice(cursor), to));
  }
  if (k.ctrl && k.name === 'u') {
    const start = lineStart(text, cursor);
    return edit(set(s, text.slice(0, start) + text.slice(cursor), start));
  }
  if (k.ctrl && k.name === 'k') {
    const end = lineEnd(text, cursor);
    // At the end of a line, join it with the next.
    const to = end === cursor && end < text.length ? end + 1 : end;
    return edit(set(s, text.slice(0, cursor) + text.slice(to), cursor));
  }
  if (k.name === 'left' || (k.ctrl && k.name === 'b')) {
    return move(k.ctrl && k.name === 'left' || k.meta ? wordLeft(text, cursor) : prevBoundary(text, cursor));
  }
  if (k.name === 'right' || (k.ctrl && k.name === 'f')) {
    return move(k.ctrl && k.name === 'right' || k.meta ? wordRight(text, cursor) : nextBoundary(text, cursor));
  }
  if (k.meta && k.name === 'b') return move(wordLeft(text, cursor));
  if (k.meta && k.name === 'f') return move(wordRight(text, cursor));
  if (k.name === 'home' || (k.ctrl && k.name === 'a')) return move(lineStart(text, cursor));
  if (k.name === 'end' || (k.ctrl && k.name === 'e')) return move(lineEnd(text, cursor));
  if (k.name === 'up' || (k.ctrl && k.name === 'p')) {
    const to = verticalMove(s, -1);
    if (to !== null && k.name === 'up') return move(to);
    return { state: historyMove(s, history, -1), action: 'edit' };
  }
  if (k.name === 'down' || (k.ctrl && k.name === 'n')) {
    const to = verticalMove(s, 1);
    if (to !== null && k.name === 'down') return move(to);
    return { state: historyMove(s, history, 1), action: 'edit' };
  }
  return { state: s, action: 'unhandled' };
}

export type EditorLayout = {
  rows: string[];
  /** Cursor position within `rows` (column in terminal cells). */
  cursorRow: number;
  cursorCol: number;
};

/**
 * Lays out the text for display: the first row starts with `prompt`, later
 * rows with `continuation` (same width). Rows hard-wrap at `width` cells.
 * Tabs show as four spaces; other control characters as `?`.
 */
export function layoutEditor(s: EditorState, width: number, prompt: string, continuation: string, promptWidth: number): EditorLayout {
  const avail = Math.max(4, width - promptWidth);
  const rows: string[] = [];
  let cursorRow = 0;
  let cursorCol = promptWidth;
  let row = '';
  let rowWidth = 0;
  let offset = 0;
  const newRow = () => {
    rows.push(row);
    row = '';
    rowWidth = 0;
  };
  const place = () => {
    // A cursor at the end of a full row moves to the start of the next row.
    if (rowWidth >= avail) {
      cursorRow = rows.length + 1;
      cursorCol = promptWidth;
    } else {
      cursorRow = rows.length;
      cursorCol = promptWidth + rowWidth;
    }
  };
  const lines = s.text.split('\n');
  let cursorPlaced = false;
  lines.forEach((line, li) => {
    for (const g of graphemes(line)) {
      if (!cursorPlaced && offset === s.cursor) {
        place();
        cursorPlaced = true;
      }
      const shown = g === '\t' ? '    ' : /^[\x00-\x1f\x7f-\x9f]$/.test(g) ? '?' : g;
      const w = g === '\t' ? 4 : shown === '?' ? 1 : graphemeWidth(g);
      if (rowWidth + w > avail && rowWidth > 0) newRow();
      row += shown;
      rowWidth += w;
      offset += g.length;
    }
    if (!cursorPlaced && offset === s.cursor) {
      place();
      cursorPlaced = true;
    }
    if (li < lines.length - 1) {
      newRow();
      offset += 1; // the newline
    }
  });
  rows.push(row);
  if (cursorRow >= rows.length) rows.push('');
  return {
    rows: rows.map((r, i) => (i === 0 ? prompt : continuation) + r),
    cursorRow,
    cursorCol,
  };
}
