// CLI argument handling for the owner commands (memory, skills, flags).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from './helpers.ts';
import { restoreWith } from '../src/cli/backup.ts';
import { main } from '../src/cli/main.ts';
import { MemoryStore } from '../src/memory/index.ts';
import { createGarnet } from '../src/main.ts';
import { MediaStore } from '../src/media/index.ts';
import { GatewayStore } from '../src/store/index.ts';

const home = tempDir();
const saved = { home: process.env.GARNET_HOME, editor: process.env.EDITOR, visual: process.env.VISUAL };
process.env.GARNET_HOME = home;
after(() => {
  for (const [k, v] of [['GARNET_HOME', saved.home], ['EDITOR', saved.editor], ['VISUAL', saved.visual]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

/** Runs `fn` against a fresh Garnet home, for tests that must not see other tests' leftovers. */
async function withOwnHome(fn: (home: string) => Promise<void>) {
  const own = tempDir();
  process.env.GARNET_HOME = own;
  try {
    await fn(own);
  } finally {
    process.env.GARNET_HOME = home;
  }
}

test('memory rollback takes the id even when --ns comes last', async () => {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const store = new MemoryStore({ root: join(home, 'memory'), now: () => new Date((t += 1000)) });
  store.add('work', 'memory', 'first');
  store.add('work', 'memory', 'second');
  const id = store.history('work', 'memory')[0]!.id;
  const r = await run('memory', 'rollback', 'memory', id, '--ns', 'work');
  assert.equal(r.code, 0, r.err);
  assert.equal(store.read('work', 'memory'), '- first');
});

test('memory edit runs $EDITOR with its arguments', async () => {
  const script = join(tempDir(), 'ed.sh');
  writeFileSync(script, '#!/bin/sh\n[ "$1" = "--wait" ] || exit 3\nprintf -- "- edited by %s\\n" "$1" > "$2"\n');
  chmodSync(script, 0o755);
  delete process.env.VISUAL;
  process.env.EDITOR = `${script} --wait`;
  const r = await run('memory', 'edit', 'user');
  assert.equal(r.code, 0, r.err);
  assert.equal(new MemoryStore({ root: join(home, 'memory') }).read('default', 'user'), '- edited by --wait');
});

test('bad flags are a usage error (exit 2), not an unexpected error', async () => {
  const r = await run('doctor', '--bogus');
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /Unexpected error/);
  assert.match(r.err, /--bogus/);
});

test('skills stale rejects a non-number', async () => {
  const r = await run('skills', 'stale', 'soon');
  assert.equal(r.code, 2);
});

test('backup and restore round-trip the database, config, memory, skills, artifacts and workspace', async () => {
  const mem = new MemoryStore({ root: join(home, 'memory') });
  mem.write('default', 'memory', '- backed up fact');
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'notes.md'), 'workspace file');
  mkdirSync(join(home, 'artifacts'), { recursive: true });
  writeFileSync(join(home, 'artifacts', 'art_1.txt'), 'large tool output');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, persona: 'Backed up.' }));
  const target = join(tempDir(), 'bk');
  const b = await run('backup', target);
  assert.equal(b.code, 0, b.err);
  for (const name of ['garnet.db', 'config.json', 'memory', 'workspace', 'artifacts', 'BACKUP.json']) assert.ok(existsSync(join(target, name)), name);

  mem.write('default', 'memory', '- changed after the backup');
  writeFileSync(join(home, 'artifacts', 'art_1.txt'), 'changed');
  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  assert.equal(mem.read('default', 'memory'), '- backed up fact');
  assert.equal(readFileSync(join(home, 'artifacts', 'art_1.txt'), 'utf8'), 'large tool output');
  assert.equal(readFileSync(join(home, 'workspace', 'notes.md'), 'utf8'), 'workspace file');
  const aside = readdirSync(home).find((n) => n.startsWith('pre-restore-'))!;
  assert.equal(readFileSync(join(home, aside, 'artifacts', 'art_1.txt'), 'utf8'), 'changed', 'the replaced data is moved aside, not deleted');
});

