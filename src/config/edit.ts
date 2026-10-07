import { GarnetError } from '../contracts/index.ts';
import { parseConfig } from './load.ts';
import type { GarnetConfig } from './schema.ts';
import { redact } from './redact.ts';

/** Credential shapes: provider keys, bot tokens, bearer tokens, common vendor prefixes. */
const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{16,}|(?:garnet|ruby)_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}|\d{6,}:[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `path` ends in a field that holds the NAME of an environment variable or stored secret (`apiKeyEnv`, `tokenEnv`, ...). */
export function isSecretNamePath(path: string): boolean {
  return (path.split('.').pop() ?? '').endsWith('Env');
}

/** Splits `a.b.0.c`; rejects empty segments and prototype keys. */
function segments(path: string): string[] {
  const keys = path.split('.');
  if (keys.some((k) => k === '' || k === '__proto__' || k === 'constructor' || k === 'prototype')) {
    throw new GarnetError('config', `Invalid config path "${path}". Use dotted names such as model.name (\`garnet config explain\` lists them).`);
  }
  return keys;
}

/** Reads a value by dotted path. Array items are addressed by index (`jobs.0.id`). Undefined when absent. */
export function getConfigValue(config: unknown, path: string): unknown {
  let cur: unknown = config;
  for (const k of segments(path)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Command-line text to a value: JSON when it parses (numbers, booleans, null, arrays, objects, quoted strings), else the text itself. */
export function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function looksSecret(v: unknown): boolean {
  if (typeof v === 'string') return SECRET_SHAPE.test(v);
  if (Array.isArray(v)) return v.some(looksSecret);
  if (v && typeof v === 'object') return Object.values(v).some(looksSecret);
  return false;
}

function refuseSecrets(path: string, value: unknown): void {
  if (looksSecret(value)) {
    throw new GarnetError('config', `Refusing a value for ${path} that looks like a credential. Config holds secret NAMES only: store the value with \`garnet secrets set <NAME>\` (or a line in <home>/env) and put the name in the matching *Env field.`);
  }
  if (isSecretNamePath(path) && typeof value === 'string') {
    // A name, not a value: a plain identifier. Long mixed-case strings are far more likely a pasted key.
    const keyLike = value.length > 40 && /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);
    if (!ENV_NAME.test(value) || keyLike) {
      throw new GarnetError('config', `${path} holds the NAME of an environment variable or stored secret (for example ANTHROPIC_API_KEY), not the secret itself. Store the value with \`garnet secrets set <NAME>\`.`);
    }
  }
}

export type ConfigChange = { path: string; before: unknown; after: unknown; config: GarnetConfig };

/**
 * Returns a new config with `path` set to `value`, or removed (back to its
 * default or unset) when `remove`. The result is validated with the schema, so
 * an unknown path or a bad value throws with every problem and the caller
 * writes nothing.
 */
export function changeConfig(current: GarnetConfig, path: string, value: unknown, remove = false): ConfigChange {
  const keys = segments(path);
  if (!remove) refuseSecrets(path, value);
  const draft = structuredClone(current) as Record<string, unknown>;
  const before = getConfigValue(draft, path);
  let cur: Record<string, unknown> = draft;
  for (const k of keys.slice(0, -1)) {
    let next = cur[k];
    if (next === undefined || next === null) {
      if (remove) return { path, before, after: before, config: current };
      next = {};
      cur[k] = next;
    }
    if (typeof next !== 'object') throw new GarnetError('config', `${path}: ${k} is not a section, so nothing can be set below it.`);
    cur = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (remove) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete cur[last];
  } else cur[last] = value;
  const config = parseConfig(draft);
  const after = getConfigValue(config, path);
  // The schema drops unknown keys, so a value that vanished means the path is not a setting.
  if (!remove && after === undefined && value !== undefined) throw new GarnetError('config', `${path} is not a setting. \`garnet config explain\` lists every setting.`);
  return { path, before, after, config };
}

/** A value as one line of JSON, scrubbed of anything credential-shaped. */
export function showConfigValue(path: string, value: unknown): string {
  if (value === undefined) return '(unset)';
  const leaf = path.split('.').pop()!;
  return JSON.stringify((redact({ [leaf]: value }) as Record<string, unknown>)[leaf]) ?? '(unset)';
}
