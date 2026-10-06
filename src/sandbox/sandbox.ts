import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { GarnetError } from '../contracts/index.ts';
import { resolveInWorkspace } from '../policy/index.ts';

export type RunRequest = {
  command: string;
  /** Working directory relative to the workspace root. */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** The only environment variables the command sees besides the backend's minimal defaults. */
  env?: Record<string, string>;
  stdin?: string;
};

export type RunResult = {
  /** Exit code of the command (or of the docker client); null when killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** True when stdout or stderr exceeded the byte cap and only the head was kept. */
  truncated: boolean;
};

export interface Sandbox {
  readonly kind: 'docker' | 'local';
  /** True only for a real isolation boundary. */
  readonly isolated: boolean;
  /** Absolute (real) host path of the workspace the sandbox exposes. */
  readonly workspace: string;
  run(req: RunRequest): Promise<RunResult>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

/** `child_process.spawn` signature, injectable for tests. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

/** Keeps the first `max` bytes of a stream and keeps draining the rest so the writer never blocks. */
export class OutputCollector {
  private readonly max: number;
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const room = this.max - this.size;
    if (room <= 0) {
      if (buf.length > 0) this.truncated = true;
      return;
    }
    const take = buf.length <= room ? buf : buf.subarray(0, room);
    if (take.length < buf.length) this.truncated = true;
    this.chunks.push(take);
    this.size += take.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Real path of the workspace, rejecting paths that cannot be a workspace. */
export function realWorkspace(workspace: string): string {
  let real: string;
  try {
    real = realpathSync(workspace);
  } catch {
    throw new GarnetError('config', `Sandbox workspace "${workspace}" does not exist.`);
  }
  if (!statSync(real).isDirectory()) throw new GarnetError('config', `Sandbox workspace "${workspace}" is not a directory.`);
  if (real === '/' || real === sep) throw new GarnetError('config', 'The sandbox workspace cannot be the filesystem root.');
  return real;
}

/**
 * Resolves a workspace-relative cwd, refusing escapes (symlinks included) and
 * directories that do not exist. Returns the host path and the path relative
 * to the workspace with forward slashes ('' for the root).
 */
export function resolveCwd(workspace: string, cwd: string): { host: string; rel: string } {
  if (cwd.includes('\0')) throw new GarnetError('invalid_input', 'cwd contains a NUL byte.');
  const host = resolveInWorkspace(workspace, cwd);
  const info = (() => {
    try {
      return statSync(host);
    } catch {
      return null;
    }
  })();
  if (!info) throw new GarnetError('invalid_input', `Directory "${cwd}" does not exist in the workspace.`);
  if (!info.isDirectory()) throw new GarnetError('invalid_input', `"${cwd}" is not a directory.`);
  // Use the real path so a symlinked directory maps to the same place inside a container.
  const rel = relative(workspace, realpathSync(host)).split(sep).join('/');
  if (rel === '..' || rel.startsWith('../')) throw new GarnetError('denied', `Path "${cwd}" is outside the workspace.`);
  return { host, rel };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnv(env: Record<string, string> | undefined): [string, string][] {
  const entries = Object.entries(env ?? {});
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k)) throw new GarnetError('invalid_input', `Invalid environment variable name "${k}".`);
    if (typeof v !== 'string' || v.includes('\0')) throw new GarnetError('invalid_input', `Invalid value for environment variable "${k}".`);
  }
  return entries;
}

export type Supervision = {
  child: ChildProcess;
  req: RunRequest;
  maxOutputBytes: number;
  /**
   * Stops the work; called at most once, on timeout or abort. `done()` reports
   * whether the child has exited; `exited` resolves when it does.
   */
  terminate: (done: () => boolean, exited: Promise<void>) => Promise<void>;
  /** Runs once after the child has exited (cleanup that must happen on every path). */
  onExit?: () => void;
};

/**
 * Collects output, enforces the timeout and cancellation, and resolves when
 * the child has closed. Rejects only when the process could not be started.
 */
export function supervise(s: Supervision): Promise<RunResult> {
  const { child, req } = s;
  const stdout = new OutputCollector(s.maxOutputBytes);
  const stderr = new OutputCollector(s.maxOutputBytes);
  let timedOut = false;
  let cancelled = false;
  let exited = false;
  let terminating: Promise<void> | null = null;
  let markExited = () => {};
  const exitedPromise = new Promise<void>((r) => (markExited = r));

  return new Promise<RunResult>((resolve, reject) => {
    const stop = () => {
      if (terminating || exited) return;
      terminating = s.terminate(() => exited, exitedPromise).catch(() => {});
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, req.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => stderr.push(b));
    child.stdin?.on('error', () => {}); // EPIPE when the command ignores stdin
    child.stdin?.end(req.stdin ?? '');

    const finish = () => {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    };
    child.on('exit', () => {
      exited = true;
      markExited();
      s.onExit?.();
    });
    child.on('error', (e) => {
      exited = true;
      markExited();
      finish();
      reject(new GarnetError('tool_failed', `Could not start the command: ${e.message}`));
    });
    child.on('close', (code: number | null) => {
      exited = true;
      markExited();
      finish();
      const result = (): RunResult => ({
        exitCode: code,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        cancelled,
        truncated: stdout.truncated || stderr.truncated,
      });
      // Wait for termination cleanup so nothing outlives run().
      if (terminating) void (terminating as Promise<void>).then(() => resolve(result()));
      else resolve(result());
    });
    if (req.signal.aborted) onAbort();
  });
}
