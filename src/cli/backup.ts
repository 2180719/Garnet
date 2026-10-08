// `garnet backup` and `garnet restore`: a plain directory you can inspect, copy or archive.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseConfig, pathsFor } from '../config/index.ts';
import { createGarnet, VERSION } from '../main.ts';
import { isInside } from '../secrets/index.ts';
import { backupDb } from '../store/index.ts';
import type { Io } from './main.ts';

// Artifacts hold large tool outputs and media holds attachments (inbound files, pending outbox files) that session history and the outbox refer to by id or path.
const DIRS = ['memory', 'skills', 'artifacts', 'media', 'workspace'];

export function backup(args: string[], io: Io): number {
  const garnet = createGarnet({ noModel: true });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = resolve(args[0] ?? join(garnet.paths.home, 'backups', `garnet-${stamp}`));
    if (existsSync(target)) {
      io.err(`${target} already exists.\n`);
      return 1;
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    backupDb(garnet.db, join(target, 'garnet.db'));
    if (existsSync(garnet.paths.configFile)) cpSync(garnet.paths.configFile, join(target, 'config.json'));
    // The encrypted store is safe to copy; its passphrase or key file is not included.
    if (garnet.secrets.exists()) cpSync(garnet.secrets.file, join(target, 'secrets'));
    for (const dir of DIRS) {
      const from = dir === 'workspace' ? garnet.paths.workspace : join(garnet.paths.home, dir);
      if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true, verbatimSymlinks: true });
    }
    writeFileSync(join(target, 'BACKUP.json'), JSON.stringify({ version: VERSION, createdAt: new Date().toISOString() }, null, 2));
    const encrypted = garnet.secrets.exists() ? ' The encrypted secret store is included; its passphrase or key file is not.' : '';
    io.out(`Backed up to ${target}\nNot included: the env file with your secrets (${garnet.paths.home}/env). Keep a copy somewhere safe.${encrypted}\n`);
    return 0;
  } finally {
    garnet.close();
  }
}

/** Names under the home directory that a restore replaces, moved aside first. Both database names: the app opens garnet.db when present, so a leftover ruby.db must not linger beside a restored one. */
const HOME_ENTRIES = ['garnet.db', 'garnet.db-wal', 'garnet.db-shm', 'ruby.db', 'ruby.db-wal', 'ruby.db-shm', 'config.json', 'secrets', 'memory', 'skills', 'artifacts', 'media'];
/** Everything `backup` writes (plus the pre-rename ruby.db). Anything else in a backup directory is ignored, so a stray `env` file can never replace a live file that has no copy kept. */
const RESTORABLE = new Set(['garnet.db', 'ruby.db', 'config.json', 'secrets', 'memory', 'skills', 'artifacts', 'media', 'workspace']);

export type RestoreDeps = { rename: (from: string, to: string) => void };

