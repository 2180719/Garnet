// Input history persisted per RUBY_HOME as JSON lines (entries can span lines).

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

export const HISTORY_LIMIT = 1000;

export class InputHistory {
  readonly entries: string[];
  private readonly path: string | null;

  constructor(path: string | null) {
    this.path = path;
    this.entries = path ? load(path) : [];
  }

  /**
   * Adds an entry. Entries starting with a space are not saved (like a shell's
   * ignorespace), and repeating the previous entry is not recorded twice.
   */
  add(entry: string): void {
    if (!entry.trim() || entry.startsWith(' ') || this.entries.at(-1) === entry) return;
    this.entries.push(entry);
    if (!this.path) return;
    try {
      if (this.entries.length > HISTORY_LIMIT * 1.2) {
        this.entries.splice(0, this.entries.length - HISTORY_LIMIT);
        writeFileSync(this.path, this.entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
      } else {
        const fresh = !existsSync(this.path);
        appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
        if (fresh) chmodSync(this.path, 0o600);
      }
    } catch {
      // History is a convenience; never fail a chat because it cannot be saved.
    }
  }
}

function load(path: string): string[] {
  try {
    const out: string[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (typeof v === 'string') out.push(v);
      } catch {
        // Skip a damaged line.
      }
    }
    return out.slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}
