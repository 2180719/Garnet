import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isGarnetError } from '../contracts/index.ts';
import {
  KEY_FILE_ENV,
  PASSPHRASE_ENV,
  SecretStore,
  openSecretStore,
  seal,
  secretLookup,
  unlockFrom,
  unlockWarnings,
  unseal,
  type Unlock,
} from './index.ts';

// Cheap key derivation so the suite stays fast; the file records its own parameters.
const kdf = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const VALUE = 'sk-ant-SUPERSECRETVALUE-1234567890';
const unlock = (material = PASS): Unlock => ({ source: 'passphrase', material: Buffer.from(material) });

function store(home: string, material: string | null = PASS, calls = { n: 0 }) {
  return new SecretStore({
    file: join(home, 'secrets'),
    unlock: () => {
      calls.n++;
      return material === null ? null : unlock(material);
    },
    kdf,
    lockedHint: `Set ${PASSPHRASE_ENV}.`,
  });
}

const configError = (pattern: RegExp) => (e: unknown) => isGarnetError(e, 'config') && pattern.test(e.message);

test('round trip: values survive a fresh store; neither names nor values are in the file', () => {
  const home = tempDir();
  const a = store(home);
  assert.equal(a.exists(), false);
  assert.deepEqual(a.names(), []);
  a.set('ANTHROPIC_API_KEY', VALUE);
  a.setMany({ TELEGRAM_BOT_TOKEN: '123:abc', MULTI: 'line one\nline "two" = ünïcode' });
  const b = store(home);
  assert.deepEqual(b.names(), ['ANTHROPIC_API_KEY', 'MULTI', 'TELEGRAM_BOT_TOKEN']);
  assert.equal(b.get('ANTHROPIC_API_KEY'), VALUE);
  assert.equal(b.get('MULTI'), 'line one\nline "two" = ünïcode');
  assert.equal(b.get('MISSING'), undefined);
  assert.equal(b.get('constructor'), undefined, 'no prototype lookups');
  assert.equal(b.remove('MULTI'), true);
  assert.equal(b.remove('MULTI'), false);
  assert.deepEqual(store(home).names(), ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);

  const text = readFileSync(join(home, 'secrets'), 'utf8');
  assert.equal(text.includes(VALUE), false);
  assert.equal(text.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(text.includes(PASS), false);
  const env = JSON.parse(text);
  assert.equal(env.format, 'garnet-secrets');
  assert.equal(env.version, 1);
  assert.equal(env.cipher, 'aes-256-gcm');
  assert.deepEqual({ name: env.kdf.name, N: env.kdf.N, r: env.kdf.r, p: env.kdf.p }, { name: 'scrypt', ...kdf });
  assert.equal(Buffer.from(env.kdf.salt, 'base64').length, 16);
  assert.equal(Buffer.from(env.nonce, 'base64').length, 12);
  assert.equal(Buffer.from(env.tag, 'base64').length, 16);
});

test('every write uses a fresh salt and nonce', () => {
  const a = JSON.parse(seal({ A: 'x' }, unlock(), kdf));
  const b = JSON.parse(seal({ A: 'x' }, unlock(), kdf));
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.data, b.data);
  assert.deepEqual(unseal(JSON.stringify(a), unlock()), { A: 'x' });
});

test('a wrong passphrase fails clearly without revealing anything', () => {
  const home = tempDir();
  store(home).set('A_KEY', VALUE);
  for (const wrong of ['wrong passphrase!', `${PASS} `]) {
    assert.throws(
      () => store(home, wrong).get('A_KEY'),
      (e) => configError(/Could not unlock .*secrets with the passphrase: it is wrong, or the file was modified/)(e) && !(e as Error).message.includes(wrong) && !(e as Error).message.includes(VALUE),
    );
  }
  // A wrong passphrase never overwrites the store.
  assert.throws(() => store(home, 'wrong passphrase!').set('B_KEY', 'v'), configError(/Could not unlock/));
  assert.equal(store(home).get('A_KEY'), VALUE);
});

