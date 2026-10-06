import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RubyError } from '../contracts/index.ts';

export type MemoryFile = 'memory' | 'user';
export type MemoryWriteResult = { content: string; used: number; limit: number };
export type MemoryVersion = { id: string; at: string; chars: number };

export const DEFAULT_LIMITS = { memory: 2200, user: 1400 };
export const MAX_ENTRY_CHARS = 500;

const FILE_NAMES: Record<MemoryFile, string> = { memory: 'MEMORY.md', user: 'USER.md' };
const NAMESPACE = /^[a-z0-9-]{1,40}$/;
const VERSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/;

/**
 * Injection heuristic (deliberately small, not a security boundary): entries are replayed into the
 * system prompt of future sessions, so reject text that tries to impersonate system/markup structure
 * or to override instructions. Documented patterns: an opening "<system" tag, any closing tag "</",
 * and "ignore previous/prior/above instructions" (case-insensitive).
 */
const INJECTION_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /<\s*system/i, why: 'contains a "<system" tag' },
  { re: /<\//, why: 'contains a closing tag ("</")' },
  { re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, why: 'tries to override instructions' },
];

/** Why `text` trips the injection heuristic, or null. Shared by everything that replays text into prompts (skills, the importer). */
export function injectionReason(text: string): string | null {
  return INJECTION_PATTERNS.find(({ re }) => re.test(text))?.why ?? null;
}

export function isMemoryFile(x: unknown): x is MemoryFile {
  return x === 'memory' || x === 'user';
}

export class MemoryStore {
  readonly #root: string;
  readonly #limits: { memory: number; user: number };
  readonly #historyLimit: number;
  readonly #now: () => Date;

  constructor(opts: { root: string; limits?: { memory: number; user: number }; historyLimit?: number; now?: () => Date }) {
    this.#root = opts.root;
    this.#limits = opts.limits ?? DEFAULT_LIMITS;
    this.#historyLimit = opts.historyLimit ?? 50;
    this.#now = opts.now ?? (() => new Date());
  }

  limit(file: MemoryFile): number {
    return this.#limits[file];
  }

  fileName(file: MemoryFile): string {
    return FILE_NAMES[file];
  }

  read(ns: string, file: MemoryFile): string {
    const path = this.#path(ns, file);
    try {
      return readFileSync(path, 'utf8').replace(/\s+$/, '');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  /** Prompt section. Deterministic for identical file contents; contains no timestamps. */
  snapshot(ns: string): string {
    const mem = this.read(ns, 'memory');
    const usr = this.read(ns, 'user');
    if (!mem && !usr) return 'Memory is empty: nothing has been saved yet.';
    const section = (title: string, name: string, text: string, limit: number) =>
      `## ${title} (${name}, ${text.length}/${limit} chars)\n${text || '(empty)'}`;
    return [
      section('Your notes', 'MEMORY.md', mem, this.#limits.memory),
      section('About your owner', 'USER.md', usr, this.#limits.user),
    ].join('\n\n');
  }

  add(ns: string, file: MemoryFile, text: string): MemoryWriteResult {
    const entry = this.#sanitize(text);
    const lines = this.#lines(ns, file);
    if (lines.some((l) => l === entry)) {
      throw new RubyError('invalid_input', `That entry already exists in ${FILE_NAMES[file]}. Do not add duplicates.`);
    }
    return this.#commit(ns, file, [...lines, entry]);
  }

  replace(ns: string, file: MemoryFile, oldText: string, newText: string): MemoryWriteResult {
    const entry = this.#sanitize(newText);
    const lines = this.#lines(ns, file);
    const idx = this.#match(lines, oldText, file);
    if (lines.some((l, i) => i !== idx && l === entry)) {
      throw new RubyError('invalid_input', `That entry already exists in ${FILE_NAMES[file]}. Do not add duplicates.`);
    }
    const next = [...lines];
    next[idx] = entry;
    return this.#commit(ns, file, next);
  }

  remove(ns: string, file: MemoryFile, oldText: string): MemoryWriteResult {
    const lines = this.#lines(ns, file);
    const idx = this.#match(lines, oldText, file);
    return this.#commit(
      ns,
      file,
      lines.filter((_, i) => i !== idx),
    );
  }

  /** Owner edit of the whole file. Validates the cap; versions the previous content first. */
  write(ns: string, file: MemoryFile, content: string): MemoryWriteResult {
    const lines = content
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => stripControl(l).replace(/\s+$/, ''))
      .filter((l) => l.trim() !== '');
    return this.#commit(ns, file, lines);
  }

  /** Saved versions of a file, newest first. */
  history(ns: string, file: MemoryFile): MemoryVersion[] {
    return this.#versionIds(ns, file)
      .reverse()
      .map((id) => ({
        id,
        at: id.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3'),
        chars: this.#readVersion(ns, file, id).replace(/\s+$/, '').length,
      }));
  }

  /** Restore a saved version. The current content is versioned first, so rollback is itself undoable. */
  rollback(ns: string, file: MemoryFile, id: string): MemoryWriteResult {
    if (!VERSION_ID.test(id)) throw new RubyError('invalid_input', `"${id}" is not a valid version id. Use history() to list them.`);
    if (!this.#versionIds(ns, file).includes(id)) {
      throw new RubyError('invalid_input', `No version "${id}" for ${FILE_NAMES[file]}. Use history() to list them.`);
    }
    return this.write(ns, file, this.#readVersion(ns, file, id));
  }

  // --- internals ---

  #dir(ns: string): string {
    if (typeof ns !== 'string' || !NAMESPACE.test(ns)) {
      throw new RubyError('invalid_input', `Invalid memory namespace "${String(ns)}": use 1-40 chars of a-z, 0-9 and "-".`);
    }
    return join(this.#root, ns);
  }

  #path(ns: string, file: MemoryFile): string {
    if (!isMemoryFile(file)) throw new RubyError('invalid_input', `Unknown memory file "${String(file)}": use "memory" or "user".`);
    return join(this.#dir(ns), FILE_NAMES[file]);
  }

  #lines(ns: string, file: MemoryFile): string[] {
    return this.read(ns, file)
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l !== '');
  }

  #sanitize(text: string): string {
    const one = stripControl(String(text).replace(/\s+/g, ' ')).trim().replace(/^-\s+/, '');
    if (!one) throw new RubyError('invalid_input', 'Entry text is empty.');
    if (one.length > MAX_ENTRY_CHARS) {
      throw new RubyError(
        'invalid_input',
        `Entry is ${one.length} chars; the maximum is ${MAX_ENTRY_CHARS}. Shorten it to the durable fact.`,
      );
    }
    const why = injectionReason(one);
    if (why) throw new RubyError('invalid_input', `Entry rejected: it ${why}. Memory holds plain facts, not instructions to the system.`);
    return `- ${one}`;
  }

