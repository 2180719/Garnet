// `garnet config` on a terminal: a fullscreen browser and editor for config.json.
// The field list is generated from the config schema (so new settings, such as
// new providers' fields, appear on their own), descriptions come from the
// schema's `.describe()`, and every edit is validated with `configSchema`
// before it is kept. Secret values are never shown or accepted here: only the
// NAMES of environment variables or stored secrets (`apiKeyEnv`, `tokenEnv`).
import { configSchema, redact, type GarnetConfig } from '../../config/index.ts';
import type { Key } from '../chat/keys.ts';
import type { Theme } from '../chat/theme.ts';
import { padEnd, sanitize, truncate, wrapText } from '../chat/text.ts';
import type { Frame, Screen, Step } from './fullscreen.ts';
import { cleanInput, inputWindow, listWindow, renderPage } from './layout.ts';

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
};

export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'complex';

export type Field = {
  /** `model.apiKeyEnv`. */
  path: string[];
  section: string;
  kind: FieldKind;
  description: string;
  default: unknown;
  choices: string[];
  /** Not required by the schema: may be unset (the default or "none" applies). */
  optional: boolean;
  /** Holds the NAME of an environment variable or stored secret. */
  secretName: boolean;
  /** Would hold a secret value: shown as hidden, never editable here. */
  secretValue: boolean;
  /** Fixed by the schema (the config version). */
  fixed: boolean;
};

const SECRET_KEY = /(key|token|secret|password|authorization|cookie)/i;
export const GENERAL = 'general';

/** Generates the field list from a JSON schema (`configSchema.toJSONSchema({ io: 'input' })`). Pure. */
export function fieldsFromSchema(schema: JsonSchema): Field[] {
  const out: Field[] = [];
  const walk = (node: JsonSchema, path: string[], inherited = '') => {
    const required = new Set(node.required ?? []);
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const here = [...path, key];
      if (child.properties && Object.keys(child.properties).length) {
        walk(child, here, child.description ?? inherited);
        continue;
      }
      const kind: FieldKind = child.enum && child.type === 'string' ? 'enum' : child.type === 'string' || child.type === 'number' || child.type === 'integer' || child.type === 'boolean' ? child.type : 'complex';
      const secretName = key.endsWith('Env');
      out.push({
        path: here,
        section: path.length ? path[0]! : GENERAL,
        kind,
        description: child.description ?? inherited,
        default: child.default,
        choices: (child.enum ?? []).map(String),
        optional: !required.has(key),
        secretName,
        secretValue: !secretName && kind === 'string' && SECRET_KEY.test(key),
        fixed: child.const !== undefined,
      });
    }
  };
  walk(schema, []);
  return out;
}

