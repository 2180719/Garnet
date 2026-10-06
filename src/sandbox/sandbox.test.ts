import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isRubyError } from '../contracts/index.ts';
import { DockerSandbox, LocalSandbox, OutputCollector, assertSandboxReady, createSandbox, openSandbox, type SpawnFn } from './index.ts';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  pid = 4242;
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

/** A fake `spawn`: `docker run` children stay open until killed; `docker kill <name>` closes the matching run. */
function fakeDocker(behavior: { version?: number; image?: number; killFailures?: number } = {}) {
  const calls: Call[] = [];
  const runs = new Map<string, FakeChild>();
  let killFailures = behavior.killFailures ?? 0;
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild();
    calls.push({ cmd, args: [...args], opts, child });
    const [sub] = args;
    if (sub === 'run') runs.set(args[args.indexOf('--name') + 1]!, child);
    else if (sub === 'kill') {
      const run = runs.get(args[1]!);
      if (killFailures > 0) {
        killFailures--;
        child.stderr.write('No such container');
        child.close(1);
      } else {
        child.close(0);
        run?.close(137);
      }
    } else if (sub === 'version') {
      child.stdout.write('29.0.0\n');
      child.close(behavior.version ?? 0);
    } else if (sub === 'image') child.close(behavior.image ?? 0);
    else child.close(0);
    return child as unknown as ChildProcess;
  };
  const runCall = () => calls.find((c) => c.args[0] === 'run')!;
  const sub = (name: string) => calls.filter((c) => c.args[0] === name);
  return { spawn, calls, runCall, sub };
}

const req = (over: Partial<Parameters<DockerSandbox['run']>[0]> = {}) => ({
  command: 'echo hi',
  cwd: '.',
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  ...over,
});

test('docker run uses the full lockdown flag set, an args array and no host environment', async () => {
  const workspace = realpathSync(tempDir());
  mkdirSync(join(workspace, 'sub'));
  process.env.RUBY_SANDBOX_TEST_SECRET = 'hunter2';
  const fake = fakeDocker();
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn, image: 'busybox:latest', user: '1000:1000' });
  const command = `echo "$RUBY_SANDBOX_TEST_SECRET" '; rm -rf /' $(id)`;
  const pending = sb.run(req({ command, cwd: 'sub', env: { FOO: 'bar baz' } }));
  const run = fake.runCall();
  run.child.stdout.write('out');
  run.child.close(0);
  const result = await pending;
  delete process.env.RUBY_SANDBOX_TEST_SECRET;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(run.cmd, 'docker');
  const name = run.args[run.args.indexOf('--name') + 1]!;
  assert.match(name, /^ruby-exec-[0-9a-f]{16}$/);
  assert.deepEqual(run.args, [
    'run', '--rm', '-i',
    '--name', name,
    '--label', `ruby.exec.workspace=${workspace}`,
    '--pull', 'never',
    '--network', 'none',
    '--memory', '512m',
    '--memory-swap', '512m',
    '--cpus', '1',
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '--user', '1000:1000',
    '--hostname', 'sandbox',
    '--log-driver', 'none',
    '-v', `${workspace}:/workspace:rw`,
    '-w', '/workspace/sub',
    '-e', 'HOME=/tmp',
    '-e', 'FOO=bar baz',
    'busybox:latest',
    'sh', '-c', command,
  ]);
  // The command is one argv element, never interpreted by a host shell.
  assert.equal(run.opts.shell, undefined);
  // The docker client gets an allowlisted environment; the secret appears nowhere.
  assert.equal(JSON.stringify(run.opts.env).includes('hunter2'), false);
  assert.equal(Object.keys(run.opts.env ?? {}).some((k) => k.startsWith('RUBY_')), false);
  // Every -e is NAME=value (a bare -e NAME would copy from the client's environment).
  run.args.forEach((a, i) => {
    if (a === '-e') assert.match(run.args[i + 1]!, /^[A-Za-z_][A-Za-z0-9_]*=/);
  });
  assert.equal(fake.sub('kill').length, 0);
});

