import { RubyError } from '../contracts/index.ts';
import { DockerSandbox, type DockerSandboxOptions } from './docker.ts';
import { LocalSandbox } from './local.ts';
import type { Sandbox } from './sandbox.ts';

export type SandboxKind = 'docker' | 'local';
export type SandboxOptions = DockerSandboxOptions;

/** Creates a sandbox without contacting Docker. Local ignores the Docker-only options. */
export function createSandbox(kind: SandboxKind, opts: SandboxOptions): Sandbox {
  if (kind === 'docker') return new DockerSandbox(opts);
  if (kind === 'local') return new LocalSandbox({ workspace: opts.workspace, maxOutputBytes: opts.maxOutputBytes, spawn: opts.spawn });
  throw new RubyError('config', `Unknown sandbox backend "${String(kind)}".`);
}

/**
 * Throws a `config` error unless the sandbox is usable, and, when
 * `requireIsolated` is set, a real isolation boundary. Never falls back to a
 * weaker backend.
 */
export async function assertSandboxReady(sandbox: Sandbox, opts: { requireIsolated?: boolean } = {}): Promise<void> {
  if (opts.requireIsolated && !sandbox.isolated) {
    throw new RubyError('config', `An isolated sandbox is required but the "${sandbox.kind}" backend is not isolated.`);
  }
  const status = await sandbox.check();
  if (!status.ok) throw new RubyError('config', `The ${sandbox.kind} sandbox is unavailable: ${status.detail}`);
}

/** createSandbox + assertSandboxReady. Docker requires isolation by default. */
export async function openSandbox(kind: SandboxKind, opts: SandboxOptions, require: { requireIsolated?: boolean } = {}): Promise<Sandbox> {
  const sandbox = createSandbox(kind, opts);
  await assertSandboxReady(sandbox, { requireIsolated: require.requireIsolated ?? kind === 'docker' });
  return sandbox;
}