export function getAt(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** A copy of `root` with `path` set (or removed when `value` is undefined). */
export function setAt(root: unknown, path: string[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  const obj = { ...((root && typeof root === 'object' ? root : {}) as Record<string, unknown>) };
  if (rest.length === 0 && value === undefined) delete obj[head];
  else obj[head] = setAt(obj[head], rest, value);
  return obj;
}

/** How a value is displayed. Never a secret: credential-looking strings are redacted and secret-valued fields hidden. */
export function displayValue(field: Field, value: unknown): string {
  if (field.secretValue) return value === undefined || value === '' ? '(unset)' : '[hidden]';
  if (value === undefined) return '(unset)';
  if (field.kind === 'boolean') return value ? '[x] on' : '[ ] off';
  if (field.kind === 'complex') {
    const text = JSON.stringify(redact(value));
    return Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}: ${text}` : text;
  }
  const shown = redact({ [field.path[field.path.length - 1]!]: value })[field.path[field.path.length - 1]!];
  return sanitize(String(shown));
}

export type ConfigStatus = { text: string; kind: 'ok' | 'error' | 'info' } | null;

export type ConfigState = {
  draft: GarnetConfig;
  saved: string;
  level: 'sections' | 'fields' | 'edit' | 'enum' | 'quit';
  sections: string[];
  section: number;
  row: number;
  /** Scroll offset of the field list. */
  top: number;
  edit: { chars: string[]; cursor: number; error: string | null };
  choice: number;
  status: ConfigStatus;
};

export type ConfigContext = {
  fields: Field[];
  descriptions: Record<string, string>;
  /** Writes the validated config (the real one calls `writeConfig`). */
  save: (config: GarnetConfig) => void;
  file: string;
  theme: Theme;
};

const key = (c: GarnetConfig) => JSON.stringify(c);

export function initialConfigState(config: GarnetConfig, fields: Field[]): ConfigState {
  const sections = [...new Set(fields.map((f) => f.section))];
  return { draft: config, saved: key(config), level: 'sections', sections, section: 0, row: 0, top: 0, edit: { chars: [], cursor: 0, error: null }, choice: 0, status: null };
}

export const isDirty = (s: ConfigState) => key(s.draft) !== s.saved;
const sectionFields = (c: ConfigContext, s: ConfigState) => c.fields.filter((f) => f.section === s.sections[s.section]);
const dotted = (f: Field) => f.path.join('.');

/** Validates the draft with the schema after changing `path`; the new draft, or the first problem. */
export function tryChange(draft: GarnetConfig, field: Field, value: unknown): { ok: true; draft: GarnetConfig } | { ok: false; error: string } {
  const parsed = configSchema.safeParse(setAt(draft, field.path, value));
  if (parsed.success) return { ok: true, draft: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

function coerce(field: Field, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field.kind === 'string') return { ok: true, value: text === '' && field.optional ? undefined : text };
  if (text === '') return field.optional ? { ok: true, value: undefined } : { ok: false, error: 'A value is required.' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: `"${text}" is not a number.` };
  if (field.kind === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'A whole number is required.' };
  return { ok: true, value: n };
}

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

export function updateConfig(ctx: ConfigContext, s: ConfigState, k: Key): Step<ConfigState, Done> {
  const enter = (k.name === 'enter' || k.name === 'linefeed') && !k.meta;
  const ch = k.name === 'text' ? (k.text ?? '') : '';
  const save = (): Step<ConfigState, Done> => {
    const parsed = configSchema.safeParse(s.draft);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      return { state: { ...s, status: { kind: 'error', text: `Not saved: ${i.path.join('.')}: ${i.message}` } } };
    }
    try {
      ctx.save(parsed.data);
    } catch (e) {
      return { state: { ...s, status: { kind: 'error', text: `Not saved: ${e instanceof Error ? e.message : String(e)}` } } };
    }
    return { state: { ...s, draft: parsed.data, saved: key(parsed.data), status: { kind: 'ok', text: `Saved ${ctx.file}` } } };
  };
  const wantsSave = (k.ctrl && k.name === 's') || (ch === 's' && s.level !== 'edit');
  switch (s.level) {
    case 'quit': {
      if (ch.toLowerCase() === 'y' || (k.ctrl && k.name === 'c')) return { state: s, done: { value: 'closed' } };
      if (ch.toLowerCase() === 's') {
        const saved = save();
        return saved.state.status?.kind === 'ok' ? { ...saved, done: { value: 'closed' } } : { state: { ...saved.state, level: 'sections' } };
      }
      return { state: { ...s, level: 'sections', status: null } };
    }
    case 'sections': {
      const n = s.sections.length;
      if (k.name === 'escape' || ch === 'q' || (k.ctrl && k.name === 'c')) return isDirty(s) ? { state: { ...s, level: 'quit' } } : { state: s, done: { value: 'closed' } };
      if (wantsSave) return save();
      if (k.name === 'up' || ch === 'k') return { state: { ...s, section: Math.max(0, s.section - 1), status: null } };
      if (k.name === 'down' || ch === 'j') return { state: { ...s, section: Math.min(n - 1, s.section + 1), status: null } };
      if (k.name === 'home') return { state: { ...s, section: 0 } };
      if (k.name === 'end') return { state: { ...s, section: n - 1 } };
      if (enter || k.name === 'right' || ch === 'l') return { state: { ...s, level: 'fields', row: 0, top: 0, status: null } };
      return { state: s };
    }
    case 'fields': {
      const list = sectionFields(ctx, s);
      const field = list[s.row];
      const go = (row: number) => ({ state: { ...s, row: Math.max(0, Math.min(list.length - 1, row)), status: null } });
      if (k.name === 'escape' || k.name === 'left' || ch === 'q' || ch === 'h') return { state: { ...s, level: 'sections', status: null } };
      if (k.ctrl && k.name === 'c') return isDirty(s) ? { state: { ...s, level: 'quit' } } : { state: s, done: { value: 'closed' } };
      if (wantsSave) return save();
      if (k.name === 'up' || ch === 'k') return go(s.row - 1);
      if (k.name === 'down' || ch === 'j') return go(s.row + 1);
      if (k.name === 'home') return go(0);
      if (k.name === 'end') return go(list.length - 1);
      if (k.name === 'pageup') return go(s.row - 5);
      if (k.name === 'pagedown') return go(s.row + 5);
      if (!field) return { state: s };
      const value = getAt(s.draft, field.path);
      if (ch === 'x' || k.name === 'delete') {
        if (!field.optional || field.fixed) return { state: { ...s, status: { kind: 'info', text: `${dotted(field)} is required and cannot be unset.` } } };
        const r = tryChange(s.draft, field, undefined);
        return r.ok ? { state: { ...s, draft: r.draft, status: { kind: 'info', text: `${dotted(field)} reset (the default applies).` } } } : { state: { ...s, status: { kind: 'error', text: r.error } } };
      }
      if (!(enter || ch === 'e' || ch === ' ' || k.name === 'right')) return { state: s };
      if (field.fixed) return { state: { ...s, status: { kind: 'info', text: `${dotted(field)} is fixed.` } } };
      if (field.secretValue) return { state: { ...s, status: { kind: 'info', text: 'Secrets never live in config.json. Store the value with `garnet secrets set NAME` and set the *Env field to its name.' } } };
      if (field.kind === 'complex') return { state: { ...s, status: { kind: 'info', text: `${dotted(field)} is a list or table: edit config.json by hand (\`garnet config explain\` describes it).` } } };
      if (field.kind === 'boolean') {
        const r = tryChange(s.draft, field, !(value ?? field.default ?? false));
        return r.ok ? { state: { ...s, draft: r.draft, status: null } } : { state: { ...s, status: { kind: 'error', text: r.error } } };
      }
      if (field.kind === 'enum') return { state: { ...s, level: 'enum', choice: Math.max(0, field.choices.indexOf(String(value ?? field.default))), status: null } };
      const chars = cleanInput(value === undefined ? '' : String(value));
      return { state: { ...s, level: 'edit', edit: { chars, cursor: chars.length, error: null }, status: null } };
    }
    case 'enum': {
      const field = sectionFields(ctx, s)[s.row]!;
      const n = field.choices.length;
      if (k.name === 'escape' || (k.ctrl && k.name === 'c') || k.name === 'left') return { state: { ...s, level: 'fields' } };
      if (k.name === 'up' || ch === 'k') return { state: { ...s, choice: Math.max(0, s.choice - 1) } };
      if (k.name === 'down' || ch === 'j') return { state: { ...s, choice: Math.min(n - 1, s.choice + 1) } };
      if (enter) {
        const r = tryChange(s.draft, field, field.choices[s.choice]);
        return r.ok ? { state: { ...s, draft: r.draft, level: 'fields', status: null } } : { state: { ...s, level: 'fields', status: { kind: 'error', text: r.error } } };
      }
      return { state: s };
    }
    case 'edit': {
      const field = sectionFields(ctx, s)[s.row]!;
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return { state: { ...s, level: 'fields', status: null } };
      if (enter) {
        const c = coerce(field, s.edit.chars.join('').trim());
        if (!c.ok) return { state: { ...s, edit: { ...s.edit, error: c.error } } };
        const r = tryChange(s.draft, field, c.value);
        if (!r.ok) return { state: { ...s, edit: { ...s.edit, error: r.error } } };
        return { state: { ...s, draft: r.draft, level: 'fields', status: null } };
      }
      const e = editLine(s.edit.chars, s.edit.cursor, k);
      return { state: e ? { ...s, edit: { ...e, error: null } } : s };
    }
  }
}