/** True for anything on disk at `path`, including a dangling symlink (which existsSync reports as absent). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Copies `from` to `to` keeping symlinks as links. cpSync follows a top-level symlink, which fails when its relative target does not exist beside the backup. */
function copyVerbatim(from: string, to: string): void {
  if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * Moves a file or directory. Across filesystems rename fails with EXDEV, so copy and then remove.
 * `placed` runs once the destination is complete and before the source is removed, so a failed removal is still recorded and can be undone.
 * A mount point cannot be renamed (EBUSY) and is not copied around: such a workspace fails safely instead of being replaced.
 */
function move(from: string, to: string, deps: RestoreDeps, placed: () => void): void {
  try {
    deps.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    try {
      cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    } catch (copyError) {
      rmSync(to, { recursive: true, force: true });
      throw copyError;
    }
    placed();
    rmSync(from, { recursive: true, force: true });
    return;
  }
  placed();
}

/** The workspace directory the backup's own config names (relative paths resolve against `home`), or the default when the backup has no config. Throws when the config is unusable. */
function restoredWorkspace(from: string, home: string): string {
  const file = join(from, 'config.json');
  if (!existsSync(file)) return pathsFor(home, parseConfig({ version: 1 })).workspace;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return pathsFor(home, parseConfig(raw)).workspace;
}

/** Why a workspace cannot be swapped by a restore, or null. Checked before anything moves. */
function workspaceProblem(label: string, workspace: string, home: string): string | null {
  if (isInside(workspace, home)) return `${label} ${workspace} contains Garnet's home (${home})`;
  const entry = HOME_ENTRIES.find((n) => isInside(join(home, n), workspace));
  if (entry) return `${label} ${workspace} is inside ${join(home, entry)}, which a restore replaces`;
  return null;
}

export function restore(args: string[], io: Io): number {
  return restoreWith(args, io, { rename: renameSync });
}

export function restoreWith(args: string[], io: Io, deps: RestoreDeps): number {
  const from = args[0] && resolve(args[0]);
  // Backups made before the rename hold ruby.db.
  const dbFile = from ? ['garnet.db', 'ruby.db'].find((n) => existsSync(join(from, n))) : undefined;
  if (!from || !dbFile || !existsSync(join(from, 'BACKUP.json'))) {
    io.err('Usage: garnet restore <backup-dir>   (stop Garnet first; the current data is moved aside, not deleted)\n');
    return 2;
  }
  const garnet = createGarnet({ noModel: true });
  const home = garnet.paths.home;
  const currentWorkspace = garnet.paths.workspace;
  garnet.close();

  // Validate before touching anything live: the restored config decides where the workspace goes.
  let workspace: string;
  try {
    workspace = restoredWorkspace(from, home);
  } catch (e) {
    io.err(`The backup's config.json is not usable, so nothing was changed: ${(e as Error).message}\n`);
    return 1;
  }
  const problem =
    workspaceProblem('The restored workspace', workspace, home) ??
    workspaceProblem('The current workspace', currentWorkspace, home) ??
    (workspace !== currentWorkspace && (isInside(workspace, currentWorkspace) || isInside(currentWorkspace, workspace))
      ? `the current workspace (${currentWorkspace}) and the restored one (${workspace}) are nested`
      : null);
  if (problem) {
    io.err(`Nothing was changed: ${problem}.\n`);
    return 1;
  }
  const ignored = readdirSync(from).filter((n) => n !== 'BACKUP.json' && !RESTORABLE.has(n));
  if (ignored.length > 0) io.err(`Ignoring files in the backup that Garnet did not write: ${ignored.join(', ')}.\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = join(home, `pre-restore-${stamp}`);
  const staging = join(home, `.restore-staging-${stamp}`);
  // The workspace is staged beside its destination, so the final move is a same-filesystem rename even for an external location.
  const stagedWorkspace = `${workspace}.restore-staging-${stamp}`;
  const hasWorkspace = present(join(from, 'workspace'));
  // A workspace inside home is kept in the aside directory; an external one next to itself (same filesystem, no copying into home).
  const asideFor = (path: string, label: string) => (isInside(home, path) ? join(aside, label) : `${path}.pre-restore-${stamp}`);
  if (hasWorkspace && !isInside(home, workspace) && present(workspace)) {
    io.err(`The restored workspace ${workspace} is outside Garnet's home and already exists; it is kept as ${asideFor(workspace, '')}.\n`);
  }
  const moves: { from: string; to: string }[] = [];
  const step = (src: string, dest: string) => move(src, dest, deps, () => moves.push({ from: src, to: dest }));
  try {
    // 1. Stage a full copy; a failure here leaves the live data untouched.
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(from)) {
      if (!RESTORABLE.has(name) || name === 'workspace' || (name === 'ruby.db' && dbFile === 'garnet.db')) continue;
      // A pre-rename backup's ruby.db is restored as garnet.db: that is the file the app opens first, and any ruby.db in this home is moved aside below.
      copyVerbatim(join(from, name), join(staging, name === 'ruby.db' ? 'garnet.db' : name));
    }
    if (hasWorkspace) {
      mkdirSync(dirname(workspace), { recursive: true });
      copyVerbatim(join(from, 'workspace'), stagedWorkspace);
    }
    if (!present(join(staging, 'garnet.db'))) throw new Error('the staged database is missing');

    // 2. Commit: move every destination that will be replaced aside, then move the staged copies in. A failure part-way undoes the moves.
    mkdirSync(aside, { recursive: true, mode: 0o700 });
    for (const name of HOME_ENTRIES) if (present(join(home, name))) step(join(home, name), join(aside, name));
    if (present(currentWorkspace)) step(currentWorkspace, asideFor(currentWorkspace, 'workspace'));
    // The restored config may name a different directory than the live one; whatever is there is kept too.
    if (hasWorkspace && workspace !== currentWorkspace && present(workspace)) step(workspace, asideFor(workspace, 'workspace-at-restored-path'));
    for (const name of readdirSync(staging)) step(join(staging, name), join(home, name));
    if (hasWorkspace) step(stagedWorkspace, workspace);
  } catch (e) {
    const stuck: string[] = [];
    for (const m of moves.reverse()) {
      try {
        move(m.to, m.from, deps, () => {});
      } catch {
        stuck.push(m.to);
      }
    }
    rmSync(stagedWorkspace, { recursive: true, force: true });
    try {
      rmdirSync(aside); // only succeeds when empty, i.e. after a full rollback
    } catch {
      // Not empty (or never created): leave it.
    }
    const kept = stuck.length > 0 ? ` Data that could not be put back is at: ${stuck.join(', ')}.` : '';
    io.err(`Restore failed and was rolled back${stuck.length > 0 ? ' only in part' : ''}: ${(e as Error).message}.${kept}\n`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const kept = moves.filter((m) => m.to.endsWith(`.pre-restore-${stamp}`));
  io.out(`Restored from ${from}. Your previous data was moved to ${aside}${kept.length > 0 ? ` and ${kept.map((m) => m.to).join(', ')}` : ''}.\n`);
  return 0;
}
