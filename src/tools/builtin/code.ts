import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';
import type { Sandbox } from '../../sandbox/index.ts';
import { formatResult, sandboxReady } from './exec.ts';

const INTERPRETERS = { python: 'python3 -', node: 'node -', sh: 'sh -s' } as const;

type CodeInput = { language: keyof typeof INTERPRETERS; code: string; timeout_seconds: number };

/**
 * `execute_code`: runs a short script in the command sandbox, fed to the interpreter on stdin (so nothing is written
 * to the workspace and quoting never matters). It is `run_command` with a friendlier shape for calculations, data
 * wrangling and parsing, and has the same capability (`exec`), sandbox, limits and untrusted-output rule.
 */
export function executeCodeTool(sandbox: Sandbox): ToolDefinition<CodeInput> {
  const ensureReady = sandboxReady(sandbox);
  const where = sandbox.isolated ? 'in the isolated sandbox, with the workspace at /workspace' : sandbox.kind === 'ssh' ? 'on the remote host' : 'on the host (not isolated)';
  return {
    name: 'execute_code',
    version: 1,
    description: `Run a short script ${where} and return its output (exit code, stdout, stderr). Print what you need to see. Use it for calculations, parsing and data work. Needs the interpreter to exist in the sandbox: if it does not, the error says so; use language "sh" or tell the owner.`,
    input: z.object({
      language: z.enum(['python', 'node', 'sh']).describe('python runs python3, node runs node, sh runs sh.'),
      code: z.string().min(1).max(100_000).describe('The whole script.'),
      timeout_seconds: z.number().int().min(1).max(300).default(30).describe('The script is killed after this many seconds.'),
    }),
    capability: 'exec',
    idempotent: false,
    summarize: (i) => `Run ${i.language} code (${i.code.length} chars, ${i.timeout_seconds}s limit):\n${i.code}`,
    timeoutMs: 310_000,
    maxOutputChars: 30_000,
    async run(input, ctx) {
      if (realpathSync(ctx.workspace) !== sandbox.workspace) {
        throw new GarnetError('internal', 'The command sandbox is bound to a different workspace than this session.');
      }
      await ensureReady();
      const result = await sandbox.run({ command: INTERPRETERS[input.language], cwd: '.', timeoutMs: input.timeout_seconds * 1000, signal: ctx.signal, stdin: input.code });
      const missing = result.exitCode === 127 && /not found/i.test(result.stderr);
      return {
        content: formatResult(result, input.timeout_seconds, sandbox.isolated) + (missing ? `\n[${input.language} is not installed in the sandbox. Use language "sh", or the owner can set sandbox.docker.image to an image that has it.]` : ''),
        ...(sandbox.networked ? { untrusted: { source: 'command with network access' } } : {}),
        ...(result.timedOut ? { error: 'timeout' as const } : result.cancelled ? { error: 'cancelled' as const } : {}),
        data: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
  };
}