function describe(f: Field, theme: Theme, width: number): string[] {
  const t = theme;
  const bits = [f.kind === 'enum' ? `one of ${f.choices.join(' | ')}` : f.kind];
  if (f.default !== undefined && typeof f.default !== 'object') bits.push(`default ${JSON.stringify(f.default)}`);
  if (f.secretName) bits.push('a NAME, not a value: the key itself lives in the environment or `garnet secrets`');
  if (f.secretValue) bits.push('hidden: secrets never live in config');
  if (!f.optional) bits.push('required');
  return [...(f.description ? wrapText(t.muted(sanitize(f.description)), Math.max(10, width - 4)) : []), ...wrapText(t.muted(bits.join(' · ')), Math.max(10, width - 4))];
}

export function viewConfig(ctx: ConfigContext, s: ConfigState, width: number, height: number): Frame {
  const t = ctx.theme;
  const dirty = isDirty(s);
  const status = dirty ? 'unsaved changes' : 'no changes';
  const base = { theme: t, width, height, title: 'CONFIG', status };
  const note = s.status ? [`${s.status.kind === 'error' ? t.error('✗') : s.status.kind === 'ok' ? t.ok('✓') : t.warn('!')} ${sanitize(s.status.text)}`] : [];
  const fixed = height >= 14 ? 5 : height >= 8 ? 3 : 0;
  const inner = Math.max(10, width - 4);
  switch (s.level) {
    case 'sections': {
      const core = [t.bold('Settings'), t.muted(truncate(ctx.file, inner)), ''];
      const first = core.length;
      s.sections.forEach((name, i) => {
        const count = ctx.fields.filter((f) => f.section === name).length;
        const on = i === s.section;
        const label = padEnd(name, 14);
        core.push(`${on ? t.accent('›') : ' '} ${on ? t.bold(label) : label} ${t.muted(`${count} setting${count === 1 ? '' : 's'}`)}`);
      });
      const desc = ctx.descriptions[s.sections[s.section]!];
      if (desc && height >= 16 + s.sections.length) core.push('', ...wrapText(t.muted(sanitize(desc)), inner));
      return renderPage({ ...base, core: [...core, ...(note.length ? ['', ...note] : [])], focus: first + s.section, hints: `↑/↓ move · Enter open · s save · q ${dirty ? 'quit (asks)' : 'quit'}` });
    }
    case 'fields': {
      const list = sectionFields(ctx, s);
      const field = list[s.row];
      const detail = field ? describe(field, t, width).slice(0, 5) : [];
      const roomBase = height - fixed - 2 - note.length;
      const showDetail = roomBase - detail.length - 1 >= 4;
      const room = Math.max(1, roomBase - (showDetail ? detail.length + 1 : 0));
      const top = listWindow(list.length, s.row, room, s.top);
      const labelW = Math.min(30, Math.max(...list.map((f) => dotted(f).length)) + 1);
      const core = [t.bold(s.sections[s.section]!), ''];
      const rows = list.slice(top, top + room).map((f, i) => {
        const on = top + i === s.row;
        const original = getAt(JSON.parse(s.saved) as unknown, f.path);
        const changed = JSON.stringify(original) !== JSON.stringify(getAt(s.draft, f.path));
        const v = displayValue(f, getAt(s.draft, f.path));
        const label = padEnd(truncate(dotted(f), labelW), labelW);
        const line = `${on ? t.accent('›') : ' '} ${on ? t.bold(label) : label} ${v}${changed ? t.warn(' (changed)') : ''}`;
        return truncate(line, inner);
      });
      core.push(...rows);
      if (showDetail) core.push('', ...detail);
      if (note.length) core.push(...note);
      const pos = list.length > room ? ` · ${s.row + 1}/${list.length}` : '';
      return renderPage({ ...base, core, focus: 2 + (s.row - top), hints: `↑/↓ move · Enter edit · x reset · s save · Esc back${pos}` });
    }
    case 'edit': {
      const field = sectionFields(ctx, s)[s.row]!;
      const w = inputWindow(s.edit.chars, s.edit.cursor, inner - 2);
      const core = [t.bold(dotted(field)), ...describe(field, t, width).slice(0, 4), '', `${t.accent('›')} ${w.text}`];
      const row = core.length - 1;
      if (s.edit.error) core.push('', `${t.error('✗')} ${sanitize(s.edit.error)}`);
      return renderPage({ ...base, core, focus: row, hints: field.optional ? 'Enter accept · empty = unset · Esc cancel' : 'Enter accept · Esc cancel', cursor: { row, col: 2 + w.col } });
    }
    case 'enum': {
      const field = sectionFields(ctx, s)[s.row]!;
      const core = [t.bold(dotted(field)), ...describe(field, t, width).slice(0, 3), ''];
      const first = core.length;
      field.choices.forEach((c, i) => core.push(`${i === s.choice ? t.accent('›') : ' '} ${i === s.choice ? t.bold(sanitize(c)) : sanitize(c)}`));
      return renderPage({ ...base, core, focus: first + s.choice, hints: '↑/↓ move · Enter choose · Esc cancel' });
    }
    case 'quit':
      return renderPage({ ...base, core: [t.bold('You have unsaved changes.'), '', 's  save and quit', 'y  discard and quit', 'any other key  keep editing'], focus: 0, hints: 's save · y discard · Esc keep editing' });
  }
}

/** Builds the browser as a `Screen`, for `FullscreenSession.run`. */
export function configScreen(config: GarnetConfig, deps: { save: (c: GarnetConfig) => void; file: string; theme: Theme }): Screen<ConfigState, Done> {
  const schema = (configSchema as unknown as { toJSONSchema: (o: { io: 'input' }) => JsonSchema }).toJSONSchema({ io: 'input' });
  const fields = fieldsFromSchema(schema);
  const descriptions: Record<string, string> = {};
  for (const [k, v] of Object.entries(schema.properties ?? {})) if (v.properties && v.description) descriptions[k] = v.description;
  const ctx: ConfigContext = { fields, descriptions, save: deps.save, file: deps.file, theme: deps.theme };
  return {
    state: initialConfigState(config, fields),
    update: (s, k) => updateConfig(ctx, s, k),
    view: (s, w, h) => viewConfig(ctx, s, w, h),
  };
}
