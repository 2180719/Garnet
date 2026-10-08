import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { planService } from '../service/index.ts';
import type { CommandResult } from '../service/index.ts';
import type { Io } from './main.ts';
import { UPDATE_AVAILABLE, execRun, fileLock, renamedOrigin, update, type UpdateDeps } from './update.ts';

// Real git, but only local repositories: the "remote" is a bare repo in a temp directory.
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

type Fixture = {
  root: string;
  work: string;
  install: string;
  home: string;
  userHome: string;
  /** Commits to the "remote" through a second clone. */
  push: (files: Record<string, string>, message: string) => string;
};

function fixture(): Fixture {
  const root = tempDir();
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const install = join(root, 'install');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, work], { stdio: 'ignore' });
  const push = (files: Record<string, string>, message: string): string => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(work, name, '..'), { recursive: true });
      writeFileSync(join(work, name), text);
    }
    git(work, 'add', '-A');
    git(work, 'commit', '--quiet', '-m', message);
    git(work, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  push({ 'package.json': '{"version":"1.0.0"}', 'package-lock.json': '{}', 'src/cli/bin.ts': '// ok', 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n### Old feature\n' }, 'first');
  execFileSync('git', ['clone', '--quiet', origin, install], { stdio: 'ignore' });
  const home = join(root, 'data');
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), '{"precious":true}');
  return { root, work, install, home, userHome: join(root, 'user'), push };
}

type Calls = { npm: string[][]; node: string[][]; other: string[][] };

type Scripted = {
  npmCode?: number;
  /** Extra node behaviours. A bin.ts containing BROKEN fails every run, like code that cannot load. */
  configCheck?: CommandResult;
  serviceShow?: CommandResult;
  yes?: boolean;
  lockHeld?: number;
};

function harness(f: Fixture, scripted: Scripted = {}) {
  const calls: Calls = { npm: [], node: [], other: [] };
  const questions: string[] = [];
  const run: UpdateDeps['run'] = async (cmd, opts) => {
    const [prog = '', ...rest] = cmd;
    if (prog === 'git') return execRun(cmd, opts);
    if (prog === 'npm') {
      calls.npm.push(cmd);
      return { code: scripted.npmCode ?? 0, stdout: '', stderr: scripted.npmCode ? 'npm ERR! boom' : '' };
    }
    if (prog === process.execPath) {
      const args = rest.slice(2); // drop the node flag and bin.ts
      calls.node.push(args);
      const broken = readFileSync(join(f.install, 'src/cli/bin.ts'), 'utf8').includes('BROKEN');
      if (broken) return { code: 1, stdout: '', stderr: 'SyntaxError: Unexpected token' };
      if (args[0] === '--version') return { code: 0, stdout: `garnet ${JSON.parse(readFileSync(join(f.install, 'package.json'), 'utf8')).version}\n`, stderr: '' };
      if (args[0] === 'config') return scripted.configCheck ?? { code: 0, stdout: 'Config OK (defaults).\n', stderr: '' };
      if (args[0] === 'service' && args[1] === 'show') return scripted.serviceShow ?? { code: 1, stdout: '', stderr: 'no' };
      return { code: 0, stdout: '', stderr: '' };
    }
    calls.other.push(cmd);
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = { out: '', err: '' };
  const io: Io = { out: (t) => void (out.out += t), err: (t) => void (out.err += t) };
  const deps: UpdateDeps = {
    installDir: f.install,
    home: f.home,
    userHome: f.userHome,
    platform: 'linux',
    env: { GARNET_BIN_DIR: join(f.userHome, 'bin') },
    nodePath: process.execPath,
    run,
    exists: (p) => existsSync(p),
    readText: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null),
    list: (dir) => (existsSync(dir) ? execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter(Boolean) : []),
    confirm: async (q) => {
      questions.push(q);
      return scripted.yes ?? true;
    },
    acquireLock: scripted.lockHeld ? () => ({ heldBy: scripted.lockHeld! }) : fileLock(join(f.install, '.git', 'garnet-update.lock')),
    color: false,
  };
  return { deps, calls, io, out, questions, go: (args: string[]) => update(args, io, deps) };
}

