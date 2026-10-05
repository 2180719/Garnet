import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { RubyError, type ToolDefinition } from '../../contracts/index.ts';
import { resolveInWorkspace } from '../../policy/index.ts';

const relPath = z.string().min(1).max(1024).describe('Path relative to the workspace root.');

export const listFiles: ToolDefinition<{ path: string; depth: number }> = {
  name: 'list_files',
  version: 1,
  description: 'List files and directories in the workspace. Directories end with "/".',
  input: z.object({
    path: relPath.default('.'),
    depth: z.number().int().min(1).max(5).default(2).describe('How many directory levels to descend.'),
  }),
  capability: 'fs.read',
  idempotent: true,
  targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
  maxOutputChars: 10_000,
  async run({ path, depth }, ctx) {
    const root = resolveInWorkspace(ctx.workspace, path);
    const lines: string[] = [];
    const LIMIT = 500;
    const walk = async (dir: string, level: number): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= LIMIT) return;
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const rel = relative(ctx.workspace, join(dir, e.name));
        lines.push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory() && level < depth) await walk(join(dir, e.name), level + 1);
      }
    };
    await walk(root, 1);
    if (lines.length === 0) return { content: '(empty)' };
    if (lines.length >= LIMIT) lines.push(`[stopped after ${LIMIT} entries; list a subdirectory for more]`);
    return { content: lines.join('\n') };
  },
};

export const readFileTool: ToolDefinition<{ path: string; offset: number; limit: number }> = {
  name: 'read_file',
  version: 1,
  description: 'Read a text file from the workspace. Returns numbered lines; use offset/limit for large files.',
  input: z.object({
    path: relPath,
    offset: z.number().int().min(1).default(1).describe('First line to return (1-based).'),
    limit: z.number().int().min(1).max(2000).default(400).describe('Maximum lines to return.'),
  }),
  capability: 'fs.read',
  idempotent: true,
  targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
  maxOutputChars: 40_000,
  async run({ path, offset, limit }, ctx) {
    const file = resolveInWorkspace(ctx.workspace, path);
    const info = await stat(file).catch(() => null);
    if (!info) throw new RubyError('invalid_input', `File "${path}" does not exist. Use list_files to find it.`);
    if (info.isDirectory()) throw new RubyError('invalid_input', `"${path}" is a directory. Use list_files instead.`);
    const text = await readFile(file, 'utf8');
    if (text.includes('\u0000')) throw new RubyError('invalid_input', `"${path}" looks like a binary file.`);
    const all = text.split('\n');
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${String(offset + i).padStart(5)}  ${l}`).join('\n');
    const end = offset - 1 + slice.length;
    const footer = end < all.length ? `\n[lines ${offset}-${end} of ${all.length}; use offset=${end + 1} for more]` : '';
    return { content: body + footer };
  },
};

export const writeFileTool: ToolDefinition<{ path: string; content: string; overwrite: boolean }> = {
  name: 'write_file',
  version: 1,
  description: 'Create or replace a text file in the workspace. Parent directories are created as needed.',
  input: z.object({
    path: relPath,
    content: z.string().max(1_000_000),
    overwrite: z.boolean().default(false).describe('Must be true to replace an existing file.'),
  }),
  capability: 'fs.write',
  idempotent: true, // same content to same path has the same effect
  targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
  async run({ path, content, overwrite }, ctx) {
    const file = resolveInWorkspace(ctx.workspace, path);
    const existing = await stat(file).catch(() => null);
    if (existing?.isDirectory()) throw new RubyError('invalid_input', `"${path}" is a directory.`);
    if (existing && !overwrite) {
      throw new RubyError('invalid_input', `"${path}" already exists. Set overwrite=true to replace it.`);
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return { content: `${existing ? 'Replaced' : 'Created'} ${path} (${Buffer.byteLength(content)} bytes).` };
  },
};

export const fileTools = [listFiles, readFileTool, writeFileTool];
