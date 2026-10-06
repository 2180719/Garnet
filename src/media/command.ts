// Runs an owner-configured local command (whisper, pdftotext) on a stored file.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RubyError, errorMessage } from '../contracts/index.ts';
import { extensionFor } from './mime.ts';

export type CommandSpec = {
  /** argv; `{input}` is replaced by the path of a temporary copy of the file. No shell is involved. */
  argv: string[];
  timeoutMs: number;
  /** Largest stdout accepted. */
  maxOutputBytes?: number;
};

/**
 * Writes the bytes to a private temporary file (with an extension that
 * matches the type, which tools like ffmpeg rely on), runs the command
 * without a shell and with a minimal environment (no API keys or tokens
 * from Ruby's environment), and returns stdout. The temporary directory is
 * always removed.
 */
export async function runOnFile(spec: CommandSpec, data: Uint8Array, mimeType: string, signal: AbortSignal): Promise<string> {
  if (spec.argv.length === 0) throw new RubyError('config', 'The media command is empty.');
  const dir = await mkdtemp(join(tmpdir(), 'ruby-media-'));
  try {
    const input = join(dir, `input${extensionFor(mimeType)}`);
    await writeFile(input, data, { mode: 0o600 });
    const argv = spec.argv.map((a) => a.replaceAll('{input}', input));
    if (!spec.argv.some((a) => a.includes('{input}'))) argv.push(input);
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[k] !== undefined) env[k] = process.env[k];
    return await new Promise<string>((resolve, reject) => {
      execFile(
        argv[0]!,
        argv.slice(1),
        { cwd: dir, env, timeout: spec.timeoutMs, maxBuffer: spec.maxOutputBytes ?? 4 * 1024 * 1024, signal, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === 'ENOENT') return reject(new RubyError('config', `Command not found: ${argv[0]}`));
          if (signal.aborted) return reject(new RubyError('cancelled', 'Cancelled.'));
          if (e.killed || e.signal === 'SIGTERM') return reject(new RubyError('timeout', `${argv[0]} did not finish within ${Math.round(spec.timeoutMs / 1000)}s.`));
          const detail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
          reject(new RubyError('tool_failed', `${argv[0]} failed${detail ? `: ${detail}` : `: ${errorMessage(error)}`}`));
        },
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
