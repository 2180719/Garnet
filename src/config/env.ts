import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RubyConfig } from './schema.ts';

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

/** Names of the environment variables (or stored secrets) the config refers to. Names only, never values. */
export function secretNames(config: RubyConfig): string[] {
  return [...new Set([config.model.apiKeyEnv, config.channels.telegram.tokenEnv, config.channels.discord.tokenEnv])];
}
