// Integration tests against a real Docker daemon. They skip (with the reason)
// when Docker or the test image is unavailable, so the suite stays offline-safe.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chownSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { before, test, type TestContext } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { DockerSandbox } from './index.ts';

const IMAGE = 'busybox:latest';
let unavailable: string | null = null;

before(() => {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
  if (version.status !== 0) {
    unavailable = `Docker daemon not available (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})`;
    return;
  }
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { timeout: 15_000 }).status === 0) return;
  const pull = spawnSync('docker', ['pull', IMAGE], { encoding: 'utf8', timeout: 60_000 });
  if (pull.status !== 0) unavailable = `image ${IMAGE} not present and could not be pulled (${(pull.stderr || 'timeout').trim().split('\n').pop()})`;
});

function setup(t: TestContext): { sb: DockerSandbox; workspace: string } | null {
  if (unavailable) {
    t.skip(unavailable);
    return null;
  }
  const workspace = tempDir('ruby-docker-');
  // As root, hand the workspace to a regular user the way an owner would; the sandbox then runs as that user.
  if (process.getuid!() === 0) chownSync(workspace, 1000, 1000);
  return { sb: new DockerSandbox({ workspace, image: IMAGE }), workspace };
}

const req = (command: string, over: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; stdin?: string } = {}) => ({
  command,
  cwd: over.cwd ?? '.',
  timeoutMs: over.timeoutMs ?? 20_000,
  signal: over.signal ?? new AbortController().signal,
  ...(over.stdin !== undefined ? { stdin: over.stdin } : {}),
});

function leftovers(): string[] {
  return execFileSync('docker', ['ps', '-a', '--filter', 'name=ruby-exec-', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

test('docker: output, exit code, stdin and a clean environment', async (t) => {
  const s = setup(t);
  if (!s) return;
  const status = await s.sb.check();
  assert.equal(status.ok, true, status.detail);
  const r = await s.sb.run(req('echo hello; echo oops >&2; cat; env | sort; exit 7', { stdin: 'piped\n' }));
  assert.equal(r.exitCode, 7);
  assert.match(r.stdout, /^hello\npiped\n/);
  assert.equal(r.stderr, 'oops\n');
  const envNames = r.stdout.split('\n').slice(2).filter(Boolean).map((l) => l.split('=')[0]).sort();
  assert.deepEqual(envNames, ['HOME', 'HOSTNAME', 'PATH', 'PWD', 'SHLVL']);
});

test('docker: never root; files written in /workspace belong to the workspace owner', async (t) => {
  const s = setup(t);
  if (!s) return;
  const r = await s.sb.run(req('mkdir -p sub && echo data > sub/out.txt && id -u && id -g'));
  assert.equal(r.exitCode, 0, r.stderr);
  const file = join(s.workspace, 'sub', 'out.txt');
  assert.equal(readFileSync(file, 'utf8'), 'data\n');
  // Ruby as a regular user: its own uid. Ruby as root: the (non-root) workspace owner, never 0.
  const owner = process.getuid!() === 0 ? statSync(s.workspace).uid : process.getuid!();
  assert.notEqual(owner, 0);
  assert.equal(statSync(file).uid, owner);
  assert.deepEqual(r.stdout.trim().split('\n'), s.sb.containerUser.split(':'));
  assert.equal(r.stdout.trim().split('\n')[0], String(owner));
  const inSub = await s.sb.run(req('pwd; cat out.txt', { cwd: 'sub' }));
  assert.equal(inSub.stdout, '/workspace/sub\ndata\n');
});

test('docker: no network, read-only root, no capabilities, no new privileges', async (t) => {
  const s = setup(t);
  if (!s) return;
  const net = await s.sb.run(req('ls /sys/class/net; wget -q -T 3 -O- http://1.1.1.1/ >/dev/null 2>&1; echo "wget=$?"'));
  assert.equal(net.stdout, 'lo\nwget=1\n');
  const fs = await s.sb.run(
    req('touch /etc/x 2>/dev/null; echo "etc=$?"; touch /x 2>/dev/null; echo "root=$?"; touch /tmp/x; echo "tmp=$?"; touch /workspace/x; echo "ws=$?"'),
  );
  assert.equal(fs.stdout, 'etc=1\nroot=1\ntmp=0\nws=0\n');
  const caps = await s.sb.run(req('grep -E "^(CapEff|CapBnd|NoNewPrivs)" /proc/self/status'));
  assert.match(caps.stdout, /CapEff:\s+0000000000000000/);
  assert.match(caps.stdout, /CapBnd:\s+0000000000000000/);
  assert.match(caps.stdout, /NoNewPrivs:\s+1/);
  const host = await s.sb.run(req(`ls ${JSON.stringify(import.meta.dirname)} 2>&1; echo "rc=$?"`));
  assert.match(host.stdout, /rc=1/, 'host paths outside the workspace are not visible');
});

test('docker: timeout kills the container promptly and leaves nothing behind', async (t) => {
  const s = setup(t);
  if (!s) return;
  const started = Date.now();
  const r = await s.sb.run(req('echo started; sleep 30; echo never', { timeoutMs: 1_000 }));
  const elapsed = Date.now() - started;
  assert.equal(r.timedOut, true);
  assert.equal(r.stdout, 'started\n');
  assert.ok(elapsed < 8_000, `killed after ${elapsed}ms`);
  assert.deepEqual(leftovers(), []);
});

test('docker: abort kills the container, including during startup', async (t) => {
  const s = setup(t);
  if (!s) return;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1_000);
  const r = await s.sb.run(req('sleep 30', { signal: ac.signal }));
  assert.equal(r.cancelled, true);
  assert.deepEqual(leftovers(), []);

  // Abort while the container is probably still being created.
  const early = new AbortController();
  setTimeout(() => early.abort(), 5);
  const e = await s.sb.run(req('sleep 30', { signal: early.signal }));
  assert.equal(e.cancelled, true);
  assert.deepEqual(leftovers(), []);
});

test('docker: as root with a root-owned workspace, check refuses rather than running as root', async (t) => {
  if (unavailable) return t.skip(unavailable);
  if (process.getuid!() !== 0) return t.skip('only meaningful when the tests run as root');
  const workspace = tempDir('ruby-docker-root-');
  const sb = new DockerSandbox({ workspace, image: IMAGE });
  assert.equal(sb.containerUser, '65534:65534');
  const status = await sb.check();
  assert.equal(status.ok, false);
  assert.match(status.detail, /cannot write the workspace/);
});