const head = (f: Fixture): string => git(f.install, 'rev-parse', 'HEAD');
const dataUntouched = (f: Fixture): void => assert.equal(readFileSync(join(f.home, 'config.json'), 'utf8'), '{"precious":true}');

test('up to date: nothing changes, check exits 0', async () => {
  const f = fixture();
  const h = harness(f);
  assert.equal(await h.go(['--check']), 0);
  assert.match(h.out.out, /Up to date/);
  const h2 = harness(f);
  assert.equal(await h2.go(['-y']), 0);
  assert.match(h2.out.out, /Already up to date/);
  assert.deepEqual(h2.calls.npm, []);
  assert.equal(h2.questions.length, 0);
});

test('--check reports commits behind with exit 10 and changes nothing', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'src/a.ts': 'x', 'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n### Old feature\n### Brand new thing\n' }, 'add the new thing');
  f.push({ 'package.json': '{"version":"1.1.0"}' }, 'bump version');
  const h = harness(f);
  assert.equal(await h.go(['--check']), UPDATE_AVAILABLE);
  assert.match(h.out.out, /Current: 1\.0\.0/);
  assert.match(h.out.out, /Latest:  1\.1\.0/);
  assert.match(h.out.out, /2 commits behind/);
  assert.match(h.out.out, /add the new thing/);
  assert.match(h.out.out, /New in CHANGELOG\.md: Brand new thing/);
  assert.equal(head(f), before);
  assert.equal(h.questions.length, 0);
  assert.deepEqual(h.calls.npm, []);
});

test('--check caps the list of subjects', async () => {
  const f = fixture();
  for (let i = 0; i < 25; i++) f.push({ [`f${i}.txt`]: String(i) }, `change ${i}`);
  const h = harness(f);
  assert.equal(await h.go(['--check']), UPDATE_AVAILABLE);
  assert.match(h.out.out, /25 commits behind/);
  assert.match(h.out.out, /and 5 more/);
});

test('behind: fast-forwards, skips npm when dependencies are unchanged, never touches data', async () => {
  const f = fixture();
  const target = f.push({ 'src/a.ts': 'x', 'package.json': '{"version":"1.0.0"}' }, 'code only');
  const h = harness(f);
  assert.equal(await h.go([]), 0);
  assert.equal(head(f), target);
  assert.equal(h.questions.length, 1);
  assert.deepEqual(h.calls.npm, []);
  assert.match(h.out.out, /Dependencies unchanged/);
  assert.match(h.out.out, /Garnet updated/);
  assert.match(h.out.out, /garnet doctor/);
  assert.equal(git(f.install, 'branch', '--show-current'), 'main');
  assert.equal(existsSync(join(f.install, '.git', 'garnet-update.lock')), false);
  dataUntouched(f);
});

test('declining the confirmation changes nothing', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f, { yes: false });
  assert.equal(await h.go([]), 1);
  assert.equal(head(f), before);
  assert.match(h.out.out, /Nothing was changed/);
});

test('-y does not ask; dependency change runs npm ci with --omit=dev', async () => {
  const f = fixture();
  const target = f.push({ 'package-lock.json': '{"changed":true}' }, 'dependency bump');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 0);
  assert.equal(head(f), target);
  assert.equal(h.questions.length, 0);
  assert.equal(h.calls.npm.length, 1);
  assert.deepEqual(h.calls.npm[0]!.slice(0, 3), ['npm', 'ci', '--omit=dev']);
  assert.match(h.out.out, /Dependencies changed/);
});

test('--reinstall runs npm ci even when dependencies did not change', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f);
  assert.equal(await h.go(['-y', '--reinstall']), 0);
  assert.equal(h.calls.npm.length, 1);
});