test('restore puts the workspace where the backup config names it, and keeps what was there', () => withOwnHome(async (home) => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, workspace: 'workspace-a' }));
  mkdirSync(join(home, 'workspace-a'), { recursive: true });
  writeFileSync(join(home, 'workspace-a', 'data.txt'), 'BACKED-UP');
  const target = join(tempDir(), 'bk-workspace');
  assert.equal((await run('backup', target)).code, 0);

  writeFileSync(join(home, 'workspace-a', 'data.txt'), 'CHANGED');
  mkdirSync(join(home, 'workspace-b'), { recursive: true });
  writeFileSync(join(home, 'workspace-b', 'other.txt'), 'B-CONTENT');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, workspace: 'workspace-b' }));

  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  const garnet = createGarnet({ noModel: true, home });
  try {
    assert.equal(garnet.paths.workspace, join(home, 'workspace-a'));
    assert.equal(readFileSync(join(garnet.paths.workspace, 'data.txt'), 'utf8'), 'BACKED-UP');
  } finally {
    garnet.close();
  }
  assert.ok(!existsSync(join(home, 'workspace-b')), 'the workspace the old config named is not left behind');
  const aside = join(home, readdirSync(home).find((n) => n.startsWith('pre-restore-'))!);
  assert.equal(readFileSync(join(aside, 'workspace', 'other.txt'), 'utf8'), 'B-CONTENT');
  assert.equal(readFileSync(join(aside, 'workspace-at-restored-path', 'data.txt'), 'utf8'), 'CHANGED');
  assert.ok(!readdirSync(home).some((n) => n.includes('restore-staging')), 'no staging directory remains');
}));

test('restore refuses an unusable backup config before moving anything', () => withOwnHome(async (home) => {
  const target = join(tempDir(), 'bk-bad-config');
  assert.equal((await run('backup', target)).code, 0);
  writeFileSync(join(target, 'config.json'), '{ not json');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, persona: 'Live.' }));
  const r = await run('restore', target);
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing was changed/);
  assert.match(readFileSync(join(home, 'config.json'), 'utf8'), /Live\./);
  assert.ok(!readdirSync(home).some((n) => n.startsWith('pre-restore-')));
}));

test('restore keeps a backed-up workspace that is a dangling relative symlink', () => withOwnHome(async (home) => {
  mkdirSync(join(home, 'real-ws'), { recursive: true });
  writeFileSync(join(home, 'real-ws', 'data.txt'), 'KEEP');
  symlinkSync('real-ws', join(home, 'workspace'));
  const target = join(tempDir(), 'bk-symlink-ws');
  assert.equal((await run('backup', target)).code, 0);
  rmSync(join(home, 'workspace'), { force: true });
  mkdirSync(join(home, 'workspace'));
  writeFileSync(join(home, 'workspace', 'live.txt'), 'LIVE');
  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  assert.ok(lstatSync(join(home, 'workspace')).isSymbolicLink(), 'the backed-up link, not nothing, is at the workspace path');
}));

/** Every file under `dir` (except the database, which opening Garnet touches) with its content, for before/after comparisons. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('garnet.db')) continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, snapshot(join(dir, entry.name), `${rel}/`));
    else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return out;
}

/** A home with a backup of workspace-a (BACKED-UP) and a live config pointing at workspace-b. Returns the backup directory. */
async function backedUpWithOtherWorkspace(home: string): Promise<string> {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, workspace: 'workspace-a' }));
  mkdirSync(join(home, 'workspace-a'), { recursive: true });
  writeFileSync(join(home, 'workspace-a', 'data.txt'), 'BACKED-UP');
  const target = join(tempDir(), 'bk');
  assert.equal((await run('backup', target)).code, 0);
  writeFileSync(join(home, 'workspace-a', 'data.txt'), 'CHANGED');
  mkdirSync(join(home, 'workspace-b'), { recursive: true });
  writeFileSync(join(home, 'workspace-b', 'other.txt'), 'B-CONTENT');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, workspace: 'workspace-b' }));
  return target;
}

function restoreCapture(target: string, rename: (from: string, to: string) => void) {
  let out = '';
  let err = '';
  const code = restoreWith([target], { out: (t) => (out += t), err: (t) => (err += t) }, { rename });
  return { code, out, err };
}

