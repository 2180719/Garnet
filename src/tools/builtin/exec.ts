import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';
import { resolveInWorkspace } from '../../policy/index.ts';
import type { RunResult, Sandbox } from '../../sandbox/index.ts';

type ExecInput = { command: string; cwd: string; timeout_seconds: number };

/** `run_command`: runs a shell command in the given sandbox. Capability `exec` (deny by default). */
export function execTool(sandbox: Sandbox): ToolDefinition<ExecInput> {
  // Verified on first use (and again after a failure) so an unavailable backend is a clear error, never a fallback.
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    ready ??= sandbox
      .check()
      .then((status) => {
        if (!status.ok) throw new GarnetError('config', `The command sandbox is unavailable: ${status.detail} Do not retry; tell the owner.`);
      })
      .catch((e: unknown) => {
        ready = null; // check again next time
        throw e;
      });
    return ready;
  };

  const where = sandbox.isolated
    ? 'Runs in an isolated Linux container (sh -c) with the workspace mounted read-write at /workspace; the rest of the filesystem is read-only except /tmp, and there is no network unless the owner enabled it.'
    : 'Runs on the host with sh -c (not isolated), starting in the workspace.';
  return {
    name: 'run_command',
    version: 1,
    description: `Run a shell command. ${where} Each call is a fresh shell; nothing persists outside the workspace. Returns the exit code, then stdout and stderr.`,
    input: z.object({
      command: z.string().min(1).max(10_000).describe('Shell command, run with sh -c.'),
      cwd: z.string().min(1).max(1024).default('.').describe('Working directory relative to the workspace root.'),
      timeout_seconds: z.number().int().min(1).max(600).default(60).describe('The command is killed after this many seconds.'),
    }),
    capability: 'exec',
    idempotent: false,
    targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.cwd)],
    // Longer than the largest command timeout so the sandbox, not the executor, ends slow commands.
    timeoutMs: 610_000,
    maxOutputChars: 30_000,
    async run(input, ctx) {
      if (realpathSync(ctx.workspace) !== sandbox.workspace) {
        throw new GarnetError('internal', 'The command sandbox is bound to a different workspace than this session.');
      }
      await ensureReady();
      const result = await sandbox.run({ command: input.command, cwd: input.cwd, timeoutMs: input.timeout_seconds * 1000, signal: ctx.signal });
      return {
        content: formatResult(result, input.timeout_seconds, sandbox.isolated),
        // With network access a command can fetch web pages (curl, npm, clone), so its output is as untrusted as web_fetch.
        ...(sandbox.networked ? { untrusted: { source: 'command with network access' } } : {}),
        // A non-zero exit is an ordinary result (its code is the first line); a timeout is not.
        ...(result.timedOut ? { error: 'timeout' as const } : result.cancelled ? { error: 'cancelled' as const } : {}),
        data: { exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, truncated: result.truncated },
      };
    },
  };
}

export function formatResult(r: RunResult, timeoutSeconds: number, isolated: boolean): string {
  const lines = [`exit code ${r.exitCode ?? 'none (killed)'}`];
  if (!isolated) lines.push('[ran on the host: not sandboxed]');
  if (r.timedOut) lines.push(`[timed out after ${timeoutSeconds}s; the command was killed]`);
  if (r.cancelled) lines.push('[cancelled; the command was killed]');
  if (r.truncated) lines.push('[output was very large; only the beginning of each stream was kept]');
  lines.push('--- stdout ---', r.stdout.length ? r.stdout.replace(/\n$/, '') : '(empty)');
  lines.push('--- stderr ---', r.stderr.length ? r.stderr.replace(/\n$/, '') : '(empty)');
  return lines.join('\n');
}
