// Setup questions for the command sandbox backend. Kept apart from wizard.ts: the wizard calls
// `sandboxStep(p, draft.sandbox)` and stores the result in its draft config (see src/cli/AGENTS.md).
import { CONFIG_VERSION, parseConfig, type GarnetConfig } from '../../config/index.ts';
import { GarnetError } from '../../contracts/index.ts';
import { validateSshHost, validateSshUser } from '../../sandbox/index.ts';
import type { Prompter } from './prompt.ts';

type SandboxConfig = GarnetConfig['sandbox'];

const asProblem = (check: () => unknown): string | null => {
  try {
    check();
    return null;
  } catch (e) {
    return e instanceof GarnetError ? e.message : 'invalid';
  }
};

/**
 * Asks which backend runs commands and, for ssh, where. Only asked when the owner has
 * allowed commands. Returns a validated sandbox config; never stores a secret (the key
 * passphrase is only named, and `garnet secrets set <NAME>` stores it).
 */
export async function sandboxStep(p: Prompter, current: SandboxConfig): Promise<SandboxConfig> {
  const backend = await p.select({
    id: 'sandbox',
    message: 'Where should commands run?',
    help: 'docker is isolated on this machine. ssh runs on another machine and is only as strong a boundary as that account. local is not a boundary.',
    choices: [
      { value: 'docker', label: 'Docker container' },
      { value: 'ssh', label: 'Another machine over ssh' },
      { value: 'local', label: 'This machine, no isolation' },
    ],
    default: current.backend,
    auto: current.backend,
  });
  if (backend !== 'ssh') return parseConfig({ version: CONFIG_VERSION, sandbox: { ...current, backend } }).sandbox;

  const host = await p.text({ id: 'ssh-host', message: 'Remote host name or IP address?', ...(current.ssh.host ? { default: current.ssh.host } : {}), validate: (v) => asProblem(() => validateSshHost(v)) });
  const user = await p.text({
    id: 'ssh-user',
    message: 'Remote account? (use a dedicated, unprivileged one)',
    ...(current.ssh.user ? { default: current.ssh.user } : {}),
    validate: (v) => asProblem(() => validateSshUser(v)),
  });
  const workdir = await p.text({
    id: 'ssh-workdir',
    message: 'Directory on the remote host to run commands in?',
    help: 'An absolute path that already exists. It is separate from the local workspace.',
    ...(current.ssh.workdir ? { default: current.ssh.workdir } : {}),
    validate: (v) => (v.startsWith('/') ? null : 'use an absolute path'),
  });
  const auth = await p.select({
    id: 'ssh-auth',
    message: 'How does Garnet authenticate?',
    choices: [
      { value: 'agent', label: 'ssh-agent' },
      { value: 'key', label: 'A key file' },
    ],
    default: current.ssh.identityFile ? 'key' : 'agent',
    auto: current.ssh.identityFile ? 'key' : 'agent',
  });
  let identityFile: string | undefined;
  let passphraseEnv: string | undefined;
  if (auth === 'key') {
    identityFile = await p.text({ id: 'ssh-key', message: 'Absolute path of the private key file?', ...(current.ssh.identityFile ? { default: current.ssh.identityFile } : {}), validate: (v) => (v.startsWith('/') ? null : 'use an absolute path') });
    const name = await p.text({
      id: 'ssh-passphrase-env',
      message: 'Name of the secret holding the key passphrase? (empty for none)',
      help: 'Only the name goes in config. Store the value with `garnet secrets set <NAME>`.',
      default: current.ssh.passphraseEnv ?? '',
      auto: current.ssh.passphraseEnv ?? '',
      validate: (v) => (v === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? null : 'use letters, digits and underscores'),
    });
    passphraseEnv = name || undefined;
  }
  const hostKeyChecking = await p.select({
    id: 'ssh-host-keys',
    message: 'How should the remote host key be checked?',
    help: 'strict needs the host in known_hosts already. accept-new trusts the first key it sees.',
    choices: [
      { value: 'strict', label: 'strict (safe default)' },
      { value: 'accept-new', label: 'accept-new (trust on first use)' },
    ],
    default: current.ssh.hostKeyChecking === 'accept-new' ? 'accept-new' : 'strict',
    auto: current.ssh.hostKeyChecking === 'accept-new' ? 'accept-new' : 'strict',
  });
  const { identityFile: _key, passphraseEnv: _pass, ...rest } = current.ssh;
  const ssh = {
    ...rest,
    host,
    user,
    workdir,
    agent: auth === 'agent',
    hostKeyChecking,
    ...(identityFile ? { identityFile } : {}),
    ...(passphraseEnv ? { passphraseEnv } : {}),
  };
  return parseConfig({ version: CONFIG_VERSION, sandbox: { ...current, backend: 'ssh', ssh } }).sandbox;
}
