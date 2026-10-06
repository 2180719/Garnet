import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads `<home>/env` (KEY=value lines, `#` comments) into `env` without
 * overriding variables that are already set. Returns a warning when the file
 * is readable by other users.
 */
export function loadEnvFile(home: string, env: NodeJS.ProcessEnv = process.env): { loaded: string[]; warning: string | null } {
  const file = join(home, 'env');
  if (!existsSync(file)) return { loaded: [], warning: null };
  const loaded: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (env[m[1]!] === undefined) {
      env[m[1]!] = value;
      loaded.push(m[1]!);
    }
  }
  const mode = statSync(file).mode & 0o077;
  return { loaded, warning: mode ? `${file} is readable by other users; run: chmod 600 ${file}` : null };
}
