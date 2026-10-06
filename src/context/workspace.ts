import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

/** Most characters of the workspace AGENTS.md that go into the prompt. */
export const MAX_PROJECT_INSTRUCTIONS = 8000;

/**
 * The workspace's `AGENTS.md` (name matched case-insensitively; `CLAUDE.md` is not read) as a labelled
 * prompt section, or '' when there is none. It is owner-provided project guidance, not untrusted data.
 * Truncated at MAX_PROJECT_INSTRUCTIONS with a note. Read when a session's prompt is frozen, so edits
 * take effect on `/new`. Only a regular file in the workspace root is used (never a symlink).
 */
export function projectInstructionsSection(workspace: string): string {
  let text: string;
  try {
    const entry = readdirSync(workspace, { withFileTypes: true }).find((e) => e.name.toLowerCase() === 'agents.md' && e.isFile());
    if (!entry) return '';
    const fd = openSync(join(workspace, entry.name), 'r');
    try {
      if (!fstatSync(fd).isFile()) return '';
      // 4 bytes per char covers UTF-8 in the worst case; never read a huge file whole.
      const buf = Buffer.alloc(MAX_PROJECT_INSTRUCTIONS * 4 + 4);
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
  text = text.trim();
  if (!text) return '';
  const body =
    text.length > MAX_PROJECT_INSTRUCTIONS
      ? `${text.slice(0, MAX_PROJECT_INSTRUCTIONS)}\n[Truncated: AGENTS.md is longer than ${MAX_PROJECT_INSTRUCTIONS} characters; read the rest with read_file.]`
      : text;
  return `# Project instructions (workspace AGENTS.md, written by your owner)\n${body}`;
}
