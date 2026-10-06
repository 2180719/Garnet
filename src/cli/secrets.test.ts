import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, openSecretStore } from '../secrets/index.ts';
import type { Io } from './main.ts';
import { secrets } from './secrets.ts';

const kdf = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const VALUE = 'sk-ant-NEVER-PRINT-THIS-0123456789';

function harness(env: NodeJS.ProcessEnv, input = `${VALUE}\n`) {
  let out = '';
  let err = '';
  const prompts: string[] = [];
  const io: Io = {
    out: (t) => (out += t),
    err: (t) => (err += t),
    readSecret: async (prompt) => {
      prompts.push(prompt);
      return input;
    },
  };
  const run = (...args: string[]) => secrets(args, io, { env, kdf });
  return { run, all: () => out + err, out: () => out, err: () => err, prompts };
}

test('set reads the value from stdin; list prints names only; rm removes; nothing echoes the value', async () => {
  const home = tempDir();
  const env = { RUBY_HOME: home, [PASSPHRASE_ENV]: PASS };
  const h = harness(env);
  assert.equal(await h.run('list'), 0);
  assert.match(h.out(), /No secret store yet/);
  assert.equal(await h.run('set', 'ANTHROPIC_API_KEY'), 0);
  assert.deepEqual(h.prompts, ['Value for ANTHROPIC_API_KEY (input hidden): ']);
  // The trailing newline from `echo ... |` is not part of the value.
  assert.equal(openSecretStore(home, env).get('ANTHROPIC_API_KEY'), VALUE);
  assert.equal(statSync(join(home, 'secrets')).mode & 0o777, 0o600);
  assert.equal(await h.run('list'), 0);
  assert.match(h.out(), /1 secret\(s\) in .*secrets:\n {2}ANTHROPIC_API_KEY\n/);
  assert.equal(await h.run('rm', 'ANTHROPIC_API_KEY'), 0);
  assert.equal(await h.run('rm', 'ANTHROPIC_API_KEY'), 1);
  assert.equal(h.all().includes(VALUE), false);
  assert.equal(h.all().includes(PASS), false);
});

test('a value on the command line is refused and never echoed', async () => {
  const home = tempDir();
  const h = harness({ RUBY_HOME: home, [PASSPHRASE_ENV]: PASS });
  assert.equal(await h.run('set', 'ANTHROPIC_API_KEY', VALUE), 2);
  assert.match(h.err(), /read from stdin, never from the command line/);
  assert.equal(h.all().includes(VALUE), false);
  assert.equal(existsSync(join(home, 'secrets')), false);
  assert.equal(h.prompts.length, 0);
  // Empty input stores nothing; bad names and unknown subcommands are usage errors.
  const empty = harness({ RUBY_HOME: home, [PASSPHRASE_ENV]: PASS }, '\n');
  assert.equal(await empty.run('set', 'A_KEY'), 1);
  assert.equal(existsSync(join(home, 'secrets')), false);
  assert.equal(await h.run('set', 'bad-name'), 2);
  assert.equal(await h.run('frobnicate'), 2);
});

test('locked and wrong-passphrase errors are clear and do not leak', async () => {
  const home = tempDir();
  await harness({ RUBY_HOME: home, [PASSPHRASE_ENV]: PASS }).run('set', 'A_KEY');
  const locked = harness({ RUBY_HOME: home });
  await assert.rejects(locked.run('list'), /is locked\. Set RUBY_SECRETS_PASSPHRASE, or RUBY_SECRETS_KEY_FILE/);
  const wrong = harness({ RUBY_HOME: home, [PASSPHRASE_ENV]: 'not the right passphrase' });
  await assert.rejects(wrong.run('set', 'B_KEY'), (e) => /wrong, or the file was modified/.test((e as Error).message) && !(e as Error).message.includes(VALUE));
});

test('list marks names the environment overrides', async () => {
  const home = tempDir();
  const env = { RUBY_HOME: home, [PASSPHRASE_ENV]: PASS };
  await harness(env).run('set', 'A_KEY');
  const h = harness({ ...env, A_KEY: 'from-env' });
  await h.run('list');
  assert.match(h.out(), /A_KEY {3}\(overridden by the environment\)/);
  assert.equal(h.all().includes('from-env'), false);
});

test('import-env moves the names config refers to into the store and out of the env file', async () => {
  const home = tempDir();
  const envFile = join(home, 'env');
  writeFileSync(
    envFile,
    `# my secrets\nANTHROPIC_API_KEY=${VALUE}\nexport TELEGRAM_BOT_TOKEN="123:abc"\nDOCKER_HOST=unix:///run/docker.sock\n${KEY_FILE_ENV}=/elsewhere/key\n`,
    { mode: 0o600 },
  );
  const env = { RUBY_HOME: home, [PASSPHRASE_ENV]: PASS };
  const h = harness(env);
  assert.equal(await h.run('import-env'), 0);
  const store = openSecretStore(home, env);
  assert.deepEqual(store.names(), ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
  assert.equal(store.get('TELEGRAM_BOT_TOKEN'), '123:abc');
  // Only the imported lines go; comments and non-secret settings stay.
  assert.equal(readFileSync(envFile, 'utf8'), `# my secrets\nDOCKER_HOST=unix:///run/docker.sock\n${KEY_FILE_ENV}=/elsewhere/key\n`);
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  assert.match(h.out(), /Imported ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN/);
  assert.equal(h.all().includes(VALUE), false);

  // Named imports with --keep leave the env file alone; the unlock variables are never imported.
  const k = harness(env);
  assert.equal(await k.run('import-env', 'DOCKER_HOST', '--keep'), 0);
  assert.equal(openSecretStore(home, env).get('DOCKER_HOST'), 'unix:///run/docker.sock');
  assert.match(readFileSync(envFile, 'utf8'), /DOCKER_HOST=/);
  assert.equal(await k.run('import-env', KEY_FILE_ENV), 0);
  assert.equal(openSecretStore(home, env).get(KEY_FILE_ENV), undefined);
  assert.equal(await k.run('import-env', 'NOT_THERE'), 1);
});

test('keygen writes a private random key file that unlocks the store', async () => {
  const dir = tempDir();
  const home = tempDir();
  const keyFile = join(dir, 'ruby.key');
  const h = harness({ RUBY_HOME: home });
  assert.equal(await h.run('keygen', keyFile), 0);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const key = readFileSync(keyFile, 'utf8').trim();
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(h.all().includes(key), false, 'the key is not printed');
  assert.equal(await h.run('keygen', keyFile), 1, 'never overwrites a key');
  const env = { RUBY_HOME: home, [KEY_FILE_ENV]: keyFile };
  assert.equal(await harness(env).run('set', 'A_KEY'), 0);
  assert.equal(openSecretStore(home, env).get('A_KEY'), VALUE);
  const inside = harness({ RUBY_HOME: home });
  await inside.run('keygen', join(home, 'key'));
  assert.match(inside.err(), /inside/);
});