test('restore falls back to copy and remove when rename crosses filesystems (EXDEV)', () => withOwnHome(async (home) => {
  const target = await backedUpWithOtherWorkspace(home);
  const r = restoreCapture(target, () => {
    throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(home, 'workspace-a', 'data.txt'), 'utf8'), 'BACKED-UP');
  assert.ok(!existsSync(join(home, 'workspace-b')));
  const aside = join(home, readdirSync(home).find((n) => n.startsWith('pre-restore-'))!);
  assert.equal(readFileSync(join(aside, 'workspace', 'other.txt'), 'utf8'), 'B-CONTENT');
}));

test('a failure at any commit step rolls everything back', () => withOwnHome(async (home) => {
  const target = await backedUpWithOtherWorkspace(home);
  mkdirSync(join(home, 'memory'));
  writeFileSync(join(home, 'memory', 'MEMORY.md'), '- live');
  createGarnet({ noModel: true, home }).close(); // opening migrates config.json once; do that before taking the snapshot
  const before = snapshot(home);
  let failed = 0;
  for (let n = 1; n < 40; n++) {
    let calls = 0;
    const r = restoreCapture(target, (a, b) => {
      if (++calls === n) throw Object.assign(new Error('disk trouble'), { code: 'EIO' });
      renameSync(a, b);
    });
    if (r.code === 0) break;
    failed++;
    assert.match(r.err, /rolled back/);
    assert.doesNotMatch(r.err, /only in part/, `step ${n}`);
    assert.deepEqual(snapshot(home), before, `step ${n} left the home as it was`);
    assert.ok(!readdirSync(home).some((name) => name.startsWith('pre-restore-') || name.includes('restore-staging')), `step ${n} cleaned up`);
  }
  assert.ok(failed >= 5, `exercised ${failed} failing steps`);
}));

test('restore ignores files in the backup that backup does not write, such as env', () => withOwnHome(async (home) => {
  const target = await backedUpWithOtherWorkspace(home);
  writeFileSync(join(home, 'env'), 'LIVE_KEY=1');
  writeFileSync(join(target, 'env'), 'FROM_BACKUP=1');
  const r = restoreCapture(target, renameSync);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Ignoring files.*env/);
  assert.equal(readFileSync(join(home, 'env'), 'utf8'), 'LIVE_KEY=1');
}));

test('restore from a backup with no workspace directory still moves the live workspace aside', () => withOwnHome(async (home) => {
  const target = await backedUpWithOtherWorkspace(home);
  rmSync(join(target, 'workspace'), { recursive: true });
  const r = restoreCapture(target, renameSync);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(home, 'workspace-a', 'data.txt'), 'utf8'), 'CHANGED', 'the restored path is untouched when the backup has no workspace');
  const aside = join(home, readdirSync(home).find((n) => n.startsWith('pre-restore-'))!);
  assert.equal(readFileSync(join(aside, 'workspace', 'other.txt'), 'utf8'), 'B-CONTENT');
}));

test('restore refuses nested or home-containing workspaces before moving anything', () => withOwnHome(async (home) => {
  const target = await backedUpWithOtherWorkspace(home);
  const before = snapshot(home);
  const cases: [string, string, RegExp][] = [
    ['workspace-b/inner', 'workspace-b', /nested/],
    ['/', 'workspace-b', /contains Garnet's home/],
    ['memory/ws', 'workspace-b', /inside .*memory/],
  ];
  for (const [restored, current, expected] of cases) {
    writeFileSync(join(target, 'config.json'), JSON.stringify({ version: 1, workspace: restored }));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, workspace: current }));
    const r = restoreCapture(target, renameSync);
    assert.equal(r.code, 1, restored);
    assert.match(r.err, expected, restored);
    assert.match(r.err, /Nothing was changed/);
  }
  assert.equal(snapshot(home)['workspace-b/other.txt'], before['workspace-b/other.txt']);
  assert.ok(!readdirSync(home).some((n) => n.startsWith('pre-restore-')));
}));

