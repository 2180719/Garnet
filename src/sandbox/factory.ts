import { GarnetError } from '../contracts/index.ts';
import { DockerSandbox, type DockerSandboxOptions } from './docker.ts';
import { LocalSandbox } from './local.ts';
import type { Sandbox, SandboxKind } from './sandbox.ts';
import { SshSandbox, type SshSandboxOptions } from './ssh.ts';

export type { SandboxKind } from './sandbox.ts';
/** Options for every backend; each reads only its own. `ssh` is required for the ssh backend. */
export type SandboxOptions = DockerSandboxOptions & { ssh?: Omit<SshSandboxOptions, 'workspace' | 'spawn' | 'maxOutputBytes' | 'hostEnv'> };

type Backend = {
  create(opts: SandboxOptions): Sandbox;
  /** Whether `openSandbox` demands a real boundary unless told otherwise. */
  requireIsolated: boolean;
};

/**
 * The backend table. A new backend (another container runtime, a VM) is one
 * class that implements `Sandbox`, one kind in `SandboxKind` and one entry here.
 */
const backends: Record<SandboxKind, Backend> = {
  docker: { create: (opts) => new DockerSandbox(opts), requireIsolated: true },
  local: { create: (opts) => new LocalSandbox({ workspace: opts.workspace, maxOutputBytes: opts.maxOutputBytes, spawn: opts.spawn }), requireIsolated: false },
  ssh: {
    create: (opts) => {
      if (!opts.ssh) throw new GarnetError('config', 'The ssh sandbox needs the sandbox.ssh options (host, user, workdir and a key or the ssh-agent).');
      return new SshSandbox({
        ...opts.ssh,
        workspace: opts.workspace,
        ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
        ...(opts.spawn ? { spawn: opts.spawn } : {}),
        ...(opts.hostEnv ? { hostEnv: opts.hostEnv } : {}),
      });
    },
    requireIsolated: true,
  },
};

/** Creates a sandbox without contacting Docker or the remote host. Options a backend does not use are ignored. */
export function createSandbox(kind: SandboxKind, opts: SandboxOptions): Sandbox {
  const backend = Object.hasOwn(backends, kind) ? backends[kind] : undefined;
  if (!backend) throw new GarnetError('config', `Unknown sandbox backend "${String(kind)}".`);
  return backend.create(opts);
}

/** True when the backend is expected to be a real boundary (everything except `local`). */
export function requiresIsolation(kind: SandboxKind): boolean {
  return Object.hasOwn(backends, kind) ? backends[kind].requireIsolated : true;
}

/**
 * Throws a `config` error unless the sandbox is usable, and, when
 * `requireIsolated` is set, a real isolation boundary. Never falls back to a
 * weaker backend.
 */
export async function assertSandboxReady(sandbox: Sandbox, opts: { requireIsolated?: boolean } = {}): Promise<void> {
  if (opts.requireIsolated && !sandbox.isolated) {
    throw new GarnetError('config', `An isolated sandbox is required but the "${sandbox.kind}" backend is not isolated.`);
  }
  const status = await sandbox.check();
  if (!status.ok) throw new GarnetError('config', `The ${sandbox.kind} sandbox is unavailable: ${status.detail}`);
}

/** createSandbox + assertSandboxReady. Every backend but `local` requires isolation by default. */
export async function openSandbox(kind: SandboxKind, opts: SandboxOptions, require: { requireIsolated?: boolean } = {}): Promise<Sandbox> {
  const sandbox = createSandbox(kind, opts);
  await assertSandboxReady(sandbox, { requireIsolated: require.requireIsolated ?? requiresIsolation(kind) });
  return sandbox;
}