test('dirty tree is refused and left alone', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  writeFileSync(join(f.install, 'package.json'), '{"version":"local edit"}');
  const before = head(f);
  const h = harness(f);
  assert.equal(await h.go(['-y']), 1);
  assert.match(h.out.err, /uncommitted changes/);
  assert.match(h.out.err, /Commit or stash/);
  assert.equal(head(f), before);
  assert.equal(readFileSync(join(f.install, 'package.json'), 'utf8'), '{"version":"local edit"}');
  assert.equal(await harness(f).go(['--check']), UPDATE_AVAILABLE); // a check still looks (and warns)
});

test('local commits are refused, ahead or diverged', async () => {
  const f = fixture();
  writeFileSync(join(f.install, 'mine.txt'), 'mine');
  git(f.install, 'add', '-A');
  git(f.install, 'commit', '--quiet', '-m', 'my change');
  const mine = head(f);
  const ahead = harness(f);
  assert.equal(await ahead.go(['-y']), 1);
  assert.match(ahead.out.err, /1 local commit/);
  assert.match(ahead.out.err, /development checkout/);
  assert.equal(head(f), mine);
  f.push({ 'theirs.txt': 'theirs' }, 'upstream change');
  const diverged = harness(f);
  assert.equal(await diverged.go(['-y']), 1);
  assert.match(diverged.out.err, /diverged/);
  assert.equal(head(f), mine);
  assert.equal(await harness(f).go(['--check']), 1);
  assert.deepEqual(diverged.calls.npm, []);
});

test('a directory that is not a git checkout is refused with reinstall advice', async () => {
  const f = fixture();
  const plain = join(f.root, 'plain');
  mkdirSync(plain);
  const h = harness(f);
  h.deps.installDir = plain;
  assert.equal(await update(['-y'], h.io, h.deps), 1);
  assert.match(h.out.err, /not a git checkout/);
  assert.match(h.out.err, /install\.sh/);
  assert.equal(await update(['--check'], h.io, h.deps), 1);
});

test('smoke-check failure rolls back to the old commit and restores dependencies', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'src/cli/bin.ts': '// BROKEN', 'package-lock.json': '{"changed":true}' }, 'breaks startup');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 1);
  assert.equal(head(f), before);
  assert.equal(git(f.install, 'branch', '--show-current'), 'main');
  assert.equal(git(f.install, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.match(h.out.err, /does not start/);
  assert.match(h.out.err, /rolled back: version 1\.0\.0 .* is still in place/);
  assert.equal(h.calls.npm.length, 2); // install for the update, restore for the rollback
  assert.match(h.out.out, /Restored the checkout/);
  assert.equal(existsSync(join(f.install, '.git', 'garnet-update.lock')), false);
  dataUntouched(f);
});

test('smoke failure without dependency changes rolls back without npm', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'src/cli/bin.ts': '// BROKEN' }, 'breaks startup');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 1);
  assert.equal(head(f), before);
  assert.deepEqual(h.calls.npm, []);
});

test('npm failure rolls back to the old commit', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'package-lock.json': '{"changed":true}' }, 'dependency bump');
  const h = harness(f, { npmCode: 1 });
  assert.equal(await h.go(['-y']), 1);
  assert.equal(head(f), before);
  assert.match(h.out.err, /npm ci failed/);
  assert.match(h.out.err, /still in place/);
  assert.match(h.out.err, /npm ERR! boom/);
});

