import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { RubyError } from '../contracts/index.ts';
import { SecretStore, type KdfParams, type Unlock } from './store.ts';

export const PASSPHRASE_ENV = 'RUBY_SECRETS_PASSPHRASE';
export const KEY_FILE_ENV = 'RUBY_SECRETS_KEY_FILE';

/** `<home>/secrets`: the encrypted store. */
export const secretsFile = (home: string): string => join(home, 'secrets');

const inside = (dir: string, path: string) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Reads the unlock source from the environment: `RUBY_SECRETS_KEY_FILE` (a
 * path to a mode-0600 file) or `RUBY_SECRETS_PASSPHRASE`. Returns null when
 * neither is set. Never includes the material in an error.
 */
export function unlockFrom(env: NodeJS.ProcessEnv): Unlock | null {
  const keyFile = env[KEY_FILE_ENV];
  const passphrase = env[PASSPHRASE_ENV];
  if (keyFile && passphrase) throw new RubyError('config', `Set ${PASSPHRASE_ENV} or ${KEY_FILE_ENV}, not both.`);
  if (keyFile) {
    let mode: number;
    let text: string;
    try {
      mode = statSync(keyFile).mode;
      text = readFileSync(keyFile, 'utf8');
    } catch (e) {
      throw new RubyError('config', `Cannot read the key file named by ${KEY_FILE_ENV} (${keyFile}): ${(e as NodeJS.ErrnoException).code ?? 'error'}.`);
    }
    if (mode & 0o077) throw new RubyError('config', `The key file ${keyFile} is readable by other users; run: chmod 600 ${keyFile}`);
    const material = text.trim();
    if (!material) throw new RubyError('config', `The key file ${keyFile} is empty.`);
    return { source: 'key file', material: Buffer.from(material, 'utf8') };
  }
  if (passphrase) return { source: 'passphrase', material: Buffer.from(passphrase, 'utf8') };
  return null;
}

/** Warnings about where the unlock material lives (it should not sit next to the store). */
export function unlockWarnings(home: string, env: NodeJS.ProcessEnv, loadedFromEnvFile: string[] = []): string[] {
  const warnings: string[] = [];
  if (loadedFromEnvFile.includes(PASSPHRASE_ENV)) {
    warnings.push(`${PASSPHRASE_ENV} is in ${join(home, 'env')}, next to the store it unlocks. Use ${KEY_FILE_ENV} with a key file outside ${home} instead.`);
  }
  const keyFile = env[KEY_FILE_ENV];
  if (keyFile && inside(home, keyFile)) {
    warnings.push(`The key file ${keyFile} is inside ${home}, next to the store it unlocks (and in reach of anyone with a copy of that directory). Keep it elsewhere.`);
  }
  return warnings;
}

/** The store at `<home>/secrets`, unlocked lazily from `env`. */
export function openSecretStore(home: string, env: NodeJS.ProcessEnv, opts: { kdf?: KdfParams } = {}): SecretStore {
  return new SecretStore({
    file: secretsFile(home),
    unlock: () => unlockFrom(env),
    lockedHint: `Set ${PASSPHRASE_ENV}, or ${KEY_FILE_ENV} to a mode-0600 key file outside ${home}.`,
    ...(opts.kdf ? { kdf: opts.kdf } : {}),
  });
}

export type SecretLookup = (name: string) => string | undefined;

/**
 * Resolves a secret by name: the process environment first (so env-file and
 * systemd setups keep working unchanged), then the encrypted store. The store
 * is only decrypted when a name is missing from the environment and the
 * store file exists; a locked store then throws a `config` error that says
 * how to unlock it.
 */
export function secretLookup(env: NodeJS.ProcessEnv, store: SecretStore | null): SecretLookup {
  return (name) => {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
    if (!store || !store.exists()) return undefined;
    return store.get(name);
  };
}