test('backup and restore include the media store, so a pending outbox attachment survives', async () => {
  const media = new MediaStore(join(home, 'media'), 1_000_000);
  const ref = media.put({ data: Buffer.from('attachment bytes'), name: 'a.txt', mimeType: 'text/plain' });
  const garnet = createGarnet({ noModel: true, home });
  try {
    new GatewayStore(garnet.db).enqueue({ channel: 'telegram', account: 'a', chatId: '1', text: 'here', attachments: [{ path: media.path(ref.id), name: 'a.txt', mimeType: 'text/plain', kind: ref.kind, size: ref.size }] });
  } finally {
    garnet.close();
  }
  const target = join(tempDir(), 'bk-media');
  const b = await run('backup', target);
  assert.equal(b.code, 0, b.err);
  assert.equal(readFileSync(join(target, 'media', `${ref.id}.bin`), 'utf8'), 'attachment bytes');

  rmSync(join(home, 'media'), { recursive: true });
  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(media.path(ref.id), 'utf8'), 'attachment bytes', 'the restored outbox row still points at an existing file');
});

test('restore accepts a pre-rename backup (ruby.db) and the restored data is what the app opens', async () => {
  const before = createGarnet({ noModel: true, home });
  const sessionId = before.store.createSession('from the old backup').id;
  before.close();
  const target = join(tempDir(), 'bk-legacy');
  assert.equal((await run('backup', target)).code, 0);
  renameSync(join(target, 'garnet.db'), join(target, 'ruby.db'));
  const garnetNow = createGarnet({ noModel: true, home });
  const extra = garnetNow.store.createSession('made after the backup').id;
  garnetNow.close();

  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(home, 'garnet.db')) && !existsSync(join(home, 'ruby.db')));
  const after = createGarnet({ noModel: true, home });
  try {
    const ids = after.store.listSessions().map((s) => s.id);
    assert.ok(ids.includes(sessionId), 'the backup data is open');
    assert.ok(!ids.includes(extra), 'later data is not');
  } finally {
    after.close();
  }
});

test('garnet jobs: add, list, show, pause, edit and delete; config.json jobs stay read-only', async () => {
  const own = tempDir();
  process.env.GARNET_HOME = own;
  try {
    writeFileSync(join(own, 'config.json'), JSON.stringify({ version: 1, timezone: 'Europe/London', jobs: [{ id: 'brief', kind: 'cron', cron: '0 7 * * 1-5', instructions: 'Morning brief.' }] }));
    const nowhere = await run('jobs', 'add', '--when', 'in 20 minutes', '--message', 'Stretch');
    assert.equal(nowhere.code, 1);
    assert.match(nowhere.err, /no chat to send to.*garnet pair/s);
    const added = await run('jobs', 'add', '--when', 'every day at 8am', '--instructions', 'Tidy notes', '--name', 'tidy');
    assert.equal(added.code, 0, added.err);
    assert.match(added.out, /Added tidy: every day at 08:00, next .* \(Europe\/London, in .*\) \(results kept in history only\)\./);
    const list = await run('jobs');
    assert.match(list.out, /^brief\s+enabled\s+config\s+every weekday at 07:00/m);
    assert.match(list.out, /^tidy\s+enabled\s+cli\s+every day at 08:00/m);
    assert.match(list.out, /Times are in Europe\/London\./);
    assert.match((await run('jobs', 'show', 'tidy')).out, /from:\s+added from the cli/);
    assert.match((await run('jobs', 'pause', 'brief')).out, /Paused brief/);
    assert.match((await run('jobs', 'list')).out, /^brief\s+PAUSED/m);
    assert.match((await run('jobs', 'edit', 'tidy', '--when', 'weekdays at 18:30')).out, /Updated tidy: every weekday at 18:30/);
    const refused = await run('jobs', 'delete', 'brief');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /config\.json/);
    assert.equal((await run('jobs', 'delete', 'tidy')).code, 0);
    assert.doesNotMatch((await run('jobs')).out, /tidy/);
    assert.match((await run('jobs', 'help')).out, /garnet jobs add --when/);
  } finally {
    process.env.GARNET_HOME = home;
  }
});
