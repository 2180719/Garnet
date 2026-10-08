import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';
import { resolveInWorkspace } from '../../policy/index.ts';
import { realInWorkspace } from './files.ts';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_FILE_BYTES = 1_000_000;

const editSchema = z.object({
  old_string: z.string().min(1).max(200_000).describe('Exact text to replace, including whitespace. Must match once unless replace_all is true.'),
  new_string: z.string().max(200_000).describe('Replacement text (may be empty to delete).'),
  replace_all: z.boolean().default(false).describe('Replace every occurrence instead of requiring a unique match.'),
});

type EditInput = { path: string; edits: z.infer<typeof editSchema>[] };

/** Applies edits in order to `text`. Pure so it is easy to test; throws a correctable `invalid_input` on any miss. */
export function applyEdits(text: string, edits: readonly z.infer<typeof editSchema>[]): { text: string; replaced: number } {
  let out = text;
  let replaced = 0;
  edits.forEach((e, i) => {
    const label = edits.length > 1 ? `Edit ${i + 1}: ` : '';
    if (e.old_string === e.new_string) throw new GarnetError('invalid_input', `${label}old_string and new_string are identical.`);
    const count = out.split(e.old_string).length - 1;
    if (count === 0) throw new GarnetError('invalid_input', `${label}old_string was not found. Read the file again and copy the text exactly, including indentation.`);
    if (count > 1 && !e.replace_all) {
      throw new GarnetError('invalid_input', `${label}old_string matches ${count} places. Add surrounding lines to make it unique, or set replace_all=true.`);
    }
    // split/join, not String.replace, so `$&` and friends in new_string stay literal.
    out = out.split(e.old_string).join(e.new_string);
    replaced += count;
  });
  return { text: out, replaced };
}

/**
 * `edit_file`: exact-string replacement in an existing workspace file. Cheaper and safer than rewriting the whole
 * file with `write_file`: nothing outside the matched text can change. Several edits to one file apply together or
 * not at all.
 */
export const editFileTool: ToolDefinition<EditInput> = {
  name: 'edit_file',
  version: 1,
  description: 'Edit an existing workspace file by replacing exact text. Prefer this to write_file for changes. Give one edit, or several in order (all applied or none).',
  input: z.object({
    path: z.string().min(1).max(1024).describe('Path relative to the workspace root.'),
    edits: z.array(editSchema).min(1).max(50).describe('Replacements applied in order.'),
  }),
  capability: 'fs.write',
  idempotent: false, // a second run finds nothing to replace and fails, which is safe
  targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
  summarize: (i) => `Edit ${i.path}: ${i.edits.length} replacement(s)\n${i.edits.map((e) => `- ${JSON.stringify(e.old_string.slice(0, 200))} -> ${JSON.stringify(e.new_string.slice(0, 200))}${e.replace_all ? ' (all)' : ''}`).join('\n')}`,
  async run({ path, edits }, ctx) {
    // The final component is checked before resolving: realpath would follow a symlink and hide it.
    const logical = resolveInWorkspace(ctx.workspace, path);
    if ((await lstat(logical).catch(() => null))?.isSymbolicLink()) throw new GarnetError('denied', `"${path}" is a symlink; edit_file does not write through symlinks.`);
    const file = await realInWorkspace(ctx.workspace, path);
    const info = await lstat(file).catch(() => null);
    if (!info) throw new GarnetError('invalid_input', `File "${path}" does not exist. Use write_file to create it.`);
    if (info.isDirectory()) throw new GarnetError('invalid_input', `"${path}" is a directory.`);
    if (info.size > MAX_FILE_BYTES) throw new GarnetError('invalid_input', `"${path}" is larger than ${MAX_FILE_BYTES} bytes; edit_file will not load it.`);
    const handle = await open(file, constants.O_RDWR | O_NOFOLLOW);
    try {
      const before = await handle.readFile('utf8');
      if (before.includes('\u0000')) throw new GarnetError('invalid_input', `"${path}" looks like a binary file.`);
      const { text, replaced } = applyEdits(before, edits);
      await handle.truncate(0);
      await handle.write(text, 0, 'utf8');
      return { content: `Edited ${path}: ${replaced} replacement(s).` };
    } finally {
      await handle.close();
    }
  },
};
