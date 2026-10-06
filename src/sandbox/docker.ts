import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { RubyError } from '../contracts/index.ts';
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

export type DockerSandboxOptions = {
  /** Absolute host path mounted read-write at /workspace. */
  workspace: string;
  /** Image with a POSIX `sh`. Never pulled by run(); see check(). */
  image?: string;
  network?: 'none' | 'bridge';
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  /** Byte cap per stream (stdout, stderr). */
  maxOutputBytes?: number;
  dockerPath?: string;
  /** Container user as "uid:gid". Defaults to the host process's uid:gid, else 65534:65534. */
  user?: string;
  spawn?: SpawnFn;
  /** Environment for the docker *client* (not the container). Defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
};

export const DEFAULT_IMAGE = 'debian:stable-slim';
const WORKSPACE_LABEL = 'ruby.exec.workspace';
/** Variables the docker client itself may need. None of them reach the container. */
const CLIENT_ENV = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'XDG_RUNTIME_DIR'];
const KILL_RETRY_MS = 250;
const KILL_GIVE_UP_MS = 30_000;

/**
 * Runs each command in a fresh, locked-down container with only the workspace
 * mounted. This is the isolation boundary for `exec`.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly isolated = true;
  readonly workspace: string;
  private readonly image: string;
  private readonly network: 'none' | 'bridge';
  private readonly memory: string;
  private readonly cpus: number;
  private readonly pidsLimit: number;
  private readonly maxOutputBytes: number;
  private readonly docker: string;
  private readonly user: string;
  private readonly spawn: SpawnFn;
  private readonly clientEnv: NodeJS.ProcessEnv;

  constructor(opts: DockerSandboxOptions) {
    if (!opts.workspace.startsWith('/')) throw new RubyError('config', 'The sandbox workspace must be an absolute path.');
    this.workspace = realWorkspace(opts.workspace);
    // `-v src:dst:opts` is split on ':' and mount options on ','.
    if (/[:,]/.test(this.workspace)) {
      throw new RubyError('config', `The sandbox workspace path "${this.workspace}" may not contain ":" or ",".`);
    }
    this.image = opts.image ?? DEFAULT_IMAGE;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(this.image)) throw new RubyError('config', `Invalid sandbox image "${this.image}".`);
    this.network = opts.network ?? 'none';
    if (this.network !== 'none' && this.network !== 'bridge') throw new RubyError('config', `Invalid sandbox network "${String(this.network)}".`);
    this.memory = opts.memory ?? '512m';
    if (!/^[0-9]+[bkmg]?$/i.test(this.memory)) throw new RubyError('config', `Invalid sandbox memory limit "${this.memory}".`);
    this.cpus = opts.cpus ?? 1;
    if (!(this.cpus > 0 && Number.isFinite(this.cpus))) throw new RubyError('config', 'Sandbox cpus must be a positive number.');
    this.pidsLimit = opts.pidsLimit ?? 256;
    if (!Number.isInteger(this.pidsLimit) || this.pidsLimit < 1) throw new RubyError('config', 'Sandbox pidsLimit must be a positive integer.');
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.docker = opts.dockerPath ?? 'docker';
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    this.user = opts.user ?? (uid !== undefined && gid !== undefined ? `${uid}:${gid}` : '65534:65534');
    if (!/^[0-9]+:[0-9]+$/.test(this.user)) throw new RubyError('config', `Invalid sandbox user "${this.user}"; use uid:gid.`);
    this.spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
    const hostEnv = opts.hostEnv ?? process.env;
    this.clientEnv = Object.fromEntries(CLIENT_ENV.filter((k) => hostEnv[k] !== undefined).map((k) => [k, hostEnv[k]]));
  }

  /** The full `docker run` argument list for a request (exported for review and tests). */
  runArgs(name: string, containerCwd: string, env: [string, string][], command: string): string[] {
    return [
      'run', '--rm', '-i',
      '--name', name,
      '--label', `${WORKSPACE_LABEL}=${this.workspace}`,
      '--pull', 'never',
      '--network', this.network,
      '--memory', this.memory,
      '--memory-swap', this.memory,
      '--cpus', String(this.cpus),
      '--pids-limit', String(this.pidsLimit),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
      '--user', this.user,
      '--hostname', 'sandbox',
      '--log-driver', 'none',
      '-v', `${this.workspace}:/workspace:rw`,
      '-w', containerCwd,
      '-e', 'HOME=/tmp',
      // Always NAME=value: a bare `-e NAME` would copy the variable from the docker client's environment.
      ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      this.image,
      'sh', '-c', command,
    ];
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { rel } = resolveCwd(this.workspace, req.cwd);
    const env = validateEnv(req.env);
    if (req.signal.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false };
    const name = `ruby-exec-${randomBytes(8).toString('hex')}`;
    const containerCwd = rel ? `/workspace/${rel}` : '/workspace';
    const child = this.spawn(this.docker, this.runArgs(name, containerCwd, env, req.command), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.clientEnv,
    });
    return supervise({
      child,
      req,
      maxOutputBytes: this.maxOutputBytes,
      terminate: async (done, exited) => {
        // The container may not exist yet (still being created), so retry until the client exits.
        const started = Date.now();
        while (!done()) {
          await this.quiet(['kill', name]);
          if (done()) break;
          if (Date.now() - started > KILL_GIVE_UP_MS) {
            child.kill('SIGKILL');
            break;
          }
          await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_RETRY_MS))]);
        }
        // --rm removes it, but make sure even if the client died first.
        await this.quiet(['rm', '-f', name]);
      },
    });
  }

  /** Checks that the daemon is reachable and the image is present locally. */
  async check(): Promise<{ ok: boolean; detail: string }> {
    const version = await this.quiet(['version', '--format', '{{.Server.Version}}'], 15_000);
    if (version.code !== 0) {
      return { ok: false, detail: `Docker is not available (${this.docker} version failed: ${version.output.trim() || 'no output'}). Install and start Docker, or set the exec permission to deny.` };
    }
    const image = await this.quiet(['image', 'inspect', '--format', '{{.Id}}', this.image], 15_000);
    if (image.code !== 0) {
      return { ok: false, detail: `Docker ${version.output.trim()} is running but the sandbox image "${this.image}" is not present. Pull it with: docker pull ${this.image}` };
    }
    return { ok: true, detail: `Docker ${version.output.trim()}, image ${this.image}, network ${this.network}` };
  }

  /** Removes containers left over from a previous crash of this workspace's sandbox. Returns how many. */
  async cleanup(): Promise<number> {
    const list = await this.quiet(['ps', '-aq', '--filter', `label=${WORKSPACE_LABEL}=${this.workspace}`], 15_000);
    const ids = list.code === 0 ? list.output.split(/\s+/).filter(Boolean) : [];
    if (ids.length) await this.quiet(['rm', '-f', ...ids], 30_000);
    return ids.length;
  }

  /** Runs a docker client command without a shell; never throws. */
  private quiet(args: string[], timeoutMs = 10_000): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      let output = '';
      let child;
      try {
        child = this.spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.clientEnv });
      } catch (e) {
        resolve({ code: null, output: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const add = (b: Buffer) => {
        if (output.length < 10_000) output += b.toString('utf8');
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, output: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }
}
