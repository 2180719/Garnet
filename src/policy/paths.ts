import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { RubyError } from '../contracts/index.ts';

/**
 * Resolves `path` against `workspace` and guarantees the result stays inside
 * it, following symlinks for the longest existing prefix. Throws `denied`
 * otherwise. A workspace is a scope, not a security sandbox.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  const root = realpathSync(workspace);
  const target = resolve(root, path);
  const real = realExistingPrefix(target);
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new RubyError('denied', `Path "${path}" is outside the workspace. Use a path relative to the workspace root.`);
  }
  return target;
}

function realExistingPrefix(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}
