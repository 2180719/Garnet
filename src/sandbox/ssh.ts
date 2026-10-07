import { spawn as nodeSpawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { GarnetError } from '../contracts/index.ts';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  realWorkspace,
  supervise,
  validateEnv,
  type RunRequest,
  type RunResult,
  type Sandbox,
  type SpawnFn,
} from './sandbox.ts';

export type HostKeyChecking = 'strict' | 'accept-new' | 'off';

export type SshSandboxOptions = {
  /** Local workspace the session uses. Commands do not run here; it is only the root that `cwd` is relative to. */
  workspace: string;
  host: string;
  user: string;
  /** Absolute directory on the remote host that plays the role of the workspace. */
  workdir: string;
  port?: number;
  /** Absolute path of a private key file on this machine. */
  identityFile?: string;
  /** Authenticate through the running ssh-agent. */
  agent?: boolean;
  /** Passphrase of `identityFile`, already resolved by the composition root. Reaches ssh only through a private askpass helper. */
  passphrase?: string;
  /** Default `strict`: the host must already be in known_hosts. */
  hostKeyChecking?: HostKeyChecking;
  knownHostsFile?: string;
  connectTimeoutSeconds?: number;
  sshPath?: string;
  /** Byte cap per stream (stdout, stderr). */
  maxOutputBytes?: number;
  spawn?: SpawnFn;
  /** Environment the ssh client may inherit (PATH, HOME, LANG, SSH_AUTH_SOCK). Defaults to process.env. */
  hostEnv?: NodeJS.ProcessEnv;
};

const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const KILL_GIVE_UP_MS = 5_000;
/** The remote script exits with this when the workdir or cwd is unusable (not a command exit code). */
export const REMOTE_REFUSED = 125;

export function validateSshHost(host: string): string {
  const ok = !host.includes('%') && (isIP(host) !== 0 || (host.length <= 253 && host.split('.').every((l) => HOST_LABEL.test(l))));
  if (!ok) throw new GarnetError('config', `Invalid ssh host "${host}": use a host name or an IP address (no user@, port, URL or options).`);
  return host;
}

export function validateSshUser(user: string): string {
  if (!USER_NAME.test(user)) throw new GarnetError('config', `Invalid ssh user "${user}".`);
  return user;
}

export function validateSshPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GarnetError('config', `Invalid ssh port ${String(port)}.`);
  return port;
}

