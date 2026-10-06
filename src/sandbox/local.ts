import { spawn as nodeSpawn } from 'node:child_process';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  realWorkspace,
  resolveCwd,
  supervise,
  validateEnv,
  type RunRequest,
  type RunResult,
  type Sandbox,
  type SpawnFn,
} from './sandbox.ts';

export type LocalSandboxOptions = {
  workspace: string;
  maxOutputBytes?: number;
  spawn?: SpawnFn;
};

/**
 * Runs `sh -c` directly on the host, starting in the workspace, with a minimal
 * environment. NOT a security boundary: the command runs as Garnet's user and can
 * read, write and reach anything that user can. Use only when the owner
 * explicitly chooses it.
 */
export class LocalSandbox implements Sandbox {
  readonly kind = 'local' as const;
  readonly isolated = false;
  readonly workspace: string;
  private readonly maxOutputBytes: number;
  private readonly spawn: SpawnFn;

  constructor(opts: LocalSandboxOptions) {
    this.workspace = realWorkspace(opts.workspace);
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { host } = resolveCwd(this.workspace, req.cwd);
    const env = validateEnv(req.env);
    if (req.signal.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false };
    const child = this.spawn('sh', ['-c', req.command], {
      cwd: host,
      // Own process group so the whole tree can be killed.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: this.workspace, LANG: 'C.UTF-8', ...Object.fromEntries(env) },
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    return supervise({
      child,
      req,
      maxOutputBytes: this.maxOutputBytes,
      terminate: async () => killGroup(),
      // Background children that stayed in the group would keep the pipes open; end them with the command.
      onExit: killGroup,
    });
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'local shell on the host (not isolated)' };
  }
}
