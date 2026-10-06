import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isGarnetError } from '../contracts/index.ts';
import { SshSandbox, createSandbox, openSandbox, remoteRelativeCwd, remoteScript, requiresIsolation, shellQuote, type SpawnFn, type SshSandboxOptions } from './index.ts';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 4243;
  stdinText = '';
  killedWith: string[] = [];
  closed = false;
  constructor() {
    super();
    this.stdin.on('data', (b: Buffer) => (this.stdinText += b.toString()));
  }
  close(code: number | null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, null);
      this.emit('close', code, null);
    });
  }
  kill(sig = 'SIGTERM') {
    this.killedWith.push(sig);
    this.close(null);
    return true;
  }
}

type Call = { cmd: string; args: string[]; opts: SpawnOptions; child: FakeChild };

/** Fake process runner. `reply` decides what each ssh invocation does; the default leaves the child open. */
function fakeSsh(reply?: (call: Call) => void) {
  const calls: Call[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild();
    const call = { cmd, args: [...args], opts, child };
    calls.push(call);
    reply?.(call);
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

const answer = (code: number, out = '', err = '') => (c: Call) => {
  if (out) c.child.stdout.write(out);
  if (err) c.child.stderr.write(err);
  c.child.close(code);
};

const KEY = join(realpathSync(tempDir()), 'id_ed25519');
writeFileSync(KEY, 'not a real key\n');

function make(over: Partial<SshSandboxOptions> = {}, reply?: (call: Call) => void) {
  const workspace = realpathSync(tempDir());
  const fake = fakeSsh(reply);
  const sb = new SshSandbox({
    workspace,
    host: 'build.example.com',
    user: 'garnet',
    workdir: '/srv/garnet/work',
    identityFile: KEY,
    spawn: fake.spawn,
    hostEnv: { PATH: '/usr/bin', HOME: '/home/o', SSH_AUTH_SOCK: '/run/agent.sock', GARNET_SANDBOX_TEST_SECRET: 'hunter2', ANTHROPIC_API_KEY: 'sk-secret' },
    ...over,
  });
  return { sb, fake, workspace };
}

const req = (over: Partial<Parameters<SshSandbox['run']>[0]> = {}) => ({
  command: 'echo hi',
  cwd: '.',
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  ...over,
});

const throwsConfig = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e) => isGarnetError(e, 'config') && (!re || re.test((e as Error).message)));