test('docker user defaults to the host uid:gid', async () => {
  const workspace = tempDir();
  const fake = fakeDocker();
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn });
  const pending = sb.run(req());
  fake.runCall().child.close(0);
  await pending;
  const args = fake.runCall().args;
  assert.equal(args[args.indexOf('--user') + 1], `${process.getuid!()}:${process.getgid!()}`);
  assert.ok(args.includes('debian:stable-slim'));
});

test('cwd escapes, missing directories, bad env names and bad workspaces are rejected before docker runs', async () => {
  const workspace = tempDir();
  const outside = tempDir();
  symlinkSync(outside, join(workspace, 'link'));
  const fake = fakeDocker();
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn });
  const rejects = async (over: Parameters<typeof req>[0], category: string) =>
    assert.rejects(sb.run(req(over)), (e) => isRubyError(e) && e.category === category);
  await rejects({ cwd: '../' }, 'denied');
  await rejects({ cwd: '/etc' }, 'denied');
  await rejects({ cwd: 'link' }, 'denied');
  await rejects({ cwd: 'nope' }, 'invalid_input');
  await rejects({ env: { 'A=B': 'x' } }, 'invalid_input');
  await rejects({ env: { A: 'x\0y' } }, 'invalid_input');
  assert.equal(fake.calls.length, 0);

  const colon = join(tempDir(), 'a:b');
  mkdirSync(colon);
  assert.throws(() => new DockerSandbox({ workspace: colon }), (e) => isRubyError(e, 'config'));
  const comma = join(tempDir(), 'a,b');
  mkdirSync(comma);
  assert.throws(() => new DockerSandbox({ workspace: comma }), (e) => isRubyError(e, 'config'));
  assert.throws(() => new DockerSandbox({ workspace: '/' }), (e) => isRubyError(e, 'config'));
  assert.throws(() => new DockerSandbox({ workspace: 'relative' }), (e) => isRubyError(e, 'config'));
  assert.throws(() => new DockerSandbox({ workspace, image: '--privileged' }), (e) => isRubyError(e, 'config'));
  assert.throws(() => new DockerSandbox({ workspace, network: 'host' as 'none' }), (e) => isRubyError(e, 'config'));
});

test('output is capped per stream, keeps the head and keeps draining', async () => {
  const workspace = tempDir();
  const fake = fakeDocker();
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn, maxOutputBytes: 10 });
  const pending = sb.run(req({ stdin: 'input data' }));
  const child = fake.runCall().child;
  child.stdout.write('0123456789abcdef');
  child.stdout.write('more');
  child.stderr.write('short');
  child.close(3);
  const r = await pending;
  assert.equal(r.stdout, '0123456789');
  assert.equal(r.stderr, 'short');
  assert.equal(r.truncated, true);
  assert.equal(r.exitCode, 3);
  assert.equal(child.stdinText, 'input data');

  const c = new OutputCollector(4);
  c.push('ab');
  c.push('cd');
  assert.equal(c.truncated, false);
  c.push('e');
  assert.equal(c.truncated, true);
  assert.equal(c.text(), 'abcd');
});

test('timeout runs docker kill on the container, retrying until it exists, then removes it', async () => {
  const workspace = tempDir();
  const fake = fakeDocker({ killFailures: 1 });
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn });
  const r = await sb.run(req({ command: 'sleep 30', timeoutMs: 50 }));
  const name = fake.runCall().args[fake.runCall().args.indexOf('--name') + 1];
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.equal(fake.sub('kill').length, 2, 'first kill failed (container not created yet), second succeeded');
  assert.ok(fake.sub('kill').every((c) => c.args[1] === name));
  assert.deepEqual(fake.sub('rm').map((c) => c.args), [['rm', '-f', name]]);
  assert.deepEqual(fake.runCall().child.killedWith, [], 'the client is not killed while docker kill can work');
});

