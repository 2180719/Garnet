// The fullscreen prompt screens (text, confirm, select, hidden secret, review):
// state, key handling and rendering as pure functions, so tests drive them
// with scripted keys and compare frames as strings.
import type { Key } from '../chat/keys.ts';
import type { Theme } from '../chat/theme.ts';
import { sanitize, wrapText } from '../chat/text.ts';
import type { Ask, ConfirmAsk, SecretAsk, SelectAsk, TextAsk } from '../setup/prompt.ts';
import type { Frame, Step } from './fullscreen.ts';
import { cleanInput, inputWindow, renderPage, type Stage } from './layout.ts';

export type ReviewAsk = Ask & { lines: string[] };

export type PromptState =
  | { kind: 'text'; ask: TextAsk; chars: string[]; cursor: number; error: string | null }
  | { kind: 'confirm'; ask: ConfirmAsk; value: boolean }
  | { kind: 'select'; ask: SelectAsk<string>; index: number }
  | { kind: 'secret'; ask: SecretAsk; chars: string[]; cursor: number }
  | { kind: 'review'; ask: ReviewAsk; scroll: number };

export type PromptValue = string | boolean;

export const initText = (ask: TextAsk): PromptState => ({ kind: 'text', ask, chars: [], cursor: 0, error: null });
export const initConfirm = (ask: ConfirmAsk): PromptState => ({ kind: 'confirm', ask, value: ask.default });
export const initSelect = (ask: SelectAsk<string>): PromptState => ({ kind: 'select', ask, index: Math.max(0, ask.choices.findIndex((c) => c.value === ask.default)) });
export const initSecret = (ask: SecretAsk): PromptState => ({ kind: 'secret', ask, chars: [], cursor: 0 });
export const initReview = (ask: ReviewAsk): PromptState => ({ kind: 'review', ask, scroll: 0 });

const cancel = <S>(state: S): Step<S, PromptValue> => ({ state, done: { cancel: true } });
const isEnter = (k: Key) => (k.name === 'enter' || k.name === 'linefeed') && !k.meta;
const isCancel = (k: Key) => k.name === 'escape' || (k.ctrl && k.name === 'c');

/** Edits a line of graphemes: typing, paste, cursor moves, kills. Returns null when the key is not an edit. */
function edit(chars: string[], cursor: number, k: Key): { chars: string[]; cursor: number } | null {
  const put = (text: string) => {
    const add = cleanInput(text);
    return { chars: [...chars.slice(0, cursor), ...add, ...chars.slice(cursor)], cursor: cursor + add.length };
  };
  if (k.name === 'text' || k.name === 'paste') return put(k.text ?? '');
  if (k.ctrl) {
    switch (k.name) {
      case 'a': return { chars, cursor: 0 };
      case 'e': return { chars, cursor: chars.length };
      case 'u': return { chars: chars.slice(cursor), cursor: 0 };
      case 'k': return { chars: chars.slice(0, cursor), cursor };
      case 'b': return { chars, cursor: Math.max(0, cursor - 1) };
      case 'f': return { chars, cursor: Math.min(chars.length, cursor + 1) };
      case 'w': {
        let i = cursor;
        while (i > 0 && chars[i - 1] === ' ') i--;
        while (i > 0 && chars[i - 1] !== ' ') i--;
        return { chars: [...chars.slice(0, i), ...chars.slice(cursor)], cursor: i };
      }
      default: return null;
    }
  }
  switch (k.name) {
    case 'left': return { chars, cursor: Math.max(0, cursor - 1) };
    case 'right': return { chars, cursor: Math.min(chars.length, cursor + 1) };
    case 'home': return { chars, cursor: 0 };
    case 'end': return { chars, cursor: chars.length };
    case 'backspace': return cursor > 0 ? { chars: [...chars.slice(0, cursor - 1), ...chars.slice(cursor)], cursor: cursor - 1 } : { chars, cursor };
    case 'delete': return { chars: [...chars.slice(0, cursor), ...chars.slice(cursor + 1)], cursor };
    default: return null;
  }
}

export function updatePrompt(state: PromptState, k: Key): Step<PromptState, PromptValue> {
  if (isCancel(k)) return cancel(state);
  switch (state.kind) {
    case 'text': {
      if (isEnter(k)) {
        const value = state.chars.join('').trim() || state.ask.default || '';
        const problem = state.ask.validate?.(value) ?? null;
        if (problem) return { state: { ...state, error: problem } };
        return { state, done: { value } };
      }
      const e = edit(state.chars, state.cursor, k);
      return { state: e ? { ...state, ...e, error: k.name === 'text' || k.name === 'paste' || k.name === 'backspace' ? null : state.error } : state };
    }
    case 'secret': {
      if (isEnter(k)) return { state, done: { value: state.chars.join('').trim() } };
      const e = edit(state.chars, state.cursor, k);
      return { state: e ? { ...state, ...e } : state };
    }
    case 'confirm': {
      if (isEnter(k)) return { state, done: { value: state.value } };
      const text = k.name === 'text' ? (k.text ?? '').toLowerCase() : '';
      if (text === 'y') return { state, done: { value: true } };
      if (text === 'n') return { state, done: { value: false } };
      if (['left', 'right', 'tab', 'up', 'down', 'space'].includes(k.name) || text === ' ' || text === 'h' || text === 'l') return { state: { ...state, value: !state.value } };
      return { state };
    }
    case 'select': {
      const n = state.ask.choices.length;
      const go = (i: number) => ({ state: { ...state, index: Math.max(0, Math.min(n - 1, i)) } });
      if (isEnter(k)) return { state, done: { value: state.ask.choices[state.index]!.value } };
      if (k.name === 'up' || (k.name === 'text' && k.text === 'k')) return go(state.index - 1);
      if (k.name === 'down' || k.name === 'tab' || (k.name === 'text' && k.text === 'j')) return go(state.index + 1);
      if (k.name === 'home') return go(0);
      if (k.name === 'end') return go(n - 1);
      if (k.name === 'pageup') return go(state.index - 5);
      if (k.name === 'pagedown') return go(state.index + 5);
      if (k.name === 'text' && /^[1-9]$/.test(k.text ?? '')) return go(Number(k.text) - 1);
      return { state };
    }
    case 'review': {
      if (isEnter(k) || (k.name === 'text' && k.text?.toLowerCase() === 'y')) return { state, done: { value: true } };
      if (k.name === 'text' && k.text?.toLowerCase() === 'n') return { state, done: { value: false } };
      if (k.name === 'up') return { state: { ...state, scroll: Math.max(0, state.scroll - 1) } };
      if (k.name === 'down') return { state: { ...state, scroll: Math.min(state.ask.lines.length - 1, state.scroll + 1) } };
      if (k.name === 'pageup') return { state: { ...state, scroll: Math.max(0, state.scroll - 5) } };
      if (k.name === 'pagedown') return { state: { ...state, scroll: Math.min(state.ask.lines.length - 1, state.scroll + 5) } };
      return { state };
    }
  }
}

