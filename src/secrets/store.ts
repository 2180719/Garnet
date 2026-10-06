// An encrypted file of NAME=value secrets: scrypt-derived key, AES-256-GCM.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, chmodSync, unlinkSync, writeSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { dirname } from 'node:path';
import { RubyError } from '../contracts/index.ts';

export const SECRETS_FORMAT = 'ruby-secrets';
export const SECRETS_VERSION = 1;

export type KdfParams = { N: number; r: number; p: number };
/** About 32 MB and ~100 ms per derivation. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 15, r: 8, p: 1 };
/** Upper bounds accepted when reading, so a crafted file cannot make Ruby allocate gigabytes. */
const MAX_KDF: KdfParams = { N: 2 ** 20, r: 16, p: 4 };

/** Shortest passphrase or key accepted for writing (reads accept whatever unlocks the file). */
export const MIN_KEY_CHARS = 12;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Key material from the unlock source (a passphrase, or a key file's contents). Never logged. */
export type Unlock = { source: 'passphrase' | 'key file'; material: Buffer };

type Header = {
  format: typeof SECRETS_FORMAT;
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  nonce: string;
};
type Envelope = Header & { tag: string; data: string };

export function validSecretName(name: string): boolean {
  return NAME.test(name);
}

function assertName(name: string): void {
  if (!validSecretName(name)) throw new RubyError('invalid_input', `Invalid secret name "${name}". Use letters, digits and _ (like an environment variable).`);
}

function deriveKey(material: Buffer, salt: Buffer, kdf: KdfParams): Buffer {
  return scryptSync(material, salt, KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 + 1024 * 1024 });
}

/**
 * The header (everything but the tag and ciphertext) is the GCM additional
 * data, so changing the KDF parameters, salt or nonce also fails
 * authentication. It is rebuilt field by field so key order cannot vary.
 */
function aad(h: Header): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: h.format,
      version: h.version,
      kdf: { name: h.kdf.name, N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, salt: h.kdf.salt },
      cipher: h.cipher,
      nonce: h.nonce,
    }),
  );
}

/** Encrypts a name → value map into the file format (pure apart from randomness). */
export function seal(secrets: Record<string, string>, unlock: Unlock, kdf: KdfParams = DEFAULT_KDF): string {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header: Header = {
    format: SECRETS_FORMAT,
    version: SECRETS_VERSION,
    kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
  };
  const cipher = createCipheriv('aes-256-gcm', deriveKey(unlock.material, salt, kdf), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(header));
  const data = Buffer.concat([cipher.update(JSON.stringify({ secrets }), 'utf8'), cipher.final()]);
  const envelope: Envelope = { ...header, tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  return JSON.stringify(envelope, null, 2) + '\n';
}

/** Decrypts the file format. Throws a `config` error for a foreign, unsupported, tampered or wrongly unlocked file. */
export function unseal(text: string, unlock: Unlock, file = 'the secret store'): Record<string, string> {
  const bad = (why: string) => new RubyError('config', `${file} is not a valid Ruby secret store (${why}).`);
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw bad('not JSON');
  }
  if (!env || typeof env !== 'object' || env.format !== SECRETS_FORMAT) throw bad('unknown format');
  if (env.version !== SECRETS_VERSION) {
    throw new RubyError('config', `${file} has version ${String(env.version)}; this Ruby reads version ${SECRETS_VERSION}. Upgrade Ruby.`);
  }
  const k = env.kdf;
  if (env.cipher !== 'aes-256-gcm' || !k || k.name !== 'scrypt') throw bad('unsupported cipher or key derivation');
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!intIn(k.N, 2, MAX_KDF.N) || (k.N & (k.N - 1)) !== 0 || !intIn(k.r, 1, MAX_KDF.r) || !intIn(k.p, 1, MAX_KDF.p)) throw bad('key derivation parameters out of range');
  const b64 = (v: unknown, len?: number) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw bad('bad encoding');
    const buf = Buffer.from(v, 'base64');
    if (len !== undefined && buf.length !== len) throw bad('bad field length');
    return buf;
  };
  const salt = b64(k.salt, SALT_BYTES);
  const nonce = b64(env.nonce, NONCE_BYTES);
  const tag = b64(env.tag, TAG_BYTES);
  const data = b64(env.data);
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(unlock.material, salt, k), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(env));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM cannot tell a wrong key from a modified file; say both.
    throw new RubyError('config', `Could not unlock ${file} with the ${unlock.source}: it is wrong, or the file was modified.`);
  }
  const parsed = JSON.parse(plain) as { secrets?: unknown };
  const secrets = parsed.secrets;
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw bad('bad payload');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    if (validSecretName(name) && typeof value === 'string') out[name] = value;
  }
  return out;
}

