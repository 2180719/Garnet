import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig, writeConfig } from '../config/index.ts';
import { main, type Io } from './main.ts';

function capture(): Io & { out_: string; err_: string } {
  const io = {
    out_: '',
    err_: '',
    out: (t: string) => (io.out_ += t),
    err: (t: string) => (io.err_ += t),
  };
  return io;
}

async function withHome<T>(edit: (c: ReturnType<typeof defaultConfig>) => void, fn: () => Promise<T>): Promise<T> {
  const home = join(tempDir(), 'garnet');
  const c = defaultConfig();
  edit(c);
  writeConfig(home, c);
  const prev = process.env.GARNET_HOME;
  process.env.GARNET_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GARNET_HOME;
    else process.env.GARNET_HOME = prev;
  }
}

test('config explain documents every sandbox.ssh option', async () => {
  const io = capture();
  assert.equal(await main(['config', 'explain'], io), 0);
  for (const key of ['sandbox.backend (one of docker|local|ssh, default "docker")', 'sandbox.ssh.host', 'sandbox.ssh.workdir', 'sandbox.ssh.hostKeyChecking (one of strict|accept-new|off, default "strict")', 'sandbox.ssh.passphraseEnv', 'sandbox.ssh.identityFile', 'sandbox.ssh.agent', 'sandbox.ssh.knownHostsFile']) {
    assert.ok(io.out_.includes(key), key);
  }
  const lines = io.out_.split('\n').filter((l) => l.startsWith('sandbox.ssh.'));
  assert.ok(lines.length >= 11);
  for (const l of lines) assert.equal(l.split('\u2014').length, 2, `one separator and no dash in the text: ${l}`);
});

test('garnet sandbox check: usage, and an unusable ssh client is reported with a fix, without touching a real ssh', async () => {
  const bad = capture();
  assert.equal(await main(['sandbox'], bad), 2);
  assert.match(bad.err_, /Usage: garnet sandbox check/);

  const io = capture();
  const code = await withHome(
    (c) => {
      c.sandbox.backend = 'ssh';
      c.sandbox.ssh = { ...c.sandbox.ssh, host: 'build.example.com', user: 'garnet', workdir: '/srv/garnet', agent: true, sshPath: '/nonexistent/garnet-test-ssh' };
    },
    () => {
      process.env.SSH_AUTH_SOCK = '/tmp/none.sock';
      return main(['sandbox', 'check'], io);
    },
  );
  assert.equal(code, 1);
  assert.match(io.err_, /Sandbox ssh is not ready: The ssh client "\/nonexistent\/garnet-test-ssh" could not be started/);
});

test('garnet sandbox check: a missing passphrase secret is a config error naming the secret, never a value', async () => {
  const io = capture();
  const code = await withHome(
    (c) => {
      c.sandbox.backend = 'ssh';
      c.sandbox.ssh = { ...c.sandbox.ssh, host: 'h.example.com', user: 'u', workdir: '/w', agent: false, identityFile: '/k', passphraseEnv: 'GARNET_TEST_UNSET_PASSPHRASE' };
    },
    () => main(['sandbox', 'check'], io),
  );
  assert.equal(code, 1);
  assert.match(io.err_, /GARNET_TEST_UNSET_PASSPHRASE, which is not set/);
});