test('a tampered file fails authentication: ciphertext, tag, nonce, salt and KDF parameters', () => {
  const home = tempDir();
  store(home).set('A_KEY', VALUE);
  const file = join(home, 'secrets');
  const original = readFileSync(file, 'utf8');
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] = buf[0]! ^ 1;
    return buf.toString('base64');
  };
  const edits: Array<(e: Record<string, any>) => void> = [
    (e) => (e.data = flip(e.data)),
    (e) => (e.tag = flip(e.tag)),
    (e) => (e.nonce = flip(e.nonce)),
    (e) => (e.kdf.salt = flip(e.kdf.salt)),
    (e) => (e.kdf.r = 4),
  ];
  for (const edit of edits) {
    const env = JSON.parse(original);
    edit(env);
    writeFileSync(file, JSON.stringify(env));
    assert.throws(() => store(home).get('A_KEY'), configError(/wrong, or the file was modified/), edit.toString());
  }
  for (const [text, pattern] of [
    ['not json', /not a valid Garnet secret store \(not JSON\)/],
    [JSON.stringify({ format: 'other' }), /unknown format/],
    [JSON.stringify({ ...JSON.parse(original), version: 99 }), /version 99.*Upgrade Garnet/],
    [JSON.stringify({ ...JSON.parse(original), kdf: { ...JSON.parse(original).kdf, N: 2 ** 30 } }), /out of range/],
    [JSON.stringify({ ...JSON.parse(original), kdf: { ...JSON.parse(original).kdf, N: 1000 } }), /out of range/],
    // Each bound alone is fine, but together they would make scrypt allocate 2 GiB.
    [JSON.stringify({ ...JSON.parse(original), kdf: { ...JSON.parse(original).kdf, N: 2 ** 20, r: 16 } }), /out of range/],
    [JSON.stringify({ ...JSON.parse(original), nonce: 'AAAA' }), /bad field length/],
  ] as const) {
    writeFileSync(file, text);
    assert.throws(() => store(home).get('A_KEY'), configError(pattern), text.slice(0, 40));
  }
  writeFileSync(file, original);
  assert.equal(store(home).get('A_KEY'), VALUE);
});

test('the store file is written atomically with mode 0600, whatever the umask', () => {
  const home = join(tempDir(), 'nested', 'home');
  const old = process.umask(0);
  try {
    store(home).set('A_KEY', VALUE);
    chmodSync(join(home, 'secrets'), 0o644);
    store(home).set('B_KEY', VALUE);
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(join(home, 'secrets')).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(home), ['secrets'], 'no temp files left behind');
});

test('locked: a clear error naming the unlock variables, only when the store is needed', () => {
  const home = tempDir();
  const calls = { n: 0 };
  const locked = store(home, null, calls);
  // No file yet: listing needs no key; writing does.
  assert.deepEqual(locked.names(), []);
  assert.equal(calls.n, 0);
  assert.throws(() => locked.set('A_KEY', 'v'), configError(/is locked\. Set GARNET_SECRETS_PASSPHRASE/));
  store(home).set('A_KEY', VALUE);
  assert.throws(() => store(home, null).get('A_KEY'), configError(/is locked/));
  // Short passphrases cannot create or rewrite a store.
  assert.throws(() => store(tempDir(), 'short').set('A_KEY', 'v'), configError(/too short/));
  assert.throws(() => store(home).set('bad-name', 'v'), (e) => isGarnetError(e, 'invalid_input'));
  assert.throws(() => store(home).set('EMPTY', ''), (e) => isGarnetError(e, 'invalid_input'));
});

test('lookup: the environment wins; the store is only decrypted for names the environment lacks', () => {
  const home = tempDir();
  store(home).setMany({ A_KEY: 'from-store', B_KEY: 'only-in-store' });
  const calls = { n: 0 };
  const s = store(home, PASS, calls);
  const lookup = secretLookup({ A_KEY: 'from-env', EMPTY: '' }, s);
  assert.equal(lookup('A_KEY'), 'from-env');
  assert.equal(calls.n, 0, 'not decrypted while the environment has the value');
  assert.equal(lookup('B_KEY'), 'only-in-store');
  assert.equal(lookup('EMPTY'), undefined, 'an empty variable falls through to the store');
  assert.equal(lookup('NOPE'), undefined);
  assert.equal(calls.n, 1, 'decrypted once, then cached');

  // No store file: undefined, and no unlock attempted (existing env-only setups are unchanged).
  const none = { n: 0 };
  assert.equal(secretLookup({}, store(tempDir(), null, none))('A_KEY'), undefined);
  assert.equal(none.n, 0);
  assert.equal(secretLookup({ A_KEY: 'x' }, null)('A_KEY'), 'x');
  // A locked store only matters for a name the environment lacks.
  const locked = secretLookup({ A_KEY: 'from-env' }, store(home, null));
  assert.equal(locked('A_KEY'), 'from-env');
  assert.throws(() => locked('B_KEY'), configError(/is locked/));
});