test('abort kills the container; an already-aborted signal never starts one', async () => {
  const workspace = tempDir();
  const fake = fakeDocker();
  const sb = new DockerSandbox({ workspace, spawn: fake.spawn });
  const ac = new AbortController();
  const pending = sb.run(req({ signal: ac.signal }));
  ac.abort();
  const r = await pending;
  assert.equal(r.cancelled, true);
  assert.equal(fake.sub('kill').length, 1);

  const fresh = fakeDocker();
  const sb2 = new DockerSandbox({ workspace, spawn: fresh.spawn });
  const r2 = await sb2.run(req({ signal: AbortSignal.abort() }));
  assert.equal(r2.cancelled, true);
  assert.equal(fresh.calls.length, 0);
});

test('check reports docker and image problems; isolated sandboxes never fall back', async () => {
  const workspace = tempDir();
  const down = new DockerSandbox({ workspace, spawn: fakeDocker({ version: 1 }).spawn });
  assert.equal((await down.check()).ok, false);
  await assert.rejects(assertSandboxReady(down), (e) => isRubyError(e, 'config'));
  const noImage = new DockerSandbox({ workspace, image: 'busybox', spawn: fakeDocker({ image: 1 }).spawn });
  const status = await noImage.check();
  assert.equal(status.ok, false);
  assert.match(status.detail, /docker pull busybox/);
  const up = new DockerSandbox({ workspace, spawn: fakeDocker().spawn });
  assert.equal((await up.check()).ok, true);

  await assert.rejects(openSandbox('docker', { workspace, spawn: fakeDocker({ version: 1 }).spawn }), (e) => isRubyError(e, 'config'));
  await assert.rejects(openSandbox('local', { workspace }, { requireIsolated: true }), (e) => isRubyError(e, 'config'));
  assert.equal((await openSandbox('local', { workspace })).isolated, false);
  assert.equal(createSandbox('docker', { workspace, spawn: fakeDocker().spawn }).isolated, true);
  // A missing docker binary is a check failure, not a crash.
  const missing = new DockerSandbox({ workspace, dockerPath: '/nonexistent/docker' });
  assert.equal((await missing.check()).ok, false);
});

test('local sandbox runs in the workspace with a minimal environment', async () => {
  const workspace = realpathSync(tempDir());
  mkdirSync(join(workspace, 'sub'));
  process.env.RUBY_SANDBOX_TEST_SECRET = 'hunter2';
  const sb = new LocalSandbox({ workspace });
  const r = await sb.run(req({ command: 'pwd; echo "[$RUBY_SANDBOX_TEST_SECRET]"; echo "$HOME"; echo $X; exit 4', cwd: 'sub', env: { X: 'y' } }));
  delete process.env.RUBY_SANDBOX_TEST_SECRET;
  assert.equal(r.exitCode, 4);
  assert.equal(r.stdout, `${join(workspace, 'sub')}\n[]\n${workspace}\ny\n`);
  await assert.rejects(sb.run(req({ cwd: '..' })), (e) => isRubyError(e, 'denied'));
});

test('local sandbox timeout kills the whole process group promptly', async () => {
  const workspace = tempDir();
  const sb = new LocalSandbox({ workspace });
  const started = Date.now();
  // A background grandchild holding stdout open must not keep run() waiting.
  const r = await sb.run(req({ command: 'sleep 30 & sleep 30; echo never', timeoutMs: 300 }));
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5_000, 'killed promptly');
  assert.equal(r.stdout, '');

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const c = await sb.run(req({ command: 'sleep 30', signal: ac.signal }));
  assert.equal(c.cancelled, true);

  // A finished command does not leave background jobs behind holding the pipes.
  const bg = Date.now();
  const done = await sb.run(req({ command: 'sleep 30 & echo started' }));
  assert.equal(done.stdout, 'started\n');
  assert.ok(Date.now() - bg < 5_000);
});
