// Minimal frontmatter parser/serializer for SKILL.md (no YAML dependency).
// Supports `key: value` lines with plain, "double" or 'single' quoted scalars.
// Unknown keys are kept verbatim (including indented continuation lines) so a
// rewrite never drops what the owner wrote.

export type Entry = { key: string; raw: string[]; value: string };
export type Parsed = { entries: Entry[]; body: string };

const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(.*)$/;

function scalar(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
  return t;
}

/** Returns the parsed file, or an error string. */
export function parseSkillFile(text: string): Parsed | string {
  const src = text.replace(/^﻿/, '').replaceAll('\r\n', '\n');
  if (!src.startsWith('---\n')) return 'missing frontmatter (file must start with "---")';
  const end = src.indexOf('\n---', 3);
  if (end < 0) return 'unterminated frontmatter (missing closing "---")';
  const after = src.slice(end + 4);
  if (after !== '' && !after.startsWith('\n')) return 'malformed closing "---" line';
  const lines = src.slice(4, end + 1).split('\n');
  lines.pop(); // trailing empty piece
  const entries: Entry[] = [];
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      entries.at(-1)?.raw.push(line);
      continue;
    }
    if (/^\s/.test(line)) {
      const last = entries.at(-1);
      if (!last) return `unexpected indented line: ${line.trim().slice(0, 40)}`;
      last.raw.push(line);
      continue;
    }
    const m = KEY.exec(line);
    if (!m) return `cannot parse frontmatter line: ${line.slice(0, 40)}`;
    entries.push({ key: m[1]!, raw: [line], value: scalar(m[2]!) });
  }
  return { entries, body: after.replace(/^\n/, '') };
}

export function serializeSkillFile(name: string, description: string, body: string, others: Entry[]): string {
  const head = [`name: ${name}`, `description: ${JSON.stringify(description)}`];
  for (const e of others) head.push(...e.raw);
  const b = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${head.join('\n')}\n---\n\n${b}`;
}
