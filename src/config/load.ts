import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RubyError } from '../contracts/index.ts';
import { CONFIG_VERSION, configSchema, type RubyConfig } from './schema.ts';
import { migrate } from './migrations.ts';

export type Paths = {
  home: string;
  configFile: string;
  database: string;
  workspace: string;
};

/** Ruby's home directory: $RUBY_HOME or ~/.ruby. */
export function rubyHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.RUBY_HOME ?? join(homedir(), '.ruby'));
}

export function pathsFor(home: string, config: RubyConfig): Paths {
  return {
    home,
    configFile: join(home, 'config.json'),
    database: join(home, 'ruby.db'),
    workspace: resolve(home, config.workspace ?? 'workspace'),
  };
}

/** Parses and validates raw config, applying migrations first. Throws a `config` RubyError listing every problem. */
export function parseConfig(raw: unknown): RubyConfig {
  const migrated = migrate(raw);
  const result = configSchema.safeParse(migrated);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new RubyError('config', `Invalid config:\n  ${problems.join('\n  ')}`, { problems });
  }
  return result.data;
}

export function defaultConfig(): RubyConfig {
  return parseConfig({ version: CONFIG_VERSION });
}

export type Loaded = { config: RubyConfig; paths: Paths; migrated: boolean };

/** Loads config from <home>/config.json, or defaults when it does not exist. Persists migrations with a backup. */
export function loadConfig(home: string = rubyHome()): Loaded {
  const file = join(home, 'config.json');
  if (!existsSync(file)) {
    const config = defaultConfig();
    return { config, paths: pathsFor(home, config), migrated: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RubyError('config', `${file} is not valid JSON: ${(e as Error).message}`);
  }
  const config = parseConfig(raw);
  const migrated = (raw as { version?: unknown })?.version !== CONFIG_VERSION;
  if (migrated) {
    renameSync(file, `${file}.bak-v${String((raw as { version?: unknown }).version ?? 0)}`);
    writeConfig(home, config);
  }
  return { config, paths: pathsFor(home, config), migrated };
}

export function writeConfig(home: string, config: RubyConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'config.json');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