  /** Index of the single entry containing oldText; throws with candidates otherwise. */
  #match(lines: string[], oldText: string, file: MemoryFile): number {
    const needle = stripControl(String(oldText).replace(/\s+/g, ' ')).trim();
    if (!needle) throw new RubyError('invalid_input', 'old_text is empty.');
    const hits: number[] = [];
    lines.forEach((l, i) => {
      if (l.startsWith('- ') && l.includes(needle)) hits.push(i);
    });
    if (hits.length === 1) return hits[0]!;
    const show = (idxs: number[]) => idxs.slice(0, 5).map((i) => `  ${preview(lines[i]!)}`).join('\n');
    if (hits.length > 1) {
      throw new RubyError(
        'invalid_input',
        `old_text matches ${hits.length} entries in ${FILE_NAMES[file]}; use a longer, unique substring:\n${show(hits)}`,
      );
    }
    const words = needle.toLowerCase().split(' ').filter((w) => w.length >= 4);
    const near = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('- ') && words.some((w) => l.toLowerCase().includes(w)))
      .map(({ i }) => i);
    throw new RubyError(
      'invalid_input',
      near.length
        ? `old_text matches no entry in ${FILE_NAMES[file]}. Near matches:\n${show(near)}`
        : `old_text matches no entry in ${FILE_NAMES[file]}.`,
    );
  }

  #commit(ns: string, file: MemoryFile, lines: string[]): MemoryWriteResult {
    const content = lines.join('\n');
    const limit = this.#limits[file];
    if (content.length > limit) {
      const over = content.length - limit;
      throw new RubyError(
        'invalid_input',
        `${FILE_NAMES[file]} would be ${content.length}/${limit} chars (${over} over the limit). ` +
          `Consolidate or replace existing entries first (use replace or remove), then retry.`,
      );
    }
    const dir = this.#dir(ns);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = this.#path(ns, file);
    this.#version(ns, file);
    atomicWrite(path, content ? `${content}\n` : '');
    return { content, used: content.length, limit };
  }

  #historyDir(ns: string): string {
    return join(this.#dir(ns), '.history');
  }

  #versionPrefix(file: MemoryFile): string {
    return `${FILE_NAMES[file]}.`;
  }

  #versionIds(ns: string, file: MemoryFile): string[] {
    const prefix = this.#versionPrefix(file);
    let names: string[];
    try {
      names = readdirSync(this.#historyDir(ns));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith(prefix) && n.endsWith('.md'))
      .map((n) => n.slice(prefix.length, -3))
      .filter((id) => VERSION_ID.test(id))
      .sort();
  }

  #readVersion(ns: string, file: MemoryFile, id: string): string {
    return readFileSync(join(this.#historyDir(ns), `${this.#versionPrefix(file)}${id}.md`), 'utf8');
  }

  #version(ns: string, file: MemoryFile): void {
    const path = this.#path(ns, file);
    if (!existsSync(path)) return;
    const hdir = this.#historyDir(ns);
    mkdirSync(hdir, { recursive: true, mode: 0o700 });
    const existing = new Set(this.#versionIds(ns, file));
    let t = this.#now().getTime();
    let id = stamp(t);
    while (existing.has(id)) id = stamp(++t); // same-millisecond writes get distinct, ordered ids
    atomicWrite(join(hdir, `${this.#versionPrefix(file)}${id}.md`), readFileSync(path, 'utf8'));
    const ids = [...existing, id].sort();
    for (const old of ids.slice(0, Math.max(0, ids.length - this.#historyLimit))) {
      rmSync(join(hdir, `${this.#versionPrefix(file)}${old}.md`), { force: true });
    }
  }
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, '-');
}

function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

function preview(line: string): string {
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
