// `garnet secrets`: the encrypted secret store. Values come from stdin, never argv, and are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { envVar, loadConfig, parseEnv, removeFromEnvFile, garnetHome, secretNames } from '../config/index.ts';
import { GarnetError } from '../contracts/index.ts';
import {
  KEY_FILE_ENV,
  PASSPHRASE_ENV,
  openSecretStore,
  unlockWarnings,
  validSecretName,
  writePrivateFile,
  type KdfParams,
} from '../secrets/index.ts';
import type { Io } from './main.ts';
import { stripKeySequences } from './setup/prompt.ts';

const USAGE = `Usage:
  garnet secrets list                     Names in the encrypted store (never values)
  garnet secrets set <NAME>               Store a value read from stdin (hidden when typed)
  garnet secrets rm <NAME>                Remove a secret
  garnet secrets import-env [NAME...] [--keep]
                                        Move secrets from <GARNET_HOME>/env into the store
                                        (default: the names config refers to); --keep
                                        leaves the env file unchanged
  garnet secrets keygen <path>            Write a new random key file (mode 0600)

Unlock with ${KEY_FILE_ENV}=<path> (a mode-0600 key file kept outside GARNET_HOME)
or ${PASSPHRASE_ENV}. Environment variables take precedence over stored secrets.
`;

export type SecretsDeps = {
  env?: NodeJS.ProcessEnv;
  /** Cheaper key derivation (tests). */
  kdf?: KdfParams;
};

export async function secrets(args: string[], io: Io, deps: SecretsDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const home = garnetHome(env);
  const store = openSecretStore(home, env, deps.kdf ? { kdf: deps.kdf } : {});
  const [sub, ...rest] = args;
  const name = (): string | null => {
    const n = rest[0];
    if (!n || !validSecretName(n)) {
      io.err(`${n ? `Invalid secret name "${n}"; use letters, digits and _.` : 'Name a secret.'}\n\n${USAGE}`);
      return null;
    }
    return n;
  };
  switch (sub) {
    case 'list': {
      if (!store.exists()) {
        io.out(`No secret store yet (${store.file}). Add one with \`garnet secrets set <NAME>\`.\n`);
        return 0;
      }
      const names = store.names();
      io.out(`${names.length} secret(s) in ${store.file}${names.length ? ':' : '.'}\n`);
      for (const n of names) io.out(`  ${n}${env[n] ? '   (overridden by the environment)' : ''}\n`);
      return 0;
    }
    case 'set': {
      const n = name();
      if (!n) return 2;
      if (rest.length > 1) {
        // Do not echo the extra arguments: they may be the secret itself.
        io.err(`Secret values are read from stdin, never from the command line (it ends up in shell history and process lists).\nRun: garnet secrets set ${n}\n`);
        return 2;
      }
      const read = io.readSecret ?? readSecretFromStdin;
      const value = (await read(`Value for ${n} (input hidden): `, io)).replace(/\r?\n$/, '');
      if (!value) {
        io.err('No value given; nothing stored.\n');
        return 1;
      }
      store.set(n, value);
      io.out(`Stored ${n} in ${store.file}.${env[n] ? ` Note: ${n} is also set in the environment, which takes precedence.` : ''} Restart Garnet to use it.\n`);
      return 0;
    }
    case 'rm': {
      const n = name();
      if (!n) return 2;
      if (!store.exists()) {
        io.err(`No secret named ${n} (there is no store yet).\n`);
        return 1;
      }
      if (!store.remove(n)) {
        io.err(`No secret named ${n}.\n`);
        return 1;
      }
      io.out(`Removed ${n} from ${store.file}.\n`);
      return 0;
    }
    case 'import-env':
      return importEnv(rest, io, home, env, store);
    case 'keygen': {
      const path = rest[0];
      if (!path) {
        io.err(`Name a path for the key file.\n\n${USAGE}`);
        return 2;
      }
      const target = resolve(path);
      if (existsSync(target)) {
        io.err(`${target} already exists; not overwriting it.\n`);
        return 1;
      }
      writePrivateFile(target, randomBytes(32).toString('base64') + '\n');
      io.out(`Wrote a new key file to ${target} (mode 0600). Back it up: without it the store cannot be decrypted.\nThen set ${KEY_FILE_ENV}=${target} (the path is not secret; it can go in ${home}/env).\n`);
      for (const w of unlockWarnings(home, { [KEY_FILE_ENV]: target })) io.err(`Warning: ${w}\n`);
      return 0;
    }
    case undefined:
    case 'help':
      io.out(USAGE);
      return 0;
    default:
      io.err(`Unknown secrets subcommand "${sub}".\n\n${USAGE}`);
      return 2;
  }
}

function importEnv(args: string[], io: Io, home: string, env: NodeJS.ProcessEnv, store: ReturnType<typeof openSecretStore>): number {
  const keep = args.includes('--keep');
  const asked = args.filter((a) => a !== '--keep');
  const bad = asked.find((a) => !validSecretName(a));
  if (bad !== undefined) {
    io.err(`Invalid secret name "${bad}".\n`);
    return 2;
  }
  const file = `${home}/env`;
  if (!existsSync(file)) {
    io.err(`There is no ${file} to import from.\n`);
    return 1;
  }
  const values = parseEnv(readFileSync(file, 'utf8'));
  // The unlock variables must never be stored behind themselves.
  const wanted = (asked.length ? asked : secretNames(loadConfig(home).config)).filter((n) => n !== PASSPHRASE_ENV && n !== KEY_FILE_ENV);
  const missing = asked.filter((n) => !values.get(n));
  if (missing.length) {
    io.err(`Not set in ${file}: ${missing.join(', ')}.\n`);
    return 1;
  }
  const names = wanted.filter((n) => values.get(n));
  if (names.length === 0) {
    io.out(`Nothing to import: ${file} sets none of ${wanted.join(', ')}. Name the variables to import: garnet secrets import-env NAME...\n`);
    return 0;
  }
  store.setMany(Object.fromEntries(names.map((n) => [n, values.get(n)!])));
  // Read the file back with a fresh store before touching the env file.
  const check = openSecretStore(home, env);
  if (names.some((n) => check.get(n) !== values.get(n))) throw new GarnetError('internal', 'The secret store did not read back what was written; the env file was left unchanged.');
  io.out(`Imported ${names.join(', ')} into ${store.file}.\n`);
  if (keep) {
    io.out(`${file} still holds them in plain text (--keep). Remove those lines when you are ready.\n`);
  } else {
    const removed = removeFromEnvFile(home, names);
    io.out(`Removed ${removed.join(', ')} from ${file}. Copies may remain in backups or editor history.\n`);
  }
  if (!envVar(env, PASSPHRASE_ENV) && !envVar(env, KEY_FILE_ENV)) io.out(`Remember to give the service ${KEY_FILE_ENV} or ${PASSPHRASE_ENV}.\n`);
  return 0;
}

/** Reads one secret from stdin: hidden, line-edited input on a terminal; everything piped otherwise. */
export async function readSecretFromStdin(prompt: string, io: Io): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  }
  io.err(prompt);
  return new Promise((resolvePromise, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      io.err('\n');
      if (err) reject(err);
      else resolvePromise(value);
    };
    const onData = (text: string) => {
      for (const ch of stripKeySequences(text)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new GarnetError('cancelled', 'Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