test('unlock sources: passphrase or a private key file, not both', () => {
  const dir = tempDir();
  assert.equal(unlockFrom({}), null);
  assert.deepEqual(unlockFrom({ [PASSPHRASE_ENV]: PASS }), unlock());
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, 'k'.repeat(44) + '\n', { mode: 0o600 });
  assert.deepEqual(unlockFrom({ [KEY_FILE_ENV]: keyFile }), { source: 'key file', material: Buffer.from('k'.repeat(44)) });
  assert.throws(() => unlockFrom({ [KEY_FILE_ENV]: keyFile, [PASSPHRASE_ENV]: PASS }), configError(/not both/));
  chmodSync(keyFile, 0o640);
  assert.throws(() => unlockFrom({ [KEY_FILE_ENV]: keyFile }), configError(/readable by other users; run: chmod 600/));
  assert.throws(() => unlockFrom({ [KEY_FILE_ENV]: join(dir, 'missing') }), configError(/Cannot read the key file .*ENOENT/));
  const empty = join(dir, 'empty');
  writeFileSync(empty, '\n', { mode: 0o600 });
  assert.throws(() => unlockFrom({ [KEY_FILE_ENV]: empty }), configError(/is empty/));

  // A store written with the key file opens with it, and not with the passphrase.
  chmodSync(keyFile, 0o600);
  const home = tempDir();
  openSecretStore(home, { [KEY_FILE_ENV]: keyFile }, { kdf }).set('A_KEY', VALUE);
  assert.equal(openSecretStore(home, { [KEY_FILE_ENV]: keyFile }).get('A_KEY'), VALUE);
  assert.throws(() => openSecretStore(home, { [PASSPHRASE_ENV]: PASS }).get('A_KEY'), configError(/wrong/));
  assert.throws(() => openSecretStore(home, {}).get('A_KEY'), configError(/locked\. Set GARNET_SECRETS_PASSPHRASE, or GARNET_SECRETS_KEY_FILE/));
  assert.ok(existsSync(join(home, 'secrets')));
});

test('warnings when the unlock material sits next to the store', () => {
  const home = tempDir();
  assert.deepEqual(unlockWarnings(home, { [KEY_FILE_ENV]: '/etc/garnet/key' }), []);
  assert.match(unlockWarnings(home, { [KEY_FILE_ENV]: join(home, 'key') })[0]!, /inside/);
  assert.match(unlockWarnings(home, { [PASSPHRASE_ENV]: PASS }, [PASSPHRASE_ENV])[0]!, /GARNET_SECRETS_PASSPHRASE is in .*env/);
  assert.equal(unlockWarnings(home, { [PASSPHRASE_ENV]: PASS }).length, 0);
  assert.equal(unlockWarnings(home, { [KEY_FILE_ENV]: join(home, 'key') }).join('').includes(PASS), false);
});

test('a key file in a sibling directory whose name starts with ".." is not "inside" home', () => {
  const home = tempDir();
  assert.deepEqual(unlockWarnings(join(home, 'garnet'), { [KEY_FILE_ENV]: join(home, 'garnet', '..key', 'k') }).length, 1, 'a "..key" child is inside');
  assert.deepEqual(unlockWarnings(join(home, 'garnet'), { [KEY_FILE_ENV]: join(home, 'k') }), []);
});

test('a secret named __proto__ is stored and read back like any other', () => {
  const home = tempDir();
  store(home).set('__proto__', VALUE);
  assert.equal(store(home).get('__proto__'), VALUE);
  assert.deepEqual(store(home).names(), ['__proto__']);
});
