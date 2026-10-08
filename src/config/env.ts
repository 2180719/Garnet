import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyEnvOf, listProviders } from './providers.ts';
import type { GarnetConfig } from './schema.ts';
import { enabledAnywhere } from './extensions.ts';

/** Environment variables Garnet reads. Before the rename each had a `RUBY_` twin, which is still read when the `GARNET_` one is unset. */
const LEGACY_ENV_SUFFIXES = ['HOME', 'SECRETS_KEY_FILE', 'SECRETS_PASSPHRASE', 'LIVE_TESTS', 'NODE', 'COMMAND_NAME'] as const;

/** Reads `name` (a `GARNET_*` variable), falling back to its deprecated `RUBY_*` twin. */
export function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value) return value; // empty falls through to the RUBY_ twin, like shell `:-`
  const old = name.startsWith('GARNET_') ? env[`RUBY_${name.slice('GARNET_'.length)}`] : undefined;
  return old || value;
}

/** Deprecated `RUBY_*` variables that are set and not shadowed by the `GARNET_*` name, as `{ old, name }`. */
export function deprecatedEnvVars(env: NodeJS.ProcessEnv): { old: string; name: string }[] {
  const out: { old: string; name: string }[] = [];
  for (const s of LEGACY_ENV_SUFFIXES) if (env[`RUBY_${s}`] !== undefined && env[`GARNET_${s}`] === undefined) out.push({ old: `RUBY_${s}`, name: `GARNET_${s}` });
  return out;
}

/** Every GARNET_* name Garnet or its installer reads. Settings live in config.json, so any other GARNET_* variable is ignored. */
const KNOWN_GARNET_ENV = new Set([
  ...LEGACY_ENV_SUFFIXES.map((s) => `GARNET_${s}`),
  'GARNET_INSTALL_DIR', 'GARNET_BIN_DIR', 'GARNET_BIN_NAME', 'GARNET_REPO', 'GARNET_REF', // install.sh only
  'GARNET_CALENDAR_URL', // default secret name of connectors.calendar.urlEnv
]);

/**
 * `GARNET_*` variables that are set but that nothing reads (a setting someone tried to put in the environment).
 * `secretNames` are the names the config points at (`secretNames(config)`): a secret may be called `GARNET_SOMETHING`.
 */
export function unknownGarnetEnv(env: NodeJS.ProcessEnv, secretNames: readonly string[] = []): string[] {
  const named = new Set(secretNames);
  return Object.keys(env).filter((k) => k.startsWith('GARNET_') && !KNOWN_GARNET_ENV.has(k) && !named.has(k)).sort();
}

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** Parses KEY=value lines (`#` comments, optional `export`, optional matching quotes). The first line for a name wins. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!out.has(m[1]!)) out.set(m[1]!, value);
  }
  return out;
}

/**
 * Loads `<home>/env` (KEY=value lines, `#` comments) into `env` without
 * overriding variables that are already set. Returns a warning when the file
 * is readable by other users.
 */
export function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): { loaded: string[]; warning: string | null } {
  const file = join(home, 'env');
  if (!existsSync(file)) return { loaded: [], warning: null };
  const loaded: string[] = [];
  for (const [name, value] of parseEnv(readFileSync(file, 'utf8'))) {
    if (env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  const mode = statSync(file).mode & 0o077;
  return { loaded, warning: mode ? `${file} is readable by other users; run: chmod 600 ${file}` : null };
}

/**
 * Rewrites `<home>/env` without the lines that set `names`, keeping comments
 * and every other line. Atomic, mode 0600. Returns the names it removed.
 */
export function removeFromEnvFile(home: string, names: string[]): string[] {
  const file = join(home, 'env');
  if (!existsSync(file) || names.length === 0) return [];
  const drop = new Set(names);
  const removed = new Set<string>();
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((raw) => {
      const m = LINE.exec(raw.trim());
      if (m && !raw.trim().startsWith('#') && drop.has(m[1]!)) {
        removed.add(m[1]!);
        return false;
      }
      return true;
    });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.join('\n'), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return [...removed];
}

/**
 * Sets `entries` in `<home>/env`: replaces the first line for each name and
 * drops later duplicates, appends names that are missing, and keeps comments
 * and every other line. Atomic, mode 0600. Values must be single-line.
 */
export function setInEnvFile(home: string, entries: Record<string, string>): void {
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name "${name}"`);
    if (/[\r\n]/.test(value)) throw new Error(`The value for ${name} must be a single line`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'env');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const m = raw.trim().startsWith('#') ? null : LINE.exec(raw.trim());
    const name = m?.[1];
    if (name !== undefined && name in entries) {
      if (done.has(name)) continue;
      out.push(`${name}=${quoteEnv(entries[name]!)}`);
      done.add(name);
      continue;
    }
    out.push(raw);
  }
  for (const [name, value] of Object.entries(entries)) if (!done.has(name)) out.push(`${name}=${quoteEnv(value)}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, out.join('\n') + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Quotes a value so `parseEnv` and POSIX sh (the launchd wrapper sources the file) read it back unchanged. */
function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_\/.:@%+,=-]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  throw new Error('Values containing both special characters and a single quote cannot be written to the env file; use `garnet secrets set` instead');
}

/** Names of the environment variables (or stored secrets) the config refers to. Names only, never values. */
export function secretNames(config: GarnetConfig): string[] {
  const transcription = config.media.transcription.backend === 'openai-compatible' ? config.media.transcription.apiKeyEnv : undefined;
  const sshPassphrase = config.sandbox.backend === 'ssh' ? config.sandbox.ssh.passphraseEnv : undefined;
  // Connectors that are on anywhere (globally or in a scope) need their credentials.
  const on = new Set(enabledAnywhere(config.connectors));
  const connectors = [...(on.has('github') ? [config.connectors.github.tokenEnv] : []), ...(on.has('calendar') ? [config.connectors.calendar.urlEnv] : []), ...(on.has('http') ? Object.values(config.connectors.http.credentials).map((c) => c.secretEnv) : [])];
  return [
    ...new Set([
      ...listProviders(config).filter((p) => p.model.provider !== 'fake').map((p) => keyEnvOf(p.model)),
      config.channels.telegram.tokenEnv,
      config.channels.discord.tokenEnv,
      ...(transcription ? [transcription] : []),
      ...(sshPassphrase ? [sshPassphrase] : []),
      ...connectors,
    ]),
  ];
}
