import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultEntry, installedServices, installService, planService, resolveService, restartService, serviceHomeOf, serviceStatus, shellQuote, uninstallService } from './index.ts';
import type { CommandResult, ServicePlan } from './index.ts';

const base = {
  home: '/home/me/.garnet',
  userHome: '/home/me',
  nodePath: '/usr/bin/node',
  entry: '/opt/garnet/src/cli/bin.ts',
};

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function plan(opts: Parameters<typeof planService>[0]): ServicePlan {
  const p = planService(opts);
  assert.ok(!('unsupported' in p), 'expected a plan');
  return p;
}

test('systemd unit has the expected lines and absolute paths', () => {
  const p = plan({ ...base, platform: 'linux' });
  assert.equal(p.platform, 'systemd');
  assert.equal(p.path, '/home/me/.config/systemd/user/garnet.service');
  const lines = p.contents.split('\n');
  for (const line of [
    'ExecStart="/usr/bin/node" "--disable-warning=ExperimentalWarning" "/opt/garnet/src/cli/bin.ts" "start"',
    'WorkingDirectory=/opt/garnet',
    'Environment="GARNET_HOME=/home/me/.garnet"',
    'EnvironmentFile=-/home/me/.garnet/env',
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=60',
    'KillSignal=SIGTERM',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'WantedBy=default.target',
  ]) {
    assert.ok(lines.includes(line), `missing line: ${line}`);
  }
  assert.deepEqual(p.commands.prepare, []);
  assert.deepEqual(p.commands.install, [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', 'garnet.service'],
    ['systemctl', '--user', 'restart', 'garnet.service'],
  ]);
  assert.ok(p.notes.some((n) => n.includes('loginctl enable-linger $USER')));
});

test('systemd quoting protects spaces, quotes, $ and %', () => {
  const p = plan({ ...base, platform: 'linux', nodePath: '/opt/my node/bin/node', home: '/h/a"b%c$d' });
  assert.ok(p.contents.includes('ExecStart="/opt/my node/bin/node" '));
  assert.ok(p.contents.includes('Environment="GARNET_HOME=/h/a\\"b%%c$$d"'));
});