export type PromptView = { theme: Theme; stage: Stage | null; context: string[]; title?: string };

const head = (ask: Ask, t: Theme, width: number): string[] => [
  ...wrapText(t.bold(sanitize(ask.message)), Math.max(10, width - 4)),
  ...(ask.help ? wrapText(t.muted(sanitize(ask.help)), Math.max(10, width - 4)) : []),
  '',
];

export function viewPrompt(state: PromptState, width: number, height: number, v: PromptView): Frame {
  const t = v.theme;
  const base = { theme: t, width, height, title: v.title ?? 'SETUP', stage: v.stage, context: v.context };
  const inner = width - 4;
  switch (state.kind) {
    case 'text': {
      const core = [...head(state.ask, t, width)];
      const w = inputWindow(state.chars, state.cursor, inner - 2);
      const empty = state.chars.length === 0;
      const shown = empty && state.ask.default ? t.muted(`${sanitize(state.ask.default)}  (default)`) : w.text;
      core.push(`${t.accent('›')} ${shown}`);
      const row = core.length - 1;
      if (state.error) core.push('', `${t.error('✗')} ${sanitize(state.error)}`);
      return renderPage({ ...base, core, focus: row, hints: 'Enter accept · Esc cancel · Ctrl+U clear', cursor: { row, col: 2 + w.col } });
    }
    case 'secret': {
      const core = [...head(state.ask, t, width)];
      const w = inputWindow(state.chars, state.cursor, inner - 2, '•');
      core.push(`${t.accent('›')} ${w.text}`);
      const row = core.length - 1;
      core.push('', t.muted(state.chars.length ? `${state.chars.length} characters typed (hidden, never shown or saved to config)` : 'Hidden input. Paste works. Press Enter to skip.'));
      return renderPage({ ...base, core, focus: row, hints: 'Enter accept · Esc cancel · Ctrl+U clear', cursor: { row, col: 2 + w.col } });
    }
    case 'confirm': {
      const core = [...head(state.ask, t, width)];
      const yes = state.value ? t.bold(t.accent('(•) Yes')) : '( ) Yes';
      const no = state.value ? '( ) No' : t.bold(t.accent('(•) No'));
      core.push(`${yes}    ${no}`, '', t.muted(`Default: ${state.ask.default ? 'Yes' : 'No'}`));
      return renderPage({ ...base, core, focus: core.length - 3, hints: 'y/n · Enter accept · Esc cancel' });
    }
    case 'select': {
      const core = [...head(state.ask, t, width)];
      const first = core.length;
      const digits = state.ask.choices.length <= 9;
      state.ask.choices.forEach((c, i) => {
        const on = i === state.index;
        const label = `${digits ? `${i + 1}) ` : ''}${sanitize(c.label)}`;
        const cur = c.value === state.ask.default ? t.muted('  (default)') : '';
        const hint = c.hint ? `  ${t.muted(sanitize(c.hint))}` : '';
        core.push(`${on ? t.accent('›') : ' '} ${on ? t.bold(label) : label}${cur}${hint}`);
      });
      return renderPage({ ...base, core, focus: first + state.index, hints: `↑/↓ move${digits ? ' · 1-9 jump' : ''} · Enter choose · Esc cancel · ${state.index + 1}/${state.ask.choices.length}` });
    }
    case 'review': {
      const title = head(state.ask, t, width);
      const body = state.ask.lines.flatMap((l) => wrapText(sanitize(l), Math.max(10, width - 4)));
      const room = Math.max(1, height - title.length - (height >= 14 ? 6 : height >= 8 ? 4 : 1));
      const scroll = Math.min(state.scroll, Math.max(0, body.length - room));
      const shown = body.slice(scroll, scroll + room);
      const more = body.length > room ? [t.muted(`(${scroll + 1}-${scroll + shown.length} of ${body.length} lines)`)] : [];
      return renderPage({ ...base, context: [], core: [...title, ...shown, ...more], focus: 0, hints: 'Enter save · n do not save · ↑/↓ scroll · Esc cancel' });
    }
  }
}
