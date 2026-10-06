import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GarnetError } from '../contracts/index.ts';

/**
 * Resolves `path` against `workspace` and guarantees the result stays inside
 * it, following symlinks for the longest existing prefix. Throws `denied`
 * otherwise, including for a dangling symlink (its target cannot be shown to
 * stay inside). Paths that cannot be resolved for any reason other than "does
 * not exist yet" (ELOOP, EACCES, ENOTDIR, ...) are rejected, never treated as
 * missing. A workspace is a scope, not a security sandbox: callers that write
 * must still re-check at write time and refuse to follow a final symlink.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  const real = realExistingPrefix(target, path);
  if (!isInside(root, real)) {
    throw new GarnetError('denied', `Path "${path}" is outside the workspace. Use a path relative to the workspace root.`);
  }
  return target;
}

function isInside(root: string, real: string): boolean {
  const rel = relative(root, real);
  return !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel));
}

function realExistingPrefix(path: string, shown: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...rest.reverse());
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') throw unresolvable(shown, e);
    }
    // realpath says ENOENT. If the entry itself exists, it is a symlink whose
    // target does not: writing through it would land wherever it points.
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new GarnetError('denied', `Path "${shown}" goes through a symlink whose target does not exist; refusing to follow it.`);
      }
      throw unresolvable(shown, new Error('exists but cannot be resolved'));
    } catch (e) {
      if (e instanceof GarnetError) throw e;
      if (errorCode(e) !== 'ENOENT') throw unresolvable(shown, e);
    }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
}

function unresolvable(shown: string, e: unknown): GarnetError {
  const code = errorCode(e) ?? (e instanceof Error ? e.message : String(e));
  return new GarnetError(code === 'ENOTDIR' ? 'invalid_input' : 'denied', `Path "${shown}" cannot be resolved safely (${code}).`);
}

function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}