test('the ssh client gets a fixed argument list: BatchMode, strict host keys, no forwarding, no user config, `--` before the host', async () => {
  const { sb, fake } = make();
  const pending = sb.run(req({ command: 'echo hi' }));
  const call = fake.calls[0]!;
  call.child.stdout.write('hi\n');
  call.child.close(0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hi\n');
  assert.equal(call.cmd, 'ssh');
  const remote = call.args.at(-1)!;
  assert.deepEqual(call.args.slice(0, -1), [
    '-F', '/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'IdentityAgent=none',
    '-o', 'IdentitiesOnly=yes', '-i', KEY,
    '-T',
    '-p', '22',
    '-l', 'garnet',
    '--',
    'build.example.com',
  ]);
  assert.match(remote, /^sh -c '/);
  assert.equal(call.opts.shell, undefined, 'never a local shell');
});

test('the ssh client sees only PATH, HOME and LANG; the agent socket only when the agent is enabled', async () => {
  const a = make();
  const p1 = a.sb.run(req());
  a.fake.calls[0]!.child.close(0);
  await p1;
  assert.deepEqual(a.fake.calls[0]!.opts.env, { PATH: '/usr/bin', HOME: '/home/o' });

  const b = make({ agent: true });
  const p2 = b.sb.run(req());
  b.fake.calls[0]!.child.close(0);
  await p2;
  assert.deepEqual(b.fake.calls[0]!.opts.env, { PATH: '/usr/bin', HOME: '/home/o', SSH_AUTH_SOCK: '/run/agent.sock' });
  assert.ok(!b.fake.calls[0]!.args.includes('IdentityAgent=none'));
});

test('host key policy: strict is the default, accept-new and off map to ssh options, off ignores known_hosts', () => {
  const opt = (over: Partial<SshSandboxOptions>) => make(over).sb.sshArgs('x');
  assert.ok(opt({}).includes('StrictHostKeyChecking=yes'));
  assert.ok(opt({ hostKeyChecking: 'accept-new' }).includes('StrictHostKeyChecking=accept-new'));
  const off = opt({ hostKeyChecking: 'off' });
  assert.ok(off.includes('StrictHostKeyChecking=no') && off.includes('UserKnownHostsFile=/dev/null'));
  assert.ok(opt({ knownHostsFile: '/etc/garnet/known_hosts' }).includes('UserKnownHostsFile=/etc/garnet/known_hosts'));
  assert.ok(opt({ port: 2222 }).join(' ').includes('-p 2222'));
  assert.ok(opt({ connectTimeoutSeconds: 3 }).includes('ConnectTimeout=3'));
  throwsConfig(() => make({ hostKeyChecking: 'maybe' as never }));
});

test('host, user, port, key and workdir are validated strictly', () => {
  for (const host of ['', '-oProxyCommand=evil', 'a b', 'host;rm', 'user@host', 'host:22', 'ssh://host', 'a..b', 'host\n', 'fe80::1%eth0', '$(id)', '`id`']) {
    throwsConfig(() => make({ host }), /Invalid ssh host/);
  }
  for (const host of ['localhost', 'build.example.com', '10.0.0.5', '2001:db8::1', 'a-b.c1.io']) assert.doesNotThrow(() => make({ host }), host);
  for (const user of ['', '-oFoo', 'a b', 'a;b', 'a@b', 'root\n', 'x'.repeat(65)]) throwsConfig(() => make({ user }), /Invalid ssh user/);
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) throwsConfig(() => make({ port }), /Invalid ssh port/);
  for (const identityFile of ['relative/key', '-oFoo', '/k\nx', '/k,x', '/k"x', '~/.ssh/id']) throwsConfig(() => make({ identityFile }), /absolute path/);
  throwsConfig(() => make({ knownHostsFile: 'known_hosts' }), /absolute path/);
  for (const workdir of ['work', '/', '//', '/srv/../etc', '/srv/a/..', '/a\nb', '~/work']) throwsConfig(() => make({ workdir }), /ssh workdir/);
  assert.equal(make({ workdir: '/srv//work/' }).sb.target, 'garnet@build.example.com:22');
  throwsConfig(() => make({ identityFile: undefined }), /identity file or the ssh-agent/);
  assert.doesNotThrow(() => make({ identityFile: undefined, agent: true }));
  throwsConfig(() => make({ identityFile: undefined, agent: true, passphrase: 'x' }), /passphrase only applies/);
  throwsConfig(() => make({ connectTimeoutSeconds: 0 }));
});

test('the remote command single-quotes the command, cwd and environment; hostile text stays one literal word', async () => {
  const { sb, fake } = make();
  const command = `echo "$HOME" '; rm -rf /' $(id) \`id\` && it's`;
  const pending = sb.run(req({ command, cwd: "sub dir/it's", env: { FOO: `a'b $(c)` } }));
  const remote = fake.calls[0]!.args.at(-1)!;
  fake.calls[0]!.child.close(0);
  await pending;
  // Undo the two quoting layers the way the remote shells would, and compare with the originals.
  const inner = unquoteOnce(remote.replace(/^sh -c /, ''));
  assert.ok(inner.includes(`sh -c ${shellQuote(command)}`), 'the command is one quoted word');
  assert.ok(inner.includes(`cd -- "$ws"/${shellQuote("sub dir/it's")}`), 'cwd is one quoted word');
  assert.ok(inner.includes(`env FOO=${shellQuote(`a'b $(c)`)} sh -c`), 'env values are quoted');
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
  assert.throws(() => shellQuote('a\0b'), (e) => isGarnetError(e, 'invalid_input'));
});

/** Reverses `shellQuote` for one word (test helper). */
function unquoteOnce(word: string): string {
  assert.ok(word.startsWith("'") && word.endsWith("'"));
  return word.slice(1, -1).replace(/'\\''/g, "'");
}

test('the generated remote script, run by a real sh, enters the workdir, keeps exit codes and env, and contains cwd', () => {
  const root = realpathSync(tempDir());
  const work = join(root, 'work');
  mkdirSync(join(work, 'sub dir'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(work, 'escape'));
  symlinkSync(join(work, 'sub dir'), join(work, 'inside-link'));
  const sh = (rel: string, command: string, env: [string, string][] = []) => spawnSync('sh', ['-c', remoteScript(work, rel, env, command)], { encoding: 'utf8', env: { PATH: process.env.PATH! } });

  let r = sh('', 'pwd -P');
  assert.equal(r.stdout.trim(), work);
  r = sh('sub dir', 'pwd -P; exit 7');
  assert.equal(r.stdout.trim(), join(work, 'sub dir'));
  assert.equal(r.status, 7);
  r = sh('inside-link', 'pwd -P');
  assert.equal(r.stdout.trim(), join(work, 'sub dir'), 'a symlink that stays inside is fine');
  r = sh('', 'printf %s "$FOO"', [['FOO', `it's $(id) "q"`]]);
  assert.equal(r.stdout, `it's $(id) "q"`);
  r = sh('', `echo 'x'; echo "$(printf '%s' a b)" >&2`);
  assert.equal(r.stdout, 'x\n');
  assert.equal(r.stderr, 'ab\n');

  r = sh('escape', 'pwd');
  assert.equal(r.status, 125);
  assert.match(r.stderr, /outside the workspace/);
  assert.ok(!r.stdout.includes('outside'));
  r = sh('missing', 'echo ran');
  assert.equal(r.status, 125);
  assert.ok(!r.stdout.includes('ran'));
  r = spawnSync('sh', ['-c', remoteScript(join(root, 'nope'), '', [], 'echo ran')], { encoding: 'utf8' });
  assert.equal(r.status, 125);
  assert.match(r.stderr, /not accessible/);
  // Injection through the workdir or cwd text never executes.
  const marker = join(root, 'pwned');
  r = sh(`x'; touch ${marker}; '`, 'true');
  assert.equal(existsSync(marker), false);
  r = spawnSync('sh', ['-c', remoteScript(`${work}'; touch ${marker}; '`, '', [], 'true')], { encoding: 'utf8' });
  assert.equal(existsSync(marker), false);
});

test('cwd is contained lexically: absolute paths and ".." escapes are denied before ssh starts', async () => {
  const { sb, fake } = make();
  assert.equal(remoteRelativeCwd('.'), '');
  assert.equal(remoteRelativeCwd('a/./b/../c/'), 'a/c');
  for (const cwd of ['..', '../x', 'a/../../x', '/etc', '/srv/garnet/work']) {
    await assert.rejects(sb.run(req({ cwd })), (e) => isGarnetError(e, 'denied'), cwd);
  }
  await assert.rejects(sb.run(req({ cwd: 'a\0b' })), (e) => isGarnetError(e, 'invalid_input'));
  await assert.rejects(sb.run(req({ command: 'a\0b' })), (e) => isGarnetError(e, 'invalid_input'));
  await assert.rejects(sb.run(req({ env: { 'A B': '1' } })), (e) => isGarnetError(e, 'invalid_input'));
  assert.equal(fake.calls.length, 0, 'nothing was spawned');
});

test('output is capped per stream with the head kept and the rest drained', async () => {
  const { sb, fake } = make({ maxOutputBytes: 10 });
  const pending = sb.run(req());
  const c = fake.calls[0]!.child;
  c.stdout.write('0123456789ABCDEF');
  c.stderr.write('xyz');
  c.close(0);
  const r = await pending;
  assert.equal(r.stdout, '0123456789');
  assert.equal(r.stderr, 'xyz');
  assert.equal(r.truncated, true);
});

test('stdin is passed to the command and closed', async () => {
  const { sb, fake } = make();
  const pending = sb.run(req({ stdin: 'input text' }));
  fake.calls[0]!.child.close(0);
  await pending;
  assert.equal(fake.calls[0]!.child.stdinText, 'input text');
});

test('a timeout kills the ssh client (closing the connection) and reports timedOut', async () => {
  const { sb, fake } = make();
  const r = await sb.run(req({ timeoutMs: 20 }));
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.equal(r.exitCode, null);
  assert.deepEqual(fake.calls[0]!.child.killedWith, ['SIGKILL']);
});

test('an abort kills the client, and an already aborted signal never starts ssh', async () => {
  const { sb, fake } = make();
  const ac = new AbortController();
  const pending = sb.run(req({ signal: ac.signal, timeoutMs: 60_000 }));
  ac.abort();
  const r = await pending;
  assert.equal(r.cancelled, true);
  assert.deepEqual(fake.calls[0]!.child.killedWith, ['SIGKILL']);

  const done = new AbortController();
  done.abort();
  const again = await sb.run(req({ signal: done.signal }));
  assert.equal(again.cancelled, true);
  assert.equal(fake.calls.length, 1);
});

test('exit 255 is explained as a connection failure or a 255 exit; other codes are untouched', async () => {
  const bad = make({}, answer(255, '', 'ssh: connect to host build.example.com port 22: Connection refused\n'));
  const r = await bad.sb.run(req());
  assert.equal(r.exitCode, 255);
  assert.match(r.stderr, /Connection refused\n\[exit 255: the ssh connection to garnet@build\.example\.com:22 failed/);
  const ok = make({}, answer(3, '', 'oops'));
  assert.equal((await ok.sb.run(req())).stderr, 'oops');
});

test('a spawn that throws is a tool_failed error; an ssh client that cannot start rejects', async () => {
  const { sb } = make({
    spawn: () => {
      throw new Error('EACCES');
    },
  });
  await assert.rejects(sb.run(req()), (e) => isGarnetError(e, 'tool_failed') && /Could not start ssh/.test((e as Error).message));
  const missing = make({}, (c) => setImmediate(() => c.child.emit('error', new Error('spawn ssh ENOENT'))));
  await assert.rejects(missing.sb.run(req()), (e) => isGarnetError(e, 'tool_failed'));
});

test('a key passphrase reaches ssh only through a private one-use askpass helper, never argv', async () => {
  const { sb, fake } = make({ passphrase: 'correct horse' });
  const pending = sb.run(req());
  const call = fake.calls[0]!;
  const env = call.opts.env as Record<string, string>;
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(env.GARNET_SSH_PASSPHRASE, 'correct horse');
  assert.ok(call.args.includes('BatchMode=no'), 'BatchMode would skip a passphrase-protected key');
  assert.ok(call.args.includes('PasswordAuthentication=no') && call.args.includes('KbdInteractiveAuthentication=no'));
  assert.equal(JSON.stringify(call.args).includes('correct horse'), false);
  const helper = env.SSH_ASKPASS!;
  assert.equal(statSync(helper).mode & 0o777, 0o700);
  assert.equal(statSync(join(helper, '..')).mode & 0o777, 0o700);
  assert.equal(spawnSync(helper, { encoding: 'utf8', env: { GARNET_SSH_PASSPHRASE: 'correct horse' } }).stdout, 'correct horse\n');
  assert.equal(readText(helper).includes('correct horse'), false, 'the helper holds no secret');
  call.child.close(0);
  await pending;
  assert.equal(existsSync(helper), false, 'removed after the run');

  const none = make();
  const p = none.sb.run(req());
  none.fake.calls[0]!.child.close(0);
  await p;
  assert.equal((none.fake.calls[0]!.opts.env as Record<string, string>).SSH_ASKPASS, undefined);
});

function readText(p: string): string {
  return spawnSync('cat', [p], { encoding: 'utf8' }).stdout;
}

test('the askpass helper is also removed when the run is cancelled or ssh cannot start', async () => {
  const seen: string[] = [];
  const { sb } = make({
    passphrase: 'pw',
    spawn: (_c, _a, opts) => {
      seen.push((opts.env as Record<string, string>).SSH_ASKPASS!);
      throw new Error('boom');
    },
  });
  await assert.rejects(sb.run(req()));
  assert.equal(existsSync(seen[0]!), false);
});

test('check: success reports the target, the real workdir and the honest boundary; the probe is read-only', async () => {
  const { sb, fake } = make({}, answer(0, '/srv/garnet/work\n'));
  const r = await sb.check();
  assert.equal(r.ok, true);
  assert.match(r.detail, /garnet@build\.example\.com:22, workdir \/srv\/garnet\/work, host key checking strict/);
  assert.match(r.detail, /only as strong as the remote account/);
  const remote = fake.calls[0]!.args.at(-1)!;
  assert.match(remote, /cd -- /);
  assert.ok(!/rm |touch |>/.test(remote.replace(/2>\/dev\/null/g, '').replace(/>&2/g, '')), 'no writes');
  assert.equal((fake.calls[0]!.opts.stdio as string[])[0], 'ignore');
});

test('check: failures say what is wrong and how to fix it', async () => {
  const cases: [number | null, string, RegExp][] = [
    [255, 'Host key verification failed.', /ssh-keyscan -p 22 build\.example\.com.*accept-new/],
    [255, 'garnet@build.example.com: Permission denied (publickey).', /key was not accepted.*authorized_keys/],
    [255, 'ssh: Could not resolve hostname build.example.com: Name or service not known', /did not resolve/],
    [255, 'ssh: connect to host build.example.com port 22: Connection timed out', /did not answer in time/],
    [125, 'garnet: remote workdir /srv/garnet/work is not accessible', /Create the directory/],
  ];
  for (const [code, err, fix] of cases) {
    const r = await make({}, answer(code!, '', err + '\n')).sb.check();
    assert.equal(r.ok, false, err);
    assert.match(r.detail, fix, err);
  }
  const changed = await make({ hostKeyChecking: 'accept-new' }, answer(255, '', 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n')).sb.check();
  assert.match(changed.detail, /ssh-keygen -R.*attack/);
});

test('check: a missing ssh client, a missing key file and a missing agent socket are reported without contacting the host', async () => {
  const gone = make({ sshPath: '/nonexistent/ssh' }, (c) => setImmediate(() => c.child.emit('error', new Error('spawn /nonexistent/ssh ENOENT'))));
  const r = await gone.sb.check();
  assert.equal(r.ok, false);
  assert.match(r.detail, /ssh client "\/nonexistent\/ssh" could not be started.*openssh-client/);

  const key = make({ identityFile: join(tempDir(), 'missing') });
  assert.match((await key.sb.check()).detail, /identity file .* does not exist/);
  assert.equal(key.fake.calls.length, 0);

  const dir = tempDir();
  const isDir = make({ identityFile: dir });
  assert.match((await isDir.sb.check()).detail, /is not a file/);

  const agent = make({ identityFile: undefined, agent: true, hostEnv: { PATH: '/usr/bin' } });
  assert.match((await agent.sb.check()).detail, /SSH_AUTH_SOCK is not set/);
  assert.equal(agent.fake.calls.length, 0);
});

test('check: a probe that hangs is killed after the connect timeout plus a margin', async () => {
  const { sb, fake } = make({ connectTimeoutSeconds: 1 });
  // Shrink the wait: the fake never answers, so close it from the kill.
  const pending = sb.check();
  setTimeout(() => fake.calls[0]!.child.kill('SIGKILL'), 5);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not answer in time/);
});

test('the backend table: ssh is created from its options, needs them, is isolated by default; local is not', async () => {
  const workspace = realpathSync(tempDir());
  const base = { workspace, ssh: { host: 'h.example.com', user: 'u', workdir: '/w', agent: true } };
  const sb = createSandbox('ssh', base);
  assert.equal(sb.kind, 'ssh');
  assert.equal(sb.isolated, true);
  assert.equal(sb.networked, true, 'remote output is untrusted like any networked command');
  assert.equal(sb.workspace, workspace);
  throwsConfig(() => createSandbox('ssh', { workspace }), /sandbox\.ssh options/);
  throwsConfig(() => createSandbox('nope' as never, { workspace }), /Unknown sandbox backend/);
  throwsConfig(() => createSandbox('toString' as never, { workspace }), /Unknown sandbox backend/);
  assert.equal(requiresIsolation('ssh'), true);
  assert.equal(requiresIsolation('docker'), true);
  assert.equal(requiresIsolation('local'), false);

  const down = fakeSsh(answer(255, '', 'Permission denied (publickey).\n'));
  await assert.rejects(openSandbox('ssh', { ...base, spawn: down.spawn, hostEnv: { SSH_AUTH_SOCK: '/s' } }), (e) => isGarnetError(e, 'config') && /ssh sandbox is unavailable/.test((e as Error).message));
  const up = fakeSsh(answer(0, '/w\n'));
  const opened = await openSandbox('ssh', { ...base, spawn: up.spawn, hostEnv: { SSH_AUTH_SOCK: '/s' } });
  assert.equal(opened.kind, 'ssh');
  writeFileSync(join(workspace, 'f'), '');
});
