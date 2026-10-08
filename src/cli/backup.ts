// `garnet backup` and `garnet restore`: a plain directory you can inspect, copy or archive.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseConfig, pathsFor } from '../config/index.ts';
import { createGarnet, VERSION } from '../main.ts';
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

/** Moves a file or directory. Across filesystems (an external workspace) rename fails with EXDEV, so copy and then remove. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
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

export function restore(args: string[], io: Io): number {
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
  // The previous data is moved into a directory under home, so the workspace may not be home or contain it.
  if (workspace === home || home.startsWith(workspace + sep)) {
    io.err(`The backup's config puts the workspace at ${workspace}, which contains Garnet's home. Nothing was changed.\n`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = join(home, `pre-restore-${stamp}`);
  const staging = join(home, `.restore-staging-${stamp}`);
  // The workspace is staged beside its destination, so the final move is a same-filesystem rename even for an external location.
  const stagedWorkspace = `${workspace}.restore-staging-${stamp}`;
  const hasWorkspace = existsSync(join(from, 'workspace'));
  const moves: [string, string][] = [];
  const step = (src: string, dest: string) => {
    move(src, dest);
    moves.push([dest, src]);
  };
  try {
    // 1. Stage a full copy; a failure here leaves the live data untouched.
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const names = readdirSync(from).filter((n) => n !== 'BACKUP.json' && !(n === 'ruby.db' && dbFile === 'garnet.db') && n !== 'workspace');
    for (const name of names) {
      // A pre-rename backup's ruby.db is restored as garnet.db: that is the file the app opens first, and any ruby.db in this home is moved aside below.
      cpSync(join(from, name), join(staging, name === 'ruby.db' ? 'garnet.db' : name), { recursive: true, verbatimSymlinks: true });
    }
    if (hasWorkspace) {
      mkdirSync(dirname(workspace), { recursive: true });
      cpSync(join(from, 'workspace'), stagedWorkspace, { recursive: true, verbatimSymlinks: true });
    }
    if (!existsSync(join(staging, 'garnet.db'))) throw new Error('the staged database is missing');

    // 2. Commit: move every destination that will be replaced aside, then move the staged copies in. A failure part-way undoes the moves.
    mkdirSync(aside, { recursive: true, mode: 0o700 });
    for (const name of HOME_ENTRIES) if (existsSync(join(home, name))) step(join(home, name), join(aside, name));
    if (existsSync(currentWorkspace)) step(currentWorkspace, join(aside, 'workspace'));
    // The restored config may name a different directory than the live one; whatever is there is kept too.
    if (hasWorkspace && workspace !== currentWorkspace && existsSync(workspace)) step(workspace, join(aside, 'workspace-at-restored-path'));
    for (const name of readdirSync(staging)) step(join(staging, name), join(home, name));
    if (hasWorkspace) step(stagedWorkspace, workspace);
  } catch (e) {
    for (const [now, original] of moves.reverse()) {
      try {
        move(now, original);
      } catch {
        // Keep going: whatever cannot be put back stays in the aside directory.
      }
    }
    rmSync(stagedWorkspace, { recursive: true, force: true });
    io.err(`Restore failed and was rolled back where possible: ${(e as Error).message}\nAny previous data not put back is in ${aside}.\n`);
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  io.out(`Restored from ${from}. Your previous data was moved to ${aside}.\n`);
  return 0;
}