test('launchd plist has the expected keys and escapes XML', () => {
  const p = plan({ ...base, platform: 'darwin', uid: 501, home: '/Users/a&b/<garnet>', userHome: '/Users/a&b' });
  assert.equal(p.platform, 'launchd');
  assert.equal(p.path, '/Users/a&b/Library/LaunchAgents/dev.garnet.agent.plist');
  assert.ok(p.contents.includes('<string>/Users/a&amp;b/&lt;garnet&gt;</string>'));
  assert.ok(p.contents.includes('<string>/Users/a&amp;b/&lt;garnet&gt;/logs/garnet.out.log</string>'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(p.contents), 'bare ampersand in plist');
  assert.ok(!p.contents.includes('<garnet>'));
  assert.match(p.contents, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p.contents, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(p.contents, /<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
  assert.ok(unescapeXml(p.contents).includes('exec /usr/bin/node --disable-warning=ExperimentalWarning /opt/garnet/src/cli/bin.ts start'));
  assert.ok(unescapeXml(p.contents).includes('. "$GARNET_HOME/env"'));
  assert.deepEqual(p.commands.prepare, [['launchctl', 'bootout', 'gui/501/dev.garnet.agent']]);
  assert.deepEqual(p.commands.install, [['launchctl', 'bootstrap', 'gui/501', p.path]]);
  assert.match(p.contents, /<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/);
  assert.match(p.contents, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.deepEqual(p.commands.uninstall, [['launchctl', 'bootout', 'gui/501/dev.garnet.agent']]);
});

test('shellQuote round-trips through a real sh', () => {
  const samples = ['plain', '/usr/bin/node', 'has space', "it's", "a'b'c", "'", '$HOME `x` "q" \\ ; &', '', '日本 語'];
  for (const s of samples) {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' });
    assert.equal(out, s);
  }
  assert.equal(shellQuote('/safe/path-1.2'), '/safe/path-1.2');
  assert.equal(shellQuote("a b's"), `'a b'\\''s'`);
});

test('launchd wrapper script survives spaces and single quotes in paths', () => {
  const p = plan({ ...base, platform: 'darwin', uid: 1, nodePath: "/Users/o'neil/my node/node", entry: "/Users/o'neil/garnet repo/src/cli/bin.ts" });
  const script = /<string>(set -a;[^<]*)<\/string>/.exec(p.contents)?.[1];
  assert.ok(script);
  const raw = unescapeXml(script);
  // Replace the final exec with printf so we can see how sh parses the arguments.
  const probe = raw.replace(/exec (.*)$/, (_m, rest: string) => `printf '%s\\n' ${rest}`);
  const out = execFileSync('/bin/sh', ['-c', probe], { encoding: 'utf8', env: { ...process.env, GARNET_HOME: '/nonexistent' } });
  assert.deepEqual(out.trimEnd().split('\n'), [
    "/Users/o'neil/my node/node",
    '--disable-warning=ExperimentalWarning',
    "/Users/o'neil/garnet repo/src/cli/bin.ts",
    'start',
  ]);
});

test('unsupported platform returns a clear message', () => {
  const p = planService({ ...base, platform: 'win32' });
  assert.ok('unsupported' in p);
  assert.match(p.unsupported, /not supported yet/);
  assert.match(p.unsupported, /garnet start/);
});

test('defaultEntry points at src/cli/bin.ts', () => {
  const e = defaultEntry();
  assert.ok(e.endsWith(join('src', 'cli', 'bin.ts')));
  assert.ok(existsSync(e));
});

type Calls = string[];
function fakeRun(calls: Calls, results: Record<string, CommandResult> = {}) {
  return async (cmd: string[]): Promise<CommandResult> => {
    calls.push(cmd.join(' '));
    return results[cmd.join(' ')] ?? { code: 0, stdout: '', stderr: '' };
  };
}

function tempPlan(): { root: string; p: ServicePlan } {
  const root = mkdtempSync(join(tmpdir(), 'garnet-service-'));
  const p = plan({ ...base, platform: 'linux', home: join(root, 'garnet-home'), userHome: join(root, 'user') });
  return { root, p };
}

test('install writes files with correct modes and runs commands in order', async () => {
  const { root, p } = tempPlan();
  try {
    const calls: Calls = [];
    const r = await installService(p, { run: fakeRun(calls) });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(p.path, 'utf8'), p.contents);
    assert.equal(statSync(p.path).mode & 0o777, 0o644);
    const envFile = join(p.home, 'env');
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    assert.match(readFileSync(envFile, 'utf8'), /^# .*KEY=value/);
    assert.ok(statSync(join(p.home, 'logs')).isDirectory());
    assert.deepEqual(calls, ['systemctl --user daemon-reload', 'systemctl --user enable garnet.service', 'systemctl --user restart garnet.service']);
    assert.equal(statSync(p.home).mode & 0o777, 0o700, 'GARNET_HOME holds secrets');
    assert.deepEqual(r.files, [p.path, envFile]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('install does not overwrite an existing env file', async () => {
  const { root, p } = tempPlan();
  try {
    await installService(p, { run: fakeRun([]) });
    const envFile = join(p.home, 'env');
    writeFileSync(envFile, 'ANTHROPIC_API_KEY=secret\n');
    const r = await installService(p, { run: fakeRun([]) });
    assert.equal(readFileSync(envFile, 'utf8'), 'ANTHROPIC_API_KEY=secret\n');
    assert.deepEqual(r.files, [p.path]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing systemd user bus gets an explanatory note', async () => {
  const { root, p } = tempPlan();
  try {
    const noBus: CommandResult = { code: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
    const r = await installService(p, { run: fakeRun([], { 'systemctl --user daemon-reload': noBus }) });
    assert.equal(r.ok, false);
    assert.ok(r.notes.some((n) => /no user session/.test(n) && /garnet start/.test(n)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing command is reported, not thrown', async () => {
  const { root, p } = tempPlan();
  try {
    const calls: Calls = [];
    const failing: CommandResult = { code: 5, stdout: '', stderr: 'Failed to connect to bus' };
    const r = await installService(p, { run: fakeRun(calls, { 'systemctl --user daemon-reload': failing }) });
    assert.equal(r.ok, false);
    assert.equal(r.commands[0]?.code, 5);
    assert.equal(r.commands[0]?.stderr, 'Failed to connect to bus');
    assert.equal(calls.length, 3, 'later commands still run');
    const throwing = await installService(p, {
      run: async () => {
        throw new Error('spawn failed');
      },
    });
    assert.equal(throwing.ok, false);
    assert.equal(throwing.commands[0]?.stderr, 'spawn failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('launchd reinstall unloads the old agent first; that step may fail when it is not loaded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'garnet-service-'));
  try {
    const p = plan({ ...base, platform: 'darwin', uid: 501, home: join(root, 'home'), userHome: join(root, 'user') });
    const calls: Calls = [];
    const notLoaded: CommandResult = { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process' };
    const r = await installService(p, { run: fakeRun(calls, { 'launchctl bootout gui/501/dev.garnet.agent': notLoaded }) });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['launchctl bootout gui/501/dev.garnet.agent', `launchctl bootstrap gui/501 ${p.path}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall disables the service and removes the file', async () => {
  const { root, p } = tempPlan();
  try {
    await installService(p, { run: fakeRun([]) });
    const calls: Calls = [];
    const r = await uninstallService(p, { run: fakeRun(calls) });
    assert.equal(r.ok, true);
    assert.equal(existsSync(p.path), false);
    assert.ok(existsSync(join(p.home, 'env')), 'env file is kept');
    assert.deepEqual(calls, ['systemctl --user disable --now garnet.service', 'systemctl --user daemon-reload']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('status runs the status command and reports its output', async () => {
  const { p } = tempPlan();
  const calls: Calls = [];
  const r = await serviceStatus(p, {
    run: fakeRun(calls, { 'systemctl --user status garnet.service --no-pager': { code: 3, stdout: 'inactive', stderr: '' } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.commands[0]?.stdout, 'inactive');
  assert.deepEqual(calls, ['systemctl --user status garnet.service --no-pager']);
});

test('restart uses systemctl restart or launchctl kickstart -k', async () => {
  const { p } = tempPlan();
  const calls: Calls = [];
  const r = await restartService(p, { run: fakeRun(calls, {}) });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['systemctl --user restart garnet.service']);
  const mac = plan({ ...base, platform: 'darwin', uid: 501 });
  assert.deepEqual(mac.commands.restart, [['launchctl', 'kickstart', '-k', 'gui/501/dev.garnet.agent']]);
});

test('named instances get their own unit and label, and reject unsafe names', () => {
  const p = plan({ ...base, platform: 'linux', name: 'work', home: '/home/me/.garnet-work' });
  assert.equal(p.path, '/home/me/.config/systemd/user/garnet-work.service');
  assert.ok(p.contents.includes('Description=Garnet personal agent (work)'));
  assert.ok(p.contents.includes('Environment="GARNET_HOME=/home/me/.garnet-work"'));
  assert.deepEqual(p.commands.restart, [['systemctl', '--user', 'restart', 'garnet-work.service']]);
  assert.ok(p.notes.some((n) => n.includes('journalctl --user -u garnet-work.service')));
  const mac = plan({ ...base, platform: 'darwin', uid: 501, name: 'work' });
  assert.equal(mac.path, '/home/me/Library/LaunchAgents/dev.garnet.agent.work.plist');
  assert.ok(mac.contents.includes('<string>dev.garnet.agent.work</string>'));
  assert.deepEqual(mac.commands.status, [['launchctl', 'print', 'gui/501/dev.garnet.agent.work']]);
  // "garnet" and empty mean the default instance
  assert.equal(plan({ ...base, platform: 'linux', name: 'garnet' }).path, '/home/me/.config/systemd/user/garnet.service');
  for (const bad of ['Work', '../x', 'a b', '-x', 'x'.repeat(33)]) assert.throws(() => planService({ ...base, platform: 'linux', name: bad }), /Invalid service name/);
});

test('serviceHomeOf reads GARNET_HOME back from units and plists, escapes included', () => {
  for (const home of ['/home/me/.garnet', '/h/a"b%c$d', '/h/x&y<z>']) {
    assert.equal(serviceHomeOf(plan({ ...base, platform: 'linux', home }).contents), home);
    assert.equal(serviceHomeOf(plan({ ...base, platform: 'darwin', home, uid: 1 }).contents), home);
  }
  assert.equal(serviceHomeOf('[Service]\nExecStart=x\n'), null);
});

test('resolveService finds the instance for this GARNET_HOME and refuses to take over another', () => {
  const files: Record<string, string> = {};
  const dir = '/home/me/.config/systemd/user';
  const deps = { list: (d: string) => (d === dir ? Object.keys(files) : []), read: (p: string) => files[p.slice(dir.length + 1)]! };
  const install = (name: string | undefined, home: string) => {
    const p = plan({ ...base, platform: 'linux', name, home });
    files[p.path.slice(dir.length + 1)] = p.contents;
  };
  const resolve = (home: string, name?: string) => {
    const r = resolveService({ ...base, platform: 'linux', home, ...(name !== undefined ? { name } : {}) }, deps);
    assert.ok(!('unsupported' in r));
    return r;
  };
  // Nothing installed: the default, no conflict.
  assert.equal(resolve('/a').plan.path, `${dir}/garnet.service`);
  assert.equal(resolve('/a').conflict, null);
  install(undefined, '/a');
  files['other.service'] = 'x';
  // Another home without --name would take over garnet.service: conflict.
  assert.match(resolve('/b').conflict!, /already runs GARNET_HOME=\/a.*--name/);
  assert.equal(resolve('/b', 'work').conflict, null);
  install('work', '/b');
  // Without --name, /b now resolves to its own instance; /a still to the default.
  assert.equal(resolve('/b').plan.path, `${dir}/garnet-work.service`);
  assert.equal(resolve('/a').plan.path, `${dir}/garnet.service`);
  assert.deepEqual(
    installedServices({ platform: 'linux', userHome: '/home/me' }, deps).map((s) => [s.name, s.home]),
    [
      ['work', '/b'],
      [undefined, '/a'],
    ],
  );
  assert.deepEqual(installedServices({ platform: 'win32', userHome: '/home/me' }, deps), []);
});
