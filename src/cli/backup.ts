// `ruby backup` and `ruby restore`: a plain directory you can inspect, copy or archive.
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRuby, VERSION } from '../main.ts';
import { backupDb } from '../store/index.ts';
import type { Io } from './main.ts';

// Artifacts hold large tool outputs that session history refers to by id.
const DIRS = ['memory', 'skills', 'artifacts', 'workspace'];

export function backup(args: string[], io: Io): number {
  const ruby = createRuby({ noModel: true });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = resolve(args[0] ?? join(ruby.paths.home, 'backups', `ruby-${stamp}`));
    if (existsSync(target)) {
      io.err(`${target} already exists.\n`);
      return 1;
    }
    mkdirSync(target, { recursive: true, mode: 0o700 });
    backupDb(ruby.db, join(target, 'ruby.db'));
    if (existsSync(ruby.paths.configFile)) cpSync(ruby.paths.configFile, join(target, 'config.json'));
    // The encrypted store is safe to copy; its passphrase or key file is not included.
    if (ruby.secrets.exists()) cpSync(ruby.secrets.file, join(target, 'secrets'));
    for (const dir of DIRS) {
      const from = dir === 'workspace' ? ruby.paths.workspace : join(ruby.paths.home, dir);
      if (existsSync(from)) cpSync(from, join(target, dir), { recursive: true, verbatimSymlinks: true });
    }
    writeFileSync(join(target, 'BACKUP.json'), JSON.stringify({ version: VERSION, createdAt: new Date().toISOString() }, null, 2));
    const encrypted = ruby.secrets.exists() ? ' The encrypted secret store is included; its passphrase or key file is not.' : '';
    io.out(`Backed up to ${target}\nNot included: the env file with your secrets (${ruby.paths.home}/env). Keep a copy somewhere safe.${encrypted}\n`);
    return 0;
  } finally {
    ruby.close();
  }
}

export function restore(args: string[], io: Io): number {
  const from = args[0] && resolve(args[0]);
  if (!from || !existsSync(join(from, 'BACKUP.json')) || !existsSync(join(from, 'ruby.db'))) {
    io.err('Usage: ruby restore <backup-dir>   (stop Ruby first; the current data is moved aside, not deleted)\n');
    return 2;
  }
  const ruby = createRuby({ noModel: true });
  const home = ruby.paths.home;
  const workspace = ruby.paths.workspace;
  ruby.close();
  const aside = join(home, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(aside, { recursive: true, mode: 0o700 });
  for (const name of ['ruby.db', 'ruby.db-wal', 'ruby.db-shm', 'config.json', 'secrets', 'memory', 'skills', 'artifacts']) {
    if (existsSync(join(home, name))) renameSync(join(home, name), join(aside, name));
  }
  if (existsSync(workspace)) renameSync(workspace, join(aside, 'workspace'));
  for (const name of readdirSync(from)) {
    if (name === 'BACKUP.json') continue;
    const dest = name === 'workspace' ? workspace : join(home, name);
    cpSync(join(from, name), dest, { recursive: true, verbatimSymlinks: true });
  }
  io.out(`Restored from ${from}. Your previous data was moved to ${aside}.\n`);
  return 0;
}