function validateLocalPath(what: string, p: string): string {
  if (!isAbsolute(p) || /[\0\n\r,"]/.test(p)) {
    throw new GarnetError('config', `${what} must be an absolute path without newlines, commas or quotes (got "${p}").`);
  }
  return p;
}

export function validateRemoteWorkdir(dir: string): string {
  if (!dir.startsWith('/') || /[\0\n\r]/.test(dir) || /(^|\/)\.\.(\/|$)/.test(dir)) {
    throw new GarnetError('config', `The ssh workdir must be an absolute path on the remote host without ".." (got "${dir}").`);
  }
  const clean = posix.normalize(dir).replace(/(.)\/$/, '$1');
  if (clean === '/') throw new GarnetError('config', 'The ssh workdir cannot be the remote filesystem root.');
  return clean;
}

/** POSIX single-quote quoting: the result is one literal word for any POSIX shell. */
export function shellQuote(s: string): string {
  if (s.includes('\0')) throw new GarnetError('invalid_input', 'Value contains a NUL byte.');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Maps a workspace-relative cwd to a clean relative path ('' for the root).
 * Purely lexical: the remote script re-checks the real path, which also
 * covers symlinks.
 */
export function remoteRelativeCwd(cwd: string): string {
  if (cwd.includes('\0')) throw new GarnetError('invalid_input', 'cwd contains a NUL byte.');
  if (cwd.startsWith('/')) throw new GarnetError('denied', `Path "${cwd}" must be relative to the workspace (the ssh backend runs in the remote workdir).`);
  const norm = posix.normalize(cwd === '' ? '.' : cwd);
  if (norm === '..' || norm.startsWith('../')) throw new GarnetError('denied', `Path "${cwd}" is outside the workspace.`);
  return norm === '.' ? '' : norm.replace(/\/$/, '');
}

/** Text safe inside a double-quoted remote echo. */
const plainText = (s: string) => s.replace(/["$`\\\n\r]/g, '');

/**
 * The script the remote `sh` runs. Every dynamic part is a single-quoted
 * literal. It resolves the workdir, enters `rel`, refuses to continue when the
 * real directory is outside the workdir (symlinks), then replaces itself with
 * the command's shell so exit codes and signals are the command's own.
 */
export function remoteScript(workdir: string, rel: string, env: readonly (readonly [string, string])[], command: string): string {
  const parts = [
    `ws=$(cd -- ${shellQuote(workdir)} 2>/dev/null && pwd -P) || { echo "garnet: remote workdir ${plainText(workdir)} is not accessible" >&2; exit ${REMOTE_REFUSED}; }`,
  ];
  if (rel) {
    parts.push(
      `cd -- "$ws"/${shellQuote(rel)} 2>/dev/null || { echo "garnet: directory does not exist in the workspace" >&2; exit ${REMOTE_REFUSED}; }`,
      `case $(pwd -P) in "$ws"|"$ws"/*) ;; *) echo "garnet: path is outside the workspace" >&2; exit ${REMOTE_REFUSED};; esac`,
    );
  } else parts.push('cd -- "$ws"');
  const assigns = env.map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
  parts.push(`exec ${assigns ? `env ${assigns} ` : ''}sh -c ${shellQuote(command)}`);
  return parts.join('\n');
}

/** The one word the remote login shell receives: `sh -c <script>`. */
function remoteCommand(script: string): string {
  return `sh -c ${shellQuote(script)}`;
}

/**
 * Runs each command on a remote host through the system `ssh` client, with
 * argv only on this side (no local shell) and every remote value single-quoted.
 *
 * `isolated` means "not on the Garnet host". The strength of the boundary is
 * the remote account: the command can do anything that account can, on that
 * machine and from it onward (the remote may reach the network). Use a
 * dedicated, unprivileged account or a disposable VM.
 */
export class SshSandbox implements Sandbox {
  readonly kind = 'ssh' as const;
  readonly isolated = true;
  readonly networked = true;
  readonly workspace: string;
  private readonly host: string;
  private readonly user: string;
  private readonly port: number;
  private readonly workdir: string;
  private readonly identityFile: string | undefined;
  private readonly agent: boolean;
  private readonly passphrase: string | undefined;
  private readonly hostKeyChecking: HostKeyChecking;
  private readonly knownHostsFile: string | undefined;
  private readonly connectTimeout: number;
  private readonly ssh: string;
  private readonly maxOutputBytes: number;
  private readonly spawn: SpawnFn;
  private readonly hostEnv: NodeJS.ProcessEnv;

  constructor(opts: SshSandboxOptions) {
    this.workspace = realWorkspace(opts.workspace);
    this.host = validateSshHost(opts.host);
    this.user = validateSshUser(opts.user);
    this.port = validateSshPort(opts.port ?? 22);
    this.workdir = validateRemoteWorkdir(opts.workdir);
    this.identityFile = opts.identityFile === undefined ? undefined : validateLocalPath('The ssh identity file', opts.identityFile);
    this.agent = opts.agent ?? false;
    this.passphrase = opts.passphrase || undefined;
    if (!this.identityFile && !this.agent) throw new GarnetError('config', 'The ssh backend needs an identity file or the ssh-agent (ssh never asks for a password).');
    if (this.passphrase && !this.identityFile) throw new GarnetError('config', 'An ssh passphrase only applies to an identity file.');
    this.hostKeyChecking = opts.hostKeyChecking ?? 'strict';
    if (!['strict', 'accept-new', 'off'].includes(this.hostKeyChecking)) throw new GarnetError('config', `Invalid ssh hostKeyChecking "${String(this.hostKeyChecking)}".`);
    this.knownHostsFile = opts.knownHostsFile === undefined ? undefined : validateLocalPath('The ssh known_hosts file', opts.knownHostsFile);
    this.connectTimeout = opts.connectTimeoutSeconds ?? 10;
    if (!Number.isInteger(this.connectTimeout) || this.connectTimeout < 1 || this.connectTimeout > 120) throw new GarnetError('config', 'ssh connectTimeoutSeconds must be between 1 and 120.');
    this.ssh = opts.sshPath ?? 'ssh';
    if (!this.ssh || this.ssh.includes('\0')) throw new GarnetError('config', 'Invalid ssh client path.');
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
    this.hostEnv = opts.hostEnv ?? process.env;
  }

  /** `user@host:port` for messages. */
  get target(): string {
    return `${this.user}@${this.host}:${this.port}`;
  }

  /** The ssh argument list for a remote command (exported for review and tests). */
  sshArgs(remote: string): string[] {
    const strictness = { strict: 'yes', 'accept-new': 'accept-new', off: 'no' }[this.hostKeyChecking];
    return [
      // Ignore ~/.ssh/config: it can name ProxyCommand/LocalCommand, i.e. run host commands.
      '-F', '/dev/null',
      // With a passphrase, ssh needs to ask (through the askpass helper); BatchMode would skip the key.
      '-o', `BatchMode=${this.passphrase ? 'no' : 'yes'}`,
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', `StrictHostKeyChecking=${strictness}`,
      ...(this.hostKeyChecking === 'off' ? ['-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR'] : this.knownHostsFile ? ['-o', `UserKnownHostsFile=${this.knownHostsFile}`] : []),
      '-o', `ConnectTimeout=${this.connectTimeout}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'ForwardAgent=no',
      '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      ...(this.agent ? [] : ['-o', 'IdentityAgent=none']),
      ...(this.identityFile ? ['-o', 'IdentitiesOnly=yes', '-i', this.identityFile] : []),
      '-T',
      '-p', String(this.port),
      '-l', this.user,
      '--',
      this.host,
      remote,
    ];
  }

  private clientEnv(askpass: string | null): NodeJS.ProcessEnv {
    const e = this.hostEnv;
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'LANG']) if (e[k] !== undefined) env[k] = e[k];
    if (this.agent && e.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = e.SSH_AUTH_SOCK;
    if (askpass && this.passphrase) {
      env.SSH_ASKPASS = askpass;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.GARNET_SSH_PASSPHRASE = this.passphrase;
    }
    return env;
  }

  /** A private one-use askpass helper that prints $GARNET_SSH_PASSPHRASE; no helper when no passphrase is configured. */
  private makeAskpass(): { path: string | null; cleanup: () => void } {
    if (!this.passphrase) return { path: null, cleanup: () => {} };
    const dir = mkdtempSync(join(tmpdir(), 'garnet-askpass-'));
    chmodSync(dir, 0o700);
    const path = join(dir, 'askpass.sh');
    writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' "$GARNET_SSH_PASSPHRASE"\n', { mode: 0o700 });
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  async run(req: RunRequest): Promise<RunResult> {
    const rel = remoteRelativeCwd(req.cwd);
    const env = validateEnv(req.env);
    if (req.command.includes('\0')) throw new GarnetError('invalid_input', 'The command contains a NUL byte.');
    if (req.signal.aborted) return { exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true, truncated: false };
    const askpass = this.makeAskpass();
    try {
      let child;
      try {
        child = this.spawn(this.ssh, this.sshArgs(remoteCommand(remoteScript(this.workdir, rel, env, req.command))), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.clientEnv(askpass.path),
        });
      } catch (e) {
        throw new GarnetError('tool_failed', `Could not start ssh: ${(e as Error).message}`);
      }
      const c = child;
      const result = await supervise({
        child: c,
        req,
        maxOutputBytes: this.maxOutputBytes,
        // Closing the connection ends the session; the remote command gets SIGHUP/SIGPIPE like any dropped ssh login.
        terminate: async (_done, exited) => {
          c.kill('SIGKILL');
          await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_GIVE_UP_MS))]);
        },
      });
      if (result.exitCode === 255 && !result.timedOut && !result.cancelled) {
        result.stderr += `${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}[exit 255: the ssh connection to ${this.target} failed, or the command itself exited 255]\n`;
      }
      return result;
    } finally {
      askpass.cleanup();
    }
  }

  /** Read-only probe: the key file is readable, the host answers and the remote workdir exists. Runs no command beyond `cd` and `pwd`. */
  async check(): Promise<{ ok: boolean; detail: string }> {
    if (this.identityFile) {
      try {
        if (!statSync(this.identityFile).isFile()) return { ok: false, detail: `The ssh identity file ${this.identityFile} is not a file.` };
      } catch {
        return { ok: false, detail: `The ssh identity file ${this.identityFile} does not exist or is not readable. Fix sandbox.ssh.identityFile.` };
      }
    }
    if (this.agent && !this.identityFile && !this.hostEnv.SSH_AUTH_SOCK) {
      return { ok: false, detail: 'sandbox.ssh.agent is on but SSH_AUTH_SOCK is not set for Garnet. Start ssh-agent for the service, or use identityFile.' };
    }
    const askpass = this.makeAskpass();
    try {
      const probe = remoteCommand(
        `cd -- ${shellQuote(this.workdir)} 2>/dev/null && pwd -P || { echo "garnet: remote workdir ${plainText(this.workdir)} is not accessible" >&2; exit ${REMOTE_REFUSED}; }`,
      );
      const r = await this.quiet(this.sshArgs(probe), askpass.path, this.connectTimeout * 1000 + 10_000);
      if (r.code === 0) {
        return { ok: true, detail: `ssh ${this.target}, workdir ${r.output.trim() || this.workdir}, host key checking ${this.hostKeyChecking}. The boundary is only as strong as the remote account.` };
      }
      return { ok: false, detail: this.explain(r) };
    } finally {
      askpass.cleanup();
    }
  }

  private explain(r: { code: number | null; output: string; spawnError?: string }): string {
    if (r.spawnError) {
      return `The ssh client "${this.ssh}" could not be started (${r.spawnError}). Install OpenSSH (for example the openssh-client package) or set sandbox.ssh.sshPath.`;
    }
    const out = r.output.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no output';
    if (r.code === REMOTE_REFUSED) return `Connected to ${this.target} but ${out}. Create the directory, or fix sandbox.ssh.workdir.`;
    let fix = 'Check the host, port and network.';
    if (/host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(out)) {
      fix =
        this.hostKeyChecking === 'strict'
          ? `Verify the host's key fingerprint out of band, then add it (ssh-keyscan -p ${this.port} ${this.host} >> ~/.ssh/known_hosts), or set sandbox.ssh.hostKeyChecking to accept-new to trust the first key seen. A changed key may mean someone is intercepting the connection.`
          : 'The host key does not match known_hosts. If the host was reinstalled, remove the old entry with ssh-keygen -R; otherwise treat it as an attack.';
    } else if (/permission denied|no more authentication methods|publickey/i.test(out)) {
      fix = 'The key was not accepted. Check sandbox.ssh.user, the key (identityFile or ssh-agent), its passphrase (passphraseEnv) and the remote authorized_keys.';
    } else if (/could not resolve|name or service not known|nodename/i.test(out)) {
      fix = 'The host name did not resolve. Check sandbox.ssh.host.';
    } else if (/timed out|timeout/i.test(out) || r.code === null) {
      fix = 'The host did not answer in time. Check the host, port, firewall and sandbox.ssh.connectTimeoutSeconds.';
    }
    return `ssh to ${this.target} failed (exit ${r.code ?? 'none'}: ${out}). ${fix}`;
  }

  /** Runs the ssh client without a shell and returns its output; never throws. */
  private quiet(args: string[], askpass: string | null, timeoutMs: number): Promise<{ code: number | null; output: string; spawnError?: string }> {
    return new Promise((resolve) => {
      let output = '';
      let child;
      try {
        child = this.spawn(this.ssh, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.clientEnv(askpass) });
      } catch (e) {
        resolve({ code: null, output: (e as Error).message, spawnError: (e as Error).message });
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
        resolve({ code: null, output: e.message, spawnError: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }
}