test('an unreachable remote is reported and nothing changes', async () => {
  const f = fixture();
  git(f.install, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
  const before = head(f);
  const h = harness(f);
  assert.equal(await h.go(['-y']), 1);
  assert.match(h.out.err, /git fetch origin main failed/);
  assert.equal(head(f), before);
});

test('--ref updates to a tag; an invalid ref is a usage error', async () => {
  const f = fixture();
  const tagged = f.push({ 'a.txt': 'a' }, 'release');
  git(f.work, 'tag', 'v1.2.0');
  git(f.work, 'push', '--quiet', 'origin', 'v1.2.0');
  f.push({ 'b.txt': 'b' }, 'after the release');
  const h = harness(f);
  assert.equal(await h.go(['-y', '--ref', 'v1.2.0']), 0);
  assert.equal(head(f), tagged);
  assert.equal(await harness(f).go(['--ref', '--evil']), 2);
  assert.equal(await harness(f).go(['--ref', 'a b']), 2);
  assert.equal(await harness(f).go(['--bogus']), 2);
  assert.equal(await harness(f).go(['--check', '-y']), 2);
});

test('an invalid config after the update is reported and the service is not restarted', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const unit = installUnit(f);
  const h = harness(f, { configCheck: { code: 1, stdout: '', stderr: 'model.name: expected a string' } });
  assert.equal(await h.go(['-y']), 0);
  assert.match(h.out.out, /Your config has problems/);
  assert.match(h.out.out, /model\.name: expected a string/);
  assert.match(h.out.out, /NOT restarted/);
  assert.deepEqual(h.calls.other, []);
  assert.ok(unit);
});

function installUnit(f: Fixture): string {
  const plan = planService({ platform: 'linux', home: f.home, userHome: f.userHome, nodePath: process.execPath, entry: join(f.install, 'src/cli/bin.ts') });
  assert.ok(!('unsupported' in plan));
  mkdirSync(join(f.userHome, '.config/systemd/user'), { recursive: true });
  writeFileSync(plan.path, plan.contents);
  return plan.contents;
}

test('-y restarts the background service for this home', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const contents = installUnit(f);
  const h = harness(f, { serviceShow: { code: 0, stdout: `# unit\n${contents}\n`, stderr: '' } });
  assert.equal(await h.go(['-y']), 0);
  assert.match(h.out.out, /Service restarted/);
  assert.ok(h.calls.other.some((c) => c.join(' ').includes('systemctl --user restart')));
  assert.ok(!h.calls.node.some((a) => a[0] === 'service' && a[1] === 'install'));
  assert.equal(h.questions.length, 0);
});

test('without -y the service restart is asked and can be declined', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const contents = installUnit(f);
  let n = 0;
  const h = harness(f, { serviceShow: { code: 0, stdout: `# unit\n${contents}\n`, stderr: '' } });
  h.deps.confirm = async (q) => {
    h.questions.push(q);
    return ++n === 1; // yes to the update, no to the restart
  };
  assert.equal(await h.go([]), 0);
  assert.equal(h.questions.length, 2);
  assert.match(h.out.out, /Left running on the old code/);
  assert.deepEqual(h.calls.other, []);
});

test('a changed unit file is reinstalled instead of restarted', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  installUnit(f);
  const h = harness(f, { serviceShow: { code: 0, stdout: '# unit\n[Unit]\nDescription=a newer template\n', stderr: '' } });
  assert.equal(await h.go(['-y']), 0);
  assert.ok(h.calls.node.some((a) => a[0] === 'service' && a[1] === 'install'));
  assert.deepEqual(h.calls.other, []);
  assert.match(h.out.out, /Service reinstalled/);
});

test('no service installed for this home: nothing to restart', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 0);
  assert.doesNotMatch(h.out.out, /Background service/);
});

test('the shim is only reported on: missing, then pointing elsewhere', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 0);
  assert.match(h.out.out, /No `garnet` command found/);
  const f2 = fixture();
  f2.push({ 'a.txt': 'a' }, 'more');
  mkdirSync(join(f2.userHome, 'bin'), { recursive: true });
  writeFileSync(join(f2.userHome, 'bin', 'garnet'), '#!/bin/sh\nexec node /elsewhere/src/cli/bin.ts\n');
  const h2 = harness(f2);
  assert.equal(await h2.go(['-y']), 0);
  assert.match(h2.out.out, /does not point at this install/);
  assert.equal(readFileSync(join(f2.userHome, 'bin', 'garnet'), 'utf8'), '#!/bin/sh\nexec node /elsewhere/src/cli/bin.ts\n');
});

