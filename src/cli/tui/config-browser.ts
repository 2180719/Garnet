// `garnet config` on a terminal: a fullscreen browser and editor for config.json.
// The field list is generated from the config schema (so new settings appear on their own), descriptions come
// from the schema's `.describe()`, and every edit is validated with `configSchema` before it is kept. Secret
// values are never shown or accepted here: only the NAMES of environment variables or stored secrets, with a
// note on whether each name currently resolves. See config-fields.ts for the field model and
// config-sections.ts for how sections are titled and summarized.
import { configSchema, keyEnvOf, type GarnetConfig } from '../../config/index.ts';
import type { Key } from '../chat/keys.ts';
import type { Theme } from '../chat/theme.ts';
import { padEnd, sanitize, truncate, wrapText } from '../chat/text.ts';
import { coerce, configFields, displayValue, dotted, editElsewhere, getAt, listOf, tryChange, type Field, type JsonSchema } from './config-fields.ts';
import { SECTION_INFO, orderSections, sectionTitle } from './config-sections.ts';
import type { Frame, Screen, Step } from './fullscreen.ts';
import { cleanInput, inputWindow, listWindow, renderPage } from './layout.ts';

export type SecretStatus = 'set' | 'missing' | 'locked';

export type ConfigStatus = { text: string; kind: 'ok' | 'error' | 'info' } | null;

/** Which fields the field list shows: one section, the results of a search, or what changed since the last save. */
export type Scope = { kind: 'section' } | { kind: 'search'; query: string[]; cursor: number; typing: boolean } | { kind: 'changed' };

type EditLine = { chars: string[]; cursor: number; error: string | null };

export type ConfigState = {
  draft: GarnetConfig;
  saved: string;
  level: 'sections' | 'fields' | 'edit' | 'enum' | 'list' | 'multi' | 'quit';
  sections: string[];
  section: number;
  row: number;
  /** Scroll offset of the field list. */
  top: number;
  scope: Scope;
  /** The setting an edit, picker or list level is working on, by path, so it cannot change under the cursor when the visible list does. */
  target: string | null;
  edit: EditLine;
  choice: number;
  /** The list editor: the highlighted item (one past the end is "add an item") and the item being typed, if any. */
  list: { cursor: number; editing: (EditLine & { index: number }) | null };
  status: ConfigStatus;
};

export type ConfigContext = {
  fields: Field[];
  /** Fallback blurbs for sections without an entry in SECTION_INFO (the schema's own description). */
  descriptions: Record<string, string>;
  /** Writes the validated config (the real one calls `writeConfig`). */
  save: (config: GarnetConfig) => void;
  file: string;
  theme: Theme;
  /** Whether a secret NAME resolves right now (environment or stored). Absent: no note is shown. */
  secretStatus?: (name: string) => SecretStatus;
};

const key = (c: GarnetConfig) => JSON.stringify(c);
const NO_EDIT: EditLine = { chars: [], cursor: 0, error: null };

export function initialConfigState(config: GarnetConfig, fields: Field[]): ConfigState {
  const sections = orderSections([...new Set(fields.map((f) => f.section))]);
  return { draft: config, saved: key(config), level: 'sections', sections, section: 0, row: 0, top: 0, scope: { kind: 'section' }, target: null, edit: NO_EDIT, choice: 0, list: { cursor: 0, editing: null }, status: null };
}

export const isDirty = (s: ConfigState) => key(s.draft) !== s.saved;

const savedValue = (s: ConfigState, f: Field): unknown => getAt(JSON.parse(s.saved) as unknown, f.path);
const changed = (s: ConfigState, f: Field): boolean => JSON.stringify(savedValue(s, f)) !== JSON.stringify(getAt(s.draft, f.path));
const changedFields = (c: ConfigContext, s: ConfigState): Field[] => c.fields.filter((f) => changed(s, f));

