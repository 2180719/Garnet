import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../../config/index.ts';
import { isGarnetError } from '../../contracts/index.ts';
import { AnswerPrompter } from './prompt.ts';
import { sandboxStep } from './sandbox.ts';

const current = () => defaultConfig().sandbox;

test('setup: docker and local need no more questions', async () => {
  const p = new AnswerPrompter({ sandbox: 'docker' });
  assert.equal((await sandboxStep(p, current())).backend, 'docker');
  assert.deepEqual(p.asked, ['sandbox']);
  const q = new AnswerPrompter({ sandbox: 'local' });
  assert.equal((await sandboxStep(q, current())).backend, 'local');
  // A script that passes no flag keeps what is configured.
  assert.equal((await sandboxStep(new AnswerPrompter(), current())).backend, 'docker');
});

test('setup: ssh with the agent or a key file produces a valid config and only names the passphrase secret', async () => {
  const agent = await sandboxStep(
    new AnswerPrompter({ sandbox: 'ssh', 'ssh-host': 'build.example.com', 'ssh-user': 'garnet', 'ssh-workdir': '/srv/garnet', 'ssh-auth': 'agent' }),
    current(),
  );
  assert.equal(agent.backend, 'ssh');
  assert.equal(agent.ssh.agent, true);
  assert.equal(agent.ssh.hostKeyChecking, 'strict');
  assert.equal(agent.ssh.identityFile, undefined);

  const p = new AnswerPrompter({
    sandbox: 'ssh', 'ssh-host': '10.0.0.5', 'ssh-user': 'garnet', 'ssh-workdir': '/srv/garnet', 'ssh-auth': 'key', 'ssh-key': '/home/o/.ssh/garnet', 'ssh-passphrase-env': 'GARNET_SSH_KEY_PASSPHRASE', 'ssh-host-keys': 'accept-new',
  });
  const key = await sandboxStep(p, current());
  assert.deepEqual([key.ssh.agent, key.ssh.identityFile, key.ssh.passphraseEnv, key.ssh.hostKeyChecking], [false, '/home/o/.ssh/garnet', 'GARNET_SSH_KEY_PASSPHRASE', 'accept-new']);
  assert.ok(!p.asked.includes('ssh-passphrase'), 'no secret value is ever asked for');
});

test('setup: invalid ssh answers are rejected with the reason', async () => {
  const base = { sandbox: 'ssh', 'ssh-user': 'garnet', 'ssh-workdir': '/srv/garnet', 'ssh-auth': 'agent' };
  await assert.rejects(sandboxStep(new AnswerPrompter({ ...base, 'ssh-host': '-oProxyCommand=x' }), current()), (e) => isGarnetError(e, 'invalid_input') && /Invalid ssh host/.test((e as Error).message));
  await assert.rejects(sandboxStep(new AnswerPrompter({ ...base, 'ssh-host': 'h.example.com', 'ssh-user': 'a b' }), current()), (e) => isGarnetError(e, 'invalid_input'));
  await assert.rejects(sandboxStep(new AnswerPrompter({ ...base, 'ssh-host': 'h.example.com', 'ssh-workdir': 'relative' }), current()), (e) => isGarnetError(e, 'invalid_input'));
});
