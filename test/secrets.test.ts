// The secret store wired through the composition root and the CLI.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { main, type Io } from '../src/cli/main.ts';
import { createChannels, createRuby } from '../src/main.ts';
import { openSecretStore, PASSPHRASE_ENV } from '../src/secrets/index.ts';
import { defaultConfig } from '../src/config/index.ts';

const kdf = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

test('createRuby resolves config secrets from the environment first, then the store', () => {
  const home = tempDir();
  openSecretStore(home, { [PASSPHRASE_ENV]: PASS }, { kdf }).setMany({ ANTHROPIC_API_KEY: 'sk-from-store', TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });

  // The model key comes from the store when the environment lacks it.
  const ruby = createRuby({ home, env: { [PASSPHRASE_ENV]: PASS }, memoryDb: true });
  try {
    assert.equal(ruby.secret('ANTHROPIC_API_KEY'), 'sk-from-store');
    assert.equal(ruby.model.id.length > 0, true);
  } finally {
    ruby.close();
  }
  const envFirst = createRuby({ home, env: { [PASSPHRASE_ENV]: PASS, ANTHROPIC_API_KEY: 'sk-from-env' }, memoryDb: true });
  try {
    assert.equal(envFirst.secret('ANTHROPIC_API_KEY'), 'sk-from-env');
    const config = defaultConfig();
    config.channels.telegram.enabled = true;
    assert.equal(createChannels(config, envFirst.secret).length, 1);
  } finally {
    envFirst.close();
  }

  // Locked: a config error that says how to unlock, not "no API key".
  assert.throws(() => createRuby({ home, env: {}, memoryDb: true }), /secret store .* is locked/);
  // An env-only setup with no store file is unchanged.
  const plain = tempDir();
  assert.throws(() => createRuby({ home: plain, env: {}, memoryDb: true }), /No API key found\. Set the ANTHROPIC_API_KEY environment variable or store it/);
  const ok = createRuby({ home: plain, env: { ANTHROPIC_API_KEY: 'sk-env' }, memoryDb: true });
  ok.close();
});

test('`ruby secrets` is wired into the CLI, in help, and warns about a passphrase in the env file', async () => {
  const home = tempDir();
  writeFileSync(join(home, 'env'), `${PASSPHRASE_ENV}=${PASS}\n`, { mode: 0o600 });
  const saved = { home: process.env.RUBY_HOME, pass: process.env[PASSPHRASE_ENV] };
  process.env.RUBY_HOME = home;
  delete process.env[PASSPHRASE_ENV];
  let out = '';
  let err = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t), readSecret: async () => 'value-from-stdin\n' };
  try {
    assert.equal(await main(['help'], io), 0);
    assert.match(out, /ruby secrets list\|set <NAME>/);
    assert.equal(await main(['secrets', 'set', 'A_KEY'], io), 0);
    assert.match(err, /RUBY_SECRETS_PASSPHRASE is in .*env, next to the store/);
    assert.equal(await main(['secrets', 'list'], io), 0);
    assert.match(out, /A_KEY/);
    assert.equal((out + err).includes('value-from-stdin'), false);
    assert.equal((out + err).includes(PASS), false);
  } finally {
    if (saved.home === undefined) delete process.env.RUBY_HOME;
    else process.env.RUBY_HOME = saved.home;
    if (saved.pass === undefined) delete process.env[PASSPHRASE_ENV];
    else process.env[PASSPHRASE_ENV] = saved.pass;
  }
});