/** Writes a file atomically with mode 0600: temp file, fsync, rename. */
export function writePrivateFile(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
  chmodSync(file, 0o600);
  try {
    const dir = openSync(dirname(file), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}

export type SecretStoreOptions = {
  file: string;
  /** Called only when the store must be decrypted or written; null means locked. */
  unlock: () => Unlock | null;
  /** Key derivation for new writes (tests use a cheaper one). Reads use the file's own parameters. */
  kdf?: KdfParams;
  /** What to tell the owner when the store is locked. */
  lockedHint?: string;
};

/**
 * The encrypted secret store. Decrypts on first use and caches the result in
 * memory; every write re-encrypts with a fresh salt and nonce.
 */
export class SecretStore {
  readonly file: string;
  private readonly unlockFn: () => Unlock | null;
  private readonly kdf: KdfParams;
  private readonly lockedHint: string;
  private unlocked: Unlock | null = null;
  private cache: Record<string, string> | null = null;

  constructor(opts: SecretStoreOptions) {
    this.file = opts.file;
    this.unlockFn = opts.unlock;
    this.kdf = opts.kdf ?? DEFAULT_KDF;
    this.lockedHint = opts.lockedHint ?? 'Provide a passphrase or key file.';
  }

  exists(): boolean {
    return existsSync(this.file);
  }

  /** Throws when no passphrase or key file is available. */
  private key(): Unlock {
    this.unlocked ??= this.unlockFn();
    if (!this.unlocked) throw new RubyError('config', `The secret store ${this.file} is locked. ${this.lockedHint}`);
    return this.unlocked;
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!this.exists()) return {};
    this.cache = unseal(readFileSync(this.file, 'utf8'), this.key(), this.file);
    return this.cache;
  }

  get(name: string): string | undefined {
    return Object.hasOwn(this.load(), name) ? this.load()[name] : undefined;
  }

  /** Secret names, sorted. Values never leave the store except through `get`. */
  names(): string[] {
    return Object.keys(this.load()).sort();
  }

  set(name: string, value: string): void {
    this.setMany({ [name]: value });
  }

  setMany(entries: Record<string, string>): void {
    for (const [name, value] of Object.entries(entries)) {
      assertName(name);
      if (typeof value !== 'string' || value === '') throw new RubyError('invalid_input', `The value for ${name} is empty.`);
    }
    this.save({ ...this.load(), ...entries });
  }

  /** Returns whether the name existed. */
  remove(name: string): boolean {
    assertName(name);
    const current = this.load();
    if (!Object.hasOwn(current, name)) return false;
    const next = { ...current };
    delete next[name];
    this.save(next);
    return true;
  }

  private save(secrets: Record<string, string>): void {
    const key = this.key();
    if (key.material.length < MIN_KEY_CHARS) {
      throw new RubyError('config', `The ${key.source} is too short to protect the secret store; use at least ${MIN_KEY_CHARS} characters (\`ruby secrets keygen <path>\` makes a strong key file).`);
    }
    writePrivateFile(this.file, seal(secrets, key, this.kdf));
    this.cache = secrets;
  }
}
