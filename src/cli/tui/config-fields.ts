// The settings the config browser edits: a flat field list generated from the config schema, plus the pure
// helpers to read, write, display and validate one field. Secret VALUES never appear here: a field either
// holds the NAME of a secret (`apiKeyEnv`, `tokenEnv`) or is hidden and refused.
import { configSchema, redact, type GarnetConfig } from '../../config/index.ts';
import { sanitize } from '../chat/text.ts';

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
};

/** `list` is an array of plain strings (hosts, argv, names); other arrays and tables are `complex`. */
export type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'list' | 'complex';

export type Field = {
  /** `model.apiKeyEnv`. */
  path: string[];
  section: string;
  kind: FieldKind;
  description: string;
  default: unknown;
  /** Allowed values of an `enum` field. */
  choices: string[];
  /** For a `list` whose items come from a fixed set (skills, connectors): that set; empty for free text. */
  itemChoices: string[];
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
      const isList = child.type === 'array' && child.items?.type === 'string';
      const kind: FieldKind = isList
        ? 'list'
        : child.enum && child.type === 'string'
          ? 'enum'
          : child.type === 'string' || child.type === 'number' || child.type === 'integer' || child.type === 'boolean'
            ? child.type
            : 'complex';
      const secretName = key.endsWith('Env');
      out.push({
        path: here,
        section: path.length ? path[0]! : GENERAL,
        kind,
        description: child.description ?? inherited,
        default: child.default,
        choices: (child.enum ?? []).map(String),
        itemChoices: isList ? (child.items?.enum ?? []).map(String) : [],
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

/** The fields of the real config schema. */
export function configFields(): { fields: Field[]; schema: JsonSchema } {
  const schema = (configSchema as unknown as { toJSONSchema: (o: { io: 'input' }) => JsonSchema }).toJSONSchema({ io: 'input' });
  return { fields: fieldsFromSchema(schema), schema };
}

export const dotted = (f: Field): string => f.path.join('.');

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

/** The items of a list field (its default, then empty, when unset). */
export function listOf(field: Field, draft: unknown): string[] {
  const v = getAt(draft, field.path) ?? field.default;
  return Array.isArray(v) ? v.map(String) : [];
}

/** How a value is displayed. Never a secret: credential-looking strings are redacted and secret-valued fields hidden. */
export function displayValue(field: Field, value: unknown): string {
  if (field.secretValue) return value === undefined || value === '' ? '(unset)' : '[hidden]';
  if (field.kind === 'list') {
    const items = Array.isArray(value) ? value : value === undefined ? (Array.isArray(field.default) ? field.default : []) : [];
    if (!items.length) return '(none)';
    return sanitize(String(JSON.stringify(redact(items.map(String)))).slice(1, -1).replace(/","/g, ', ').replace(/^"|"$/g, ''));
  }
  if (value === undefined) return '(unset)';
  if (field.kind === 'boolean') return value ? '[x] on' : '[ ] off';
  if (field.kind === 'complex') {
    const text = JSON.stringify(redact(value));
    return Array.isArray(value) ? `${value.length} item${value.length === 1 ? '' : 's'}: ${text}` : text;
  }
  const shown = redact({ [field.path[field.path.length - 1]!]: value })[field.path[field.path.length - 1]!];
  return sanitize(String(shown));
}

/** Validates the draft with the schema after changing `field`; the new draft, or the first problem. */
export function tryChange(draft: GarnetConfig, field: Field, value: unknown): { ok: true; draft: GarnetConfig } | { ok: false; error: string } {
  const parsed = configSchema.safeParse(setAt(draft, field.path, value));
  if (parsed.success) return { ok: true, draft: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { ok: false, error: `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

/** Typed text to a value for a string or number field. */
export function coerce(field: Field, text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (field.kind === 'string') return { ok: true, value: text === '' && field.optional ? undefined : text };
  if (text === '') return field.optional ? { ok: true, value: undefined } : { ok: false, error: 'A value is required.' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: `"${text}" is not a number.` };
  if (field.kind === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'A whole number is required.' };
  return { ok: true, value: n };
}

/** Where to go for a setting the browser cannot edit (tables and lists of objects). */
export function editElsewhere(field: Field): string {
  const path = dotted(field);
  if (path === 'providers') return 'Use `garnet providers add|use|rm`, or `garnet setup`.';
  if (path === 'jobs') return 'Use `garnet jobs` (list, add, edit, delete).';
  if (path.endsWith('.channels') && (path.startsWith('skills.') || path.startsWith('connectors.'))) return `Use \`garnet ${path.split('.')[0]} enable|disable <name> --channel <scope>\`.`;
  return `Edit config.json by hand (\`garnet config explain\` describes ${path}).`;
}
