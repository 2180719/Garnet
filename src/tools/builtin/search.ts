import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createContext, Script } from 'node:vm';
import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';
import { resolveInWorkspace } from '../../policy/index.ts';
import { realInWorkspace } from './files.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 1000;
/** Longest one file's matching may run. A regex with catastrophic backtracking is cut off here instead of freezing the process. */
const MATCH_TIMEOUT_MS = 1000;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MATCHER = new Script('(() => { const hits = []; for (let i = 0; i < lines.length; i++) if (re.test(lines[i].slice(0, max))) hits.push(i); return hits; })()');

/**
 * Indexes of the lines `re` matches. Runs in a throwaway `vm` context with a timeout, because a V8 regex cannot be
 * interrupted from JavaScript and a pattern like `^(a+)+$` would otherwise block the whole service. One call per
 * file (a call costs about 0.1 ms), so the timeout bounds each file, not each line.
 */
export function matchLines(re: RegExp, lines: readonly string[]): number[] {
  const context = createContext({ re: new RegExp(re.source, re.flags), lines, max: MAX_LINE_CHARS });
  try {
    return MATCHER.runInContext(context, { timeout: MATCH_TIMEOUT_MS }) as number[];
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new GarnetError('invalid_input', `The pattern took too long to match (over ${MATCH_TIMEOUT_MS} ms on one file). Use a simpler pattern without nested repetition such as (a+)+.`);
    }
    throw e;
  }
}
const MAX_FILES_SCANNED = 5000;

/** `**` crosses directories, `*` and `?` do not; everything else is literal. Matches against the path relative to the search root. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A glob without a slash matches names at any depth, like `*.ts`.
  return new RegExp(glob.includes('/') ? `^${re}$` : `^(?:.*/)?${re}$`);
}

type SearchInput = { pattern?: string; glob?: string; path: string; ignore_case: boolean; max_results: number };

/** `search_files`: regex search over file contents and/or a glob over file names, inside the workspace. */
export const searchFilesTool: ToolDefinition<SearchInput> = {
  name: 'search_files',
  version: 1,
  description: 'Search the workspace. With pattern: regex over file contents (matching lines as path:line: text). With only glob: file names. glob narrows either (e.g. "**/*.ts"). Skips .git, node_modules and binary files.',
  input: z.object({
    pattern: z.string().min(1).max(500).optional().describe('JavaScript regular expression to look for inside files.'),
    glob: z.string().min(1).max(200).optional().describe('Only files whose path matches, e.g. "*.md" or "src/**/*.ts".'),
    path: z.string().min(1).max(1024).default('.').describe('Directory to search, relative to the workspace root.'),
    ignore_case: z.boolean().default(false),
    max_results: z.number().int().min(1).max(500).default(100),
  }),
  capability: 'fs.read',
  idempotent: true,
  targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
  maxOutputChars: 20_000,
  async run({ pattern, glob, path, ignore_case, max_results }, ctx) {
    if (!pattern && !glob) throw new GarnetError('invalid_input', 'Give a pattern (search contents), a glob (find file names), or both.');
    let regex: RegExp | null = null;
    if (pattern) {
      try {
        regex = new RegExp(pattern, ignore_case ? 'i' : '');
      } catch (e) {
        throw new GarnetError('invalid_input', `pattern is not a valid regular expression: ${(e as Error).message}`);
      }
    }
    const globRe = glob ? globToRegExp(glob) : null;
    const root = await realInWorkspace(ctx.workspace, path);
    const rootInfo = await lstat(root).catch(() => null);
    if (!rootInfo?.isDirectory()) throw new GarnetError('invalid_input', `"${path}" is not a directory in the workspace.`);
    const base = resolveInWorkspace(ctx.workspace, '.');

    const out: string[] = [];
    let scanned = 0;
    let stopped = '';
    const full = () => out.length >= max_results;

    const scanFile = async (file: string): Promise<void> => {
      // O_NOFOLLOW and fstat on the open handle: a file swapped for a symlink after the directory walk is not read.
      const handle = await open(file, constants.O_RDONLY | O_NOFOLLOW).catch(() => null);
      if (!handle) return;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
        const text = await handle.readFile('utf8');
        if (text.includes('\u0000')) return; // binary
        const lines = text.split(/\r?\n/);
        for (const i of matchLines(regex!, lines)) {
          out.push(`${relative(base, file)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
          if (full()) return;
        }
      } finally {
        await handle.close();
      }
    };

    const walk = async (dir: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (full() || stopped) return;
        ctx.signal.throwIfAborted();
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(abs);
          continue;
        }
        if (!e.isFile()) continue; // symlinks and specials are never followed
        const rel = relative(root, abs);
        if (globRe && !globRe.test(rel)) continue;
        if (++scanned > MAX_FILES_SCANNED) {
          stopped = `[stopped after scanning ${MAX_FILES_SCANNED} files; narrow path or glob]`;
          return;
        }
        if (regex) await scanFile(abs);
        else out.push(relative(base, abs));
      }
    };
    await walk(root);

    if (out.length === 0) return { content: stopped || 'No matches.' };
    if (full()) out.push(`[showing the first ${max_results}; narrow the search for more]`);
    if (stopped) out.push(stopped);
    return { content: out.join('\n') };
  },
};