/** The fields the list currently shows. */
export function visibleFields(c: ConfigContext, s: ConfigState): Field[] {
  switch (s.scope.kind) {
    case 'section':
      return c.fields.filter((f) => f.section === s.sections[s.section]);
    case 'changed':
      return changedFields(c, s);
    case 'search': {
      const terms = s.scope.query.join('').toLowerCase().split(/\s+/).filter(Boolean);
      return c.fields.filter((f) => {
        const text = `${dotted(f)} ${f.description} ${sectionTitle(f.section)}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
    }
  }
}

const fieldAt = (c: ConfigContext, s: ConfigState): Field | undefined => {
  if (s.target && s.level !== 'fields') return c.fields.find((f) => dotted(f) === s.target);
  const list = visibleFields(c, s);
  return list[Math.min(s.row, list.length - 1)];
};

/** A line editor step shared by the text, search and list-item inputs. Null when the key is not an edit. */
function editLine(chars: string[], cursor: number, k: Key): { chars: string[]; cursor: number } | null {
  if (k.name === 'text' || k.name === 'paste') {
    const add = cleanInput(k.text ?? '');
    return { chars: [...chars.slice(0, cursor), ...add, ...chars.slice(cursor)], cursor: cursor + add.length };
  }
  if (k.ctrl && k.name === 'u') return { chars: chars.slice(cursor), cursor: 0 };
  if (k.ctrl && k.name === 'a') return { chars, cursor: 0 };
  if (k.ctrl && k.name === 'e') return { chars, cursor: chars.length };
  if (k.ctrl) return null;
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

type Done = 'closed';
type Next = Step<ConfigState, Done>;

const info = (s: ConfigState, text: string, kind: 'info' | 'error' | 'ok' = 'info'): Next => ({ state: { ...s, status: { kind, text } } });
const isEnter = (k: Key) => (k.name === 'enter' || k.name === 'linefeed') && !k.meta;
const textOf = (k: Key) => (k.name === 'text' ? (k.text ?? '') : '');
const isCancel = (k: Key) => k.name === 'escape' || (k.ctrl && k.name === 'c');

function save(c: ConfigContext, s: ConfigState): Next {
  const parsed = configSchema.safeParse(s.draft);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return info(s, `Not saved: ${i.path.join('.')}: ${i.message}`, 'error');
  }
  try {
    c.save(parsed.data);
  } catch (e) {
    return info(s, `Not saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
  return { state: { ...s, draft: parsed.data, saved: key(parsed.data), status: { kind: 'ok', text: `Saved ${c.file}` } } };
}

/** Applies a new value for `field` to the draft, or says why not. */
function apply(s: ConfigState, field: Field, value: unknown, then: Partial<ConfigState> = {}): { state: ConfigState; error: string | null } {
  const r = tryChange(s.draft, field, value);
  return r.ok ? { state: { ...s, ...then, draft: r.draft, status: null }, error: null } : { state: s, error: r.error };
}

/** Starts editing `field` the way its kind needs: toggle, pick, list, or type. */
function open(s: ConfigState, field: Field): Next {
  const value = getAt(s.draft, field.path);
  if (field.fixed) return info(s, `${dotted(field)} is fixed.`);
  if (field.secretValue) return info(s, 'Secrets never live in config.json. Store the value with `garnet secrets set NAME` and set the *Env field to its name.');
  if (field.kind === 'complex') return info(s, `${dotted(field)} cannot be edited here. ${editElsewhere(field)}`);
  if (field.kind === 'boolean') {
    const r = apply(s, field, !(value ?? field.default ?? false));
    return r.error ? info(s, r.error, 'error') : { state: r.state };
  }
  s = { ...s, target: dotted(field) };
  if (field.kind === 'enum') return { state: { ...s, level: 'enum', choice: Math.max(0, field.choices.indexOf(String(value ?? field.default))), status: null } };
  if (field.kind === 'list') return { state: { ...s, level: field.itemChoices.length ? 'multi' : 'list', choice: 0, list: { cursor: 0, editing: null }, status: null } };
  const chars = cleanInput(value === undefined ? '' : String(value));
  return { state: { ...s, level: 'edit', edit: { chars, cursor: chars.length, error: null }, status: null } };
}

export function updateConfig(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  switch (s.level) {
    case 'quit': return updateQuit(ctx, s, k);
    case 'sections': return updateSections(ctx, s, k);
    case 'fields': return updateFields(ctx, s, k);
    case 'enum': return updateEnum(ctx, s, k);
    case 'edit': return updateEdit(ctx, s, k);
    case 'list': return updateList(ctx, s, k);
    case 'multi': return updateMulti(ctx, s, k);
  }
}

function updateQuit(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const ch = textOf(k).toLowerCase();
  if (ch === 'y' || (k.ctrl && k.name === 'c')) return { state: s, done: { value: 'closed' } };
  if (ch === 's') {
    const saved = save(ctx, s);
    return saved.state.status?.kind === 'ok' ? { ...saved, done: { value: 'closed' } } : { state: { ...saved.state, level: 'sections' } };
  }
  return { state: { ...s, level: 'sections', status: null } };
}

const quitOrClose = (s: ConfigState): Next => (isDirty(s) ? { state: { ...s, level: 'quit' } } : { state: s, done: { value: 'closed' } });
const wantsSave = (k: Key) => (k.ctrl && k.name === 's') || textOf(k) === 's';

/** `/` and `c` open the field list over all sections: a search, or what changed. Shared by both top levels. */
function openView(ctx: ConfigContext, s: ConfigState, k: Key): Next | null {
  const ch = textOf(k);
  if (ch === '/') {
    const prior = s.scope.kind === 'search' ? s.scope : { kind: 'search' as const, query: [], cursor: 0, typing: true };
    return { state: { ...s, level: 'fields', scope: { ...prior, typing: true }, row: 0, top: 0, status: null } };
  }
  if (ch === 'c') {
    if (!changedFields(ctx, s).length) return info(s, 'Nothing has changed since the last save.');
    return { state: { ...s, level: 'fields', scope: { kind: 'changed' }, row: 0, top: 0, status: null } };
  }
  return null;
}

function updateSections(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const n = s.sections.length;
  const ch = textOf(k);
  if (k.name === 'escape' || ch === 'q' || (k.ctrl && k.name === 'c')) return quitOrClose(s);
  if (wantsSave(k)) return save(ctx, s);
  const view = openView(ctx, s, k);
  if (view) return view;
  if (k.name === 'up' || ch === 'k') return { state: { ...s, section: Math.max(0, s.section - 1), status: null } };
  if (k.name === 'down' || ch === 'j') return { state: { ...s, section: Math.min(n - 1, s.section + 1), status: null } };
  if (k.name === 'home') return { state: { ...s, section: 0 } };
  if (k.name === 'end') return { state: { ...s, section: n - 1 } };
  if (isEnter(k) || k.name === 'right' || ch === 'l') return { state: { ...s, level: 'fields', scope: { kind: 'section' }, row: 0, top: 0, status: null } };
  return { state: s };
}

function updateFields(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const list = visibleFields(ctx, s);
  const field = fieldAt(ctx, s);
  const ch = textOf(k);
  const go = (row: number): Next => ({ state: { ...s, row: Math.max(0, Math.min(Math.max(0, list.length - 1), row)), status: null } });
  const back = (): Next => ({ state: { ...s, level: 'sections', scope: { kind: 'section' }, row: 0, top: 0, status: null } });

  if (s.scope.kind === 'search' && s.scope.typing) {
    const q = s.scope;
    if (k.name === 'escape') return back();
    if (k.ctrl && k.name === 'c') return quitOrClose(s);
    if (isEnter(k)) return { state: { ...s, scope: { ...q, typing: false }, status: null } };
    if (k.name === 'up') return go(s.row - 1);
    if (k.name === 'down') return go(s.row + 1);
    if (k.name === 'pageup') return go(s.row - 5);
    if (k.name === 'pagedown') return go(s.row + 5);
    const e = editLine(q.query, q.cursor, k);
    return e ? { state: { ...s, scope: { kind: 'search', query: e.chars, cursor: e.cursor, typing: true }, row: 0, top: 0 } } : { state: s };
  }

  if (k.name === 'escape' || k.name === 'left' || ch === 'q' || ch === 'h') return back();
  if (k.ctrl && k.name === 'c') return quitOrClose(s);
  if (wantsSave(k)) return save(ctx, s);
  const view = openView(ctx, s, k);
  if (view) return view;
  if (k.name === 'up' || ch === 'k') return go(s.row - 1);
  if (k.name === 'down' || ch === 'j') return go(s.row + 1);
  if (k.name === 'home') return go(0);
  if (k.name === 'end') return go(list.length - 1);
  if (k.name === 'pageup') return go(s.row - 5);
  if (k.name === 'pagedown') return go(s.row + 5);
  if (!field) return { state: s };
  if (ch === 'x' || k.name === 'delete') {
    if (!field.optional || field.fixed) return info(s, `${dotted(field)} is required and cannot be unset.`);
    const r = apply(s, field, undefined);
    return r.error ? info(s, r.error, 'error') : { state: { ...r.state, status: { kind: 'info', text: `${dotted(field)} reset (the default applies).` } } };
  }
  if (isEnter(k) || ch === 'e' || ch === ' ' || k.name === 'right') return open(s, field);
  return { state: s };
}

function updateEnum(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const field = fieldAt(ctx, s)!;
  const n = field.choices.length;
  const ch = textOf(k);
  if (isCancel(k) || k.name === 'left') return { state: { ...s, level: 'fields' } };
  if (k.name === 'up' || ch === 'k') return { state: { ...s, choice: Math.max(0, s.choice - 1) } };
  if (k.name === 'down' || ch === 'j') return { state: { ...s, choice: Math.min(n - 1, s.choice + 1) } };
  if (isEnter(k)) {
    const r = apply(s, field, field.choices[s.choice], { level: 'fields' });
    return r.error ? info({ ...s, level: 'fields' }, r.error, 'error') : { state: r.state };
  }
  return { state: s };
}

function updateEdit(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const field = fieldAt(ctx, s)!;
  if (isCancel(k)) return { state: { ...s, level: 'fields', status: null } };
  if (isEnter(k)) {
    const c = coerce(field, s.edit.chars.join('').trim());
    if (!c.ok) return { state: { ...s, edit: { ...s.edit, error: c.error } } };
    const r = apply(s, field, c.value, { level: 'fields' });
    return r.error ? { state: { ...s, edit: { ...s.edit, error: r.error } } } : { state: r.state };
  }
  const e = editLine(s.edit.chars, s.edit.cursor, k);
  return { state: e ? { ...s, edit: { ...e, error: null } } : s };
}

/** A list of free-text items (hosts, repositories, argv): each add, edit and removal is validated and applied at once. */
function updateList(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const field = fieldAt(ctx, s)!;
  const items = listOf(field, s.draft);
  const ed = s.list.editing;
  const ch = textOf(k);
  if (ed) {
    if (isCancel(k)) return { state: { ...s, list: { ...s.list, editing: null } } };
    if (isEnter(k)) {
      const text = ed.chars.join('').trim();
      if (!text) return { state: { ...s, list: { ...s.list, editing: null } } };
      const next = ed.index < items.length ? items.map((x, i) => (i === ed.index ? text : x)) : [...items, text];
      const r = apply(s, field, next, { list: { cursor: ed.index, editing: null } });
      return r.error ? { state: { ...s, list: { ...s.list, editing: { ...ed, error: r.error } } } } : { state: r.state };
    }
    const e = editLine(ed.chars, ed.cursor, k);
    return { state: e ? { ...s, list: { ...s.list, editing: { ...ed, ...e, error: null } } } : s };
  }
  const add = (): Next => ({ state: { ...s, list: { cursor: items.length, editing: { index: items.length, chars: [], cursor: 0, error: null } } } });
  if (isCancel(k) || k.name === 'left' || ch === 'q') return { state: { ...s, level: 'fields', status: null } };
  if (k.name === 'up' || ch === 'k') return { state: { ...s, list: { cursor: Math.max(0, s.list.cursor - 1), editing: null } } };
  if (k.name === 'down' || ch === 'j') return { state: { ...s, list: { cursor: Math.min(items.length, s.list.cursor + 1), editing: null } } };
  if (ch === 'a' || ch === '+') return add();
  if (isEnter(k) || ch === 'e' || ch === ' ' || k.name === 'right') {
    if (s.list.cursor >= items.length) return add();
    const chars = cleanInput(items[s.list.cursor]!);
    return { state: { ...s, list: { cursor: s.list.cursor, editing: { index: s.list.cursor, chars, cursor: chars.length, error: null } } } };
  }
  if ((ch === 'd' || ch === 'x' || k.name === 'delete' || k.name === 'backspace') && s.list.cursor < items.length) {
    const r = apply(s, field, items.filter((_, i) => i !== s.list.cursor), { list: { cursor: Math.max(0, Math.min(s.list.cursor, items.length - 2)), editing: null } });
    return r.error ? info(s, r.error, 'error') : { state: r.state };
  }
  return { state: s };
}

/** A list whose items come from a fixed set (skills, connectors, escalated capabilities): ticked with Space. */
function updateMulti(ctx: ConfigContext, s: ConfigState, k: Key): Next {
  const field = fieldAt(ctx, s)!;
  const n = field.itemChoices.length;
  const ch = textOf(k);
  if (isCancel(k) || isEnter(k) || k.name === 'left' || ch === 'q') return { state: { ...s, level: 'fields', status: null } };
  if (k.name === 'up' || ch === 'k') return { state: { ...s, choice: Math.max(0, s.choice - 1) } };
  if (k.name === 'down' || ch === 'j') return { state: { ...s, choice: Math.min(n - 1, s.choice + 1) } };
  if (ch === ' ' || k.name === 'space' || k.name === 'right') {
    const value = field.itemChoices[s.choice]!;
    const now = listOf(field, s.draft);
    const next = field.itemChoices.filter((c) => (c === value ? !now.includes(c) : now.includes(c)));
    const r = apply(s, field, next);
    return r.error ? info(s, r.error, 'error') : { state: r.state };
  }
  return { state: s };
}

// ---------- views ----------

function secretNote(ctx: ConfigContext, s: ConfigState, f: Field): string {
  if (!f.secretName || !ctx.secretStatus) return '';
  const explicit = getAt(s.draft, f.path);
  const name = explicit ?? (dotted(f) === 'model.apiKeyEnv' ? keyEnvOf(s.draft.model) : f.default);
  if (typeof name !== 'string' || !name) return '';
  const status = ctx.secretStatus(name);
  const word = status === 'set' ? '✓ found' : status === 'missing' ? '✗ not found' : '? store locked';
  // An unset field uses a default name; say which, so the note is not about a name that is not on screen.
  return `  ${explicit === undefined ? `${sanitize(name)} ` : ''}${word}`;
}

function describe(ctx: ConfigContext, s: ConfigState, f: Field, width: number): string[] {
  const t = ctx.theme;
  const bits = [f.kind === 'enum' ? `one of ${f.choices.join(' | ')}` : f.kind === 'list' ? (f.itemChoices.length ? `pick from ${f.itemChoices.join(', ')}` : 'a list of text items') : f.kind];
  if (f.default !== undefined && typeof f.default !== 'object') bits.push(`default ${JSON.stringify(f.default)}`);
  if (f.secretName) bits.push('a NAME, not a value: the key itself lives in the environment or `garnet secrets`');
  if (f.secretValue) bits.push('hidden: secrets never live in config');
  if (!f.optional) bits.push('required');
  const note = secretNote(ctx, s, f).trim();
  const inner = Math.max(10, width - 4);
  return [...(f.description ? wrapText(t.muted(sanitize(f.description)), inner) : []), ...wrapText(t.muted(bits.join(' · ')), inner), ...(note ? [t.muted(note)] : [])];
}

const countLabel = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** The right-hand preview of a section on wide terminals: its settings and current values. */
function preview(ctx: ConfigContext, s: ConfigState, section: string, width: number, rows: number): string[] {
  const t = ctx.theme;
  const fields = ctx.fields.filter((f) => f.section === section);
  const labelW = Math.min(26, Math.max(...fields.map((f) => dotted(f).length)) + 1);
  const out = [t.bold(sectionTitle(section)), ''];
  for (const f of fields.slice(0, Math.max(0, rows - out.length - 1))) {
    out.push(truncate(`${padEnd(truncate(dotted(f), labelW), labelW)} ${displayValue(f, getAt(s.draft, f.path))}`, width));
  }
  if (fields.length > out.length - 2) out.push(t.muted(`… ${fields.length - (out.length - 2)} more`));
  return out;
}

export function viewConfig(ctx: ConfigContext, s: ConfigState, width: number, height: number): Frame {
  const t = ctx.theme;
  const dirty = isDirty(s);
  const count = changedFields(ctx, s).length;
  const base = { theme: t, width, height, title: 'CONFIG', status: dirty ? `unsaved changes${count ? ` (${count})` : ''}` : 'no changes' };
  const note = s.status ? [`${s.status.kind === 'error' ? t.error('✗') : s.status.kind === 'ok' ? t.ok('✓') : t.warn('!')} ${sanitize(s.status.text)}`] : [];
  const fixed = height >= 14 ? 5 : height >= 8 ? 3 : 0;
  const inner = Math.max(10, width - 4);
  switch (s.level) {
    case 'sections': return viewSections(ctx, s, base, note, width, height, inner);
    case 'fields': return viewFields(ctx, s, base, note, width, height, inner, fixed);
    case 'edit': {
      const field = fieldAt(ctx, s)!;
      const w = inputWindow(s.edit.chars, s.edit.cursor, inner - 2);
      const core = [t.bold(dotted(field)), ...describe(ctx, s, field, width).slice(0, 4), '', `${t.accent('›')} ${w.text}`];
      const row = core.length - 1;
      if (s.edit.error) core.push('', `${t.error('✗')} ${sanitize(s.edit.error)}`);
      return renderPage({ ...base, core, focus: row, hints: field.optional ? 'Enter accept · empty = unset · Esc cancel' : 'Enter accept · Esc cancel', cursor: { row, col: 2 + w.col } });
    }
    case 'enum': {
      const field = fieldAt(ctx, s)!;
      const core = [t.bold(dotted(field)), ...describe(ctx, s, field, width).slice(0, 3), ''];
      const first = core.length;
      field.choices.forEach((c, i) => core.push(`${i === s.choice ? t.accent('›') : ' '} ${i === s.choice ? t.bold(sanitize(c)) : sanitize(c)}`));
      return renderPage({ ...base, core, focus: first + s.choice, hints: '↑/↓ move · Enter choose · Esc cancel' });
    }
    case 'multi': {
      const field = fieldAt(ctx, s)!;
      const on = listOf(field, s.draft);
      const core = [t.bold(dotted(field)), ...describe(ctx, s, field, width).slice(0, 3), ...note, ''];
      const first = core.length;
      field.itemChoices.forEach((c, i) => core.push(`${i === s.choice ? t.accent('›') : ' '} ${on.includes(c) ? t.ok('[x]') : '[ ]'} ${i === s.choice ? t.bold(sanitize(c)) : sanitize(c)}`));
      return renderPage({ ...base, core, focus: first + s.choice, hints: '↑/↓ move · Space toggle · Enter done' });
    }
    case 'list': return viewList(ctx, s, base, note, width, inner);
    case 'quit':
      return renderPage({ ...base, core: [t.bold('You have unsaved changes.'), '', 's  save and quit', 'y  discard and quit', 'any other key  keep editing'], focus: 0, hints: 's save · y discard · Esc keep editing' });
  }
}

type Base = { theme: Theme; width: number; height: number; title: string; status: string };

function viewSections(ctx: ConfigContext, s: ConfigState, base: Base, note: string[], width: number, height: number, inner: number): Frame {
  const t = ctx.theme;
  const wide = width >= 100;
  const leftW = wide ? 50 : inner;
  // A status line takes the blank row under the header, so it stays in view however long the list is.
  const head = [t.bold('Settings'), t.muted(truncate(ctx.file, inner)), note[0] ?? ''];
  const left = s.sections.map((name, i) => {
    const on = i === s.section;
    const info = SECTION_INFO[name];
    const n = ctx.fields.filter((f) => f.section === name).length;
    const edited = ctx.fields.filter((f) => f.section === name && changed(s, f)).length;
    const title = padEnd(sectionTitle(name), 18);
    const summary = sanitize(info?.summary ? info.summary(s.draft) : countLabel(n, 'setting'));
    return truncate(`${on ? t.accent('›') : ' '} ${on ? t.bold(title) : title} ${t.muted(summary)}${edited ? t.warn(` (${edited} changed)`) : ''}`, leftW);
  });
  let body = left;
  if (wide) {
    const right = preview(ctx, s, s.sections[s.section]!, width - leftW - 8, Math.max(left.length, height - 10));
    const rows = Math.max(left.length, right.length);
    body = Array.from({ length: rows }, (_, i) => `${padEnd(left[i] ?? '', leftW)} ${t.rule('│')} ${right[i] ?? ''}`);
  }
  const name = s.sections[s.section]!;
  const blurb = SECTION_INFO[name]?.blurb ?? ctx.descriptions[name];
  const tail = blurb && !wide && height >= 14 + s.sections.length ? ['', ...wrapText(t.muted(sanitize(blurb)), inner)] : [];
  return renderPage({ ...base, core: [...head, ...body, ...tail], focus: head.length + s.section, hints: `↑/↓ move · Enter open · / search · c changes · s save · q ${isDirty(s) ? 'quit (asks)' : 'quit'}` });
}

function viewFields(ctx: ConfigContext, s: ConfigState, base: Base, note: string[], width: number, height: number, inner: number, fixed: number): Frame {
  const t = ctx.theme;
  const list = visibleFields(ctx, s);
  const field = fieldAt(ctx, s);
  const detail = field ? describe(ctx, s, field, width).slice(0, 5) : [];
  const scope = s.scope;
  const head: string[] = [];
  let cursor: { row: number; col: number } | undefined;
  if (scope.kind === 'search') {
    const w = inputWindow(scope.query, scope.cursor, inner - 4);
    head.push(t.bold('Search settings'), `${t.accent('/')} ${scope.typing ? w.text : scope.query.join('')}${scope.typing ? '' : t.muted('  (/ to change)')}`, '');
    if (scope.typing) cursor = { row: 1, col: 2 + w.col };
  } else if (scope.kind === 'changed') {
    head.push(t.bold(`Changed since the last save (${list.length})`), '');
  } else {
    head.push(t.bold(sectionTitle(s.sections[s.section]!)), '');
  }
  const roomBase = height - fixed - head.length - note.length;
  const showDetail = roomBase - detail.length - 1 >= 4;
  const room = Math.max(1, roomBase - (showDetail ? detail.length + 1 : 0));
  const row = Math.min(s.row, Math.max(0, list.length - 1));
  const top = listWindow(list.length, row, room, s.top);
  const labelW = Math.min(30, Math.max(8, ...list.map((f) => dotted(f).length)) + 1);
  const core = [...head];
  if (!list.length) core.push(t.muted(scope.kind === 'search' ? 'No settings match.' : 'Nothing here.'));
  for (const [i, f] of list.slice(top, top + room).entries()) {
    const on = top + i === row;
    const label = padEnd(truncate(dotted(f), labelW), labelW);
    const v = displayValue(f, getAt(s.draft, f.path));
    const line = `${on ? t.accent('›') : ' '} ${on ? t.bold(label) : label} ${v}${changed(s, f) ? t.warn(' (changed)') : ''}${t.muted(secretNote(ctx, s, f))}`;
    core.push(truncate(line, inner));
  }
  if (showDetail) core.push('', ...detail);
  if (note.length) core.push(...note);
  const pos = list.length > room ? ` · ${row + 1}/${list.length}` : '';
  const typing = scope.kind === 'search' && scope.typing;
  const hints = typing ? 'type to filter · ↑/↓ move · Enter keep results · Esc close' : `↑/↓ move · Enter edit · x reset · / search · c changes · s save · Esc back${pos}`;
  return renderPage({ ...base, core, focus: head.length + (row - top), hints, ...(cursor ? { cursor } : {}) });
}

function viewList(ctx: ConfigContext, s: ConfigState, base: Base, note: string[], width: number, inner: number): Frame {
  const t = ctx.theme;
  const field = fieldAt(ctx, s)!;
  const items = listOf(field, s.draft);
  const ed = s.list.editing;
  const core = [t.bold(dotted(field)), ...describe(ctx, s, field, width).slice(0, 3), ...note, ''];
  const first = core.length;
  let cursor: { row: number; col: number } | undefined;
  const rows = [...items.map((x) => sanitize(x)), t.muted('+ add an item')];
  rows.forEach((text, i) => {
    if (ed && ed.index === i) {
      const w = inputWindow(ed.chars, ed.cursor, inner - 4);
      core.push(`${t.accent('›')} ${w.text}`);
      cursor = { row: core.length - 1, col: 2 + w.col };
    } else {
      const on = i === s.list.cursor && !ed;
      core.push(`${on ? t.accent('›') : ' '} ${on && i < items.length ? t.bold(text) : text}`);
    }
  });
  if (ed && ed.index >= items.length) {
    // The new item is typed on its own row, above the "add" row.
    const w = inputWindow(ed.chars, ed.cursor, inner - 4);
    core.pop();
    core.push(`${t.accent('›')} ${w.text}`);
    cursor = { row: core.length - 1, col: 2 + w.col };
  }
  if (ed?.error) core.push('', `${t.error('✗')} ${sanitize(ed.error)}`);
  const hints = ed ? 'Enter accept · empty = cancel · Esc cancel' : '↑/↓ move · a add · Enter edit · d remove · Esc done';
  return renderPage({ ...base, core, focus: first + s.list.cursor, hints, ...(cursor ? { cursor } : {}) });
}

/** Builds the browser as a `Screen`, for `FullscreenSession.run`. */
export function configScreen(config: GarnetConfig, deps: { save: (c: GarnetConfig) => void; file: string; theme: Theme; secretStatus?: (name: string) => SecretStatus }): Screen<ConfigState, Done> {
  const { fields, schema } = configFields();
  const descriptions: Record<string, string> = {};
  for (const [k, v] of Object.entries((schema as JsonSchema).properties ?? {})) if (v.properties && v.description) descriptions[k] = v.description;
  const ctx: ConfigContext = { fields, descriptions, save: deps.save, file: deps.file, theme: deps.theme, ...(deps.secretStatus ? { secretStatus: deps.secretStatus } : {}) };
  return {
    state: initialConfigState(config, fields),
    update: (s, k) => updateConfig(ctx, s, k),
    view: (s, w, h) => viewConfig(ctx, s, w, h),
  };
}
