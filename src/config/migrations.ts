import { RubyError } from '../contracts/index.ts';
import { CONFIG_VERSION } from './schema.ts';

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * migrations[n] upgrades version n to n + 1. Version 0 means "no version
 * field". Add a migration whenever the schema changes incompatibly, and a test
 * in config.test.ts for it.
 */
const migrations: Record<number, Migration> = {
  0: (raw) => ({ ...raw, version: 1 }),
};

export function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw; // let validation report it
  let current = { ...(raw as Record<string, unknown>) };
  let version = typeof current.version === 'number' ? current.version : 0;
  if (version > CONFIG_VERSION) {
    throw new RubyError('config', `Config version ${version} is newer than this Ruby (${CONFIG_VERSION}). Upgrade Ruby.`);
  }
  while (version < CONFIG_VERSION) {
    const step = migrations[version];
    if (!step) throw new RubyError('internal', `Missing config migration from version ${version}`);
    current = step(current);
    version += 1;
  }
  return current;
}
