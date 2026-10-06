// Read-only filesystem helpers that never leave the source tree and never read huge files.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const MAX_FILE_BYTES = 1024 * 1024;

export type Scanner = {
  /** Real path of the source root. */
  readonly root: string;
  /** Human-readable problems met while scanning (symlink escapes, oversize files). */
  readonly warnings: string[];
  readText(path: string): string | null;
  readBuffer(path: string): Buffer | null;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  /** Sorted directory entries (names only); entries whose real path leaves the root are dropped with a warning. */
  list(dir: string): { name: string; dir: boolean }[];
  rel(path: string): string;
};

export function makeScanner(rootDir: string): Scanner {
  const root = realpathSync(rootDir);
  const warnings: string[] = [];
  const rel = (p: string) => relative(root, p).split(sep).join('/');

  /** Real path when it stays inside the root, else null (with a warning). */
  const inside = (path: string): string | null => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return null;
    }
    if (real !== root && !real.startsWith(root + sep)) {
      warnings.push(`Skipped ${rel(path)}: it is a symlink that points outside the source directory.`);
      return null;
    }
    return real;
  };

  const readBuffer = (path: string): Buffer | null => {
    const real = inside(path);
    if (!real) return null;
    try {
      const st = statSync(real);
      if (!st.isFile()) return null;
      if (st.size > MAX_FILE_BYTES) {
        warnings.push(`Skipped ${rel(path)}: ${Math.round(st.size / 1024)} KB is over the 1 MB limit.`);
        return null;
      }
      return readFileSync(real);
    } catch {
      return null;
    }
  };

  return {
    root,
    warnings,
    readBuffer,
    readText(path) {
      const b = readBuffer(path);
      if (!b) return null;
      if (b.includes(0)) {
        warnings.push(`Skipped ${rel(path)}: it looks binary.`);
        return null;
      }
      return b.toString('utf8').replace(/^﻿/, '');
    },
    exists(path) {
      try {
        lstatSync(path);
      } catch {
        return false;
      }
      return inside(path) !== null;
    },
    isDir(path) {
      const real = inside(path);
      if (!real) return false;
      try {
        return statSync(real).isDirectory();
      } catch {
        return false;
      }
    },
    list(dir) {
      const real = inside(dir);
      if (!real) return [];
      let names: string[];
      try {
        names = readdirSync(real).sort();
      } catch {
        return [];
      }
      const out: { name: string; dir: boolean }[] = [];
      for (const name of names) {
        const p = join(dir, name);
        const r = inside(p);
        if (!r) continue;
        try {
          out.push({ name, dir: statSync(r).isDirectory() });
        } catch {
          /* vanished */
        }
      }
      return out;
    },
    rel,
  };
}