test('lock contention: a second updater is refused and nothing changes', async () => {
  const f = fixture();
  const before = head(f);
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f, { lockHeld: 4242 });
  assert.equal(await h.go(['-y']), 1);
  assert.match(h.out.err, /Another garnet update is already running \(pid 4242\)/);
  assert.equal(head(f), before);
});

test('file lock: a live pid blocks, a stale pid is taken over, release removes it', () => {
  const dir = tempDir();
  const path = join(dir, 'lock');
  const acquire = fileLock(path);
  const first = acquire();
  assert.ok('release' in first);
  assert.deepEqual(acquire(), { heldBy: process.pid });
  first.release?.();
  assert.equal(existsSync(path), false);
  writeFileSync(path, '2147483646\n'); // no such process
  const taken = acquire();
  assert.ok('release' in taken);
  taken.release?.();
});

test('help text and NO_COLOR output carry no escape sequences', async () => {
  const f = fixture();
  f.push({ 'a.txt': 'a' }, 'more');
  const h = harness(f);
  assert.equal(await h.go(['--help']), 0);
  assert.match(h.out.out, /--check/);
  const h2 = harness(f);
  await h2.go(['-y']);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(h2.out.out + h2.out.err, /\x1b\[/);
  assert.doesNotMatch(h2.out.out + h2.out.err, /—/);
});

test('renamedOrigin only recognizes the old GitHub forms and keeps the protocol', () => {
  const to = 'garnet-foundation/Garnet';
  assert.equal(renamedOrigin('https://github.com/2180719/Garnet'), `https://github.com/${to}`);
  assert.equal(renamedOrigin('https://github.com/2180719/Garnet.git'), `https://github.com/${to}.git`);
  assert.equal(renamedOrigin('git@github.com:2180719/Garnet.git'), `git@github.com:${to}.git`);
  assert.equal(renamedOrigin('ssh://git@github.com/2180719/Garnet'), `ssh://git@github.com/${to}`);
  assert.equal(renamedOrigin('https://github.com/garnet-foundation/Garnet'), null);
  assert.equal(renamedOrigin('https://mirror.example/2180719/Garnet'), null);
  assert.equal(renamedOrigin('/srv/git/2180719/Garnet'), null);
});

test('an update repoints a remote that names the old GitHub location only once it succeeds', async () => {
  const f = fixture();
  const oldUrl = 'https://github.com/2180719/Garnet';
  const newUrl = 'https://github.com/garnet-foundation/Garnet';
  // The new address is served by the local bare repository, so no network is needed.
  git(f.install, 'config', `url.${join(f.root, 'origin.git')}.insteadOf`, newUrl);
  git(f.install, 'remote', 'set-url', 'origin', oldUrl);
  f.push({ 'src/a.ts': 'x' }, 'code only');
  const check = harness(f);
  await check.go(['--check']);
  assert.equal(git(f.install, 'remote', 'get-url', 'origin'), oldUrl);
  const declined = harness(f, { yes: false });
  assert.equal(await declined.go([]), 1);
  assert.equal(git(f.install, 'remote', 'get-url', 'origin'), oldUrl);
  const h = harness(f);
  assert.equal(await h.go(['-y']), 0);
  assert.equal(git(f.install, 'config', '--get', 'remote.origin.url'), newUrl);
  assert.match(h.out.out, /The repository moved/);
});

test('an already up to date install still repoints a remote that names the old GitHub location', async () => {
  const f = fixture();
  const newUrl = 'https://github.com/garnet-foundation/Garnet.git';
  git(f.install, 'config', `url.${join(f.root, 'origin.git')}.insteadOf`, newUrl);
  git(f.install, 'remote', 'set-url', 'origin', 'https://github.com/2180719/Garnet.git');
  const h = harness(f);
  assert.equal(await h.go(['-y']), 0);
  assert.match(h.out.out, /Already up to date/);
  assert.equal(git(f.install, 'config', '--get', 'remote.origin.url'), newUrl);
});
