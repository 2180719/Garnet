import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GarnetError } from '../contracts/index.ts';
import { CONFIG_VERSION, configSchema, type GarnetConfig } from './schema.ts';
import { envVar } from './env.ts';
import { migrate } from './migrations.ts';

export type Paths = {
  home: string;
  configFile: string;
  database: string;
  workspace: string;
};

/**
 * Garnet's home directory: $GARNET_HOME, else the deprecated $RUBY_HOME, else
 * ~/.garnet if it exists, else a legacy ~/.ruby that holds a config.json (an
 * install from before the rename), else ~/.garnet.
 */
export function garnetHome(env: NodeJS.ProcessEnv = process.env, userHome: string = homedir()): string {
  const set = envVar(env, 'GARNET_HOME');
  if (set) return resolve(set);
  const fresh = join(userHome, '.garnet');
  const legacy = join(userHome, '.ruby');
  if (!existsSync(fresh) && existsSync(join(legacy, 'config.json'))) return resolve(legacy);
  return resolve(fresh);
}

export function pathsFor(home: string, config: GarnetConfig): Paths {
  return {
    home,
    configFile: join(home, 'config.json'),
    database: existsSync(join(home, 'garnet.db')) || !existsSync(join(home, 'ruby.db')) ? join(home, 'garnet.db') : join(home, 'ruby.db'),
    workspace: resolve(home, config.workspace ?? 'workspace'),
  };
}

/** Parses and validates raw config, applying migrations first. Throws a `config` GarnetError listing every problem. */
export function parseConfig(raw: unknown): GarnetConfig {
  const migrated = migrate(raw);
  const result = configSchema.safeParse(migrated);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new GarnetError('config', `Invalid config:\n  ${problems.join('\n  ')}`, { problems });
  }
  return result.data;
}

export function defaultConfig(): GarnetConfig {
  return parseConfig({ version: CONFIG_VERSION });
}

export type Loaded = { config: GarnetConfig; paths: Paths; migrated: boolean };

/** Loads config from <home>/config.json, or defaults when it does not exist. Persists migrations with a backup. */
export function loadConfig(home: string = garnetHome()): Loaded {
  const file = join(home, 'config.json');
  if (!existsSync(file)) {
    const config = defaultConfig();
    return { config, paths: pathsFor(home, config), migrated: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new GarnetError('config', `${file} is not valid JSON: ${(e as Error).message}`);
  }
  const config = parseConfig(raw);
  const migrated = (raw as { version?: unknown })?.version !== CONFIG_VERSION;
  if (migrated) {
    // Copy, then replace atomically: the original stays in place if the write fails, and an older backup is never overwritten.
    const base = `${file}.bak-v${String((raw as { version?: unknown }).version ?? 0)}`;
    copyFileSync(file, existsSync(base) ? `${base}-${Date.now()}` : base, constants.COPYFILE_EXCL);
    writeConfig(home, config);
  }
  return { config, paths: pathsFor(home, config), migrated };
}

export function writeConfig(home: string, config: GarnetConfig): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'config.json');
  // A unique temp name, so two writers never interleave in one temp file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
