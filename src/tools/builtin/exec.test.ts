import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { defaultConfig } from '../../config/index.ts';
import { Policy, type ApprovalRequest } from '../../policy/index.ts';
import { DockerSandbox, LocalSandbox, type RunRequest, type RunResult, type Sandbox } from '../../sandbox/index.ts';
import { ToolExecutor, ToolRegistry } from '../index.ts';
import { execTool, formatResult } from './exec.ts';

class FakeSandbox implements Sandbox {
  readonly kind = 'docker' as const;
  readonly isolated = true;
  networked = false;
  readonly workspace: string;
  runs: RunRequest[] = [];
  checks = 0;
  ok = true;
  result: Partial<RunResult> = {};
  constructor(workspace: string) {
    this.workspace = realpathSync(workspace);
  }
  async check() {
    this.checks++;
    return { ok: this.ok, detail: this.ok ? 'fine' : 'Docker is not available.' };
  }
  async run(req: RunRequest): Promise<RunResult> {
    this.runs.push(req);
    return { exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false, cancelled: false, truncated: false, ...this.result };
  }
}

function setup(opts: { exec?: 'allow' | 'ask' | 'deny'; sandbox?: (ws: string) => Sandbox } = {}) {
  const workspace = tempDir();
  mkdirSync(join(workspace, 'proj'));
  const sandbox = opts.sandbox?.(workspace) ?? new FakeSandbox(workspace);
  const registry = new ToolRegistry();
  registry.register(execTool(sandbox));
  const asked: ApprovalRequest[] = [];
  const perms = defaultConfig().permissions;
  const executor = new ToolExecutor({
    registry,
    policy: new Policy(opts.exec ? { ...perms, exec: opts.exec } : perms),
    approver: async (r) => {
      asked.push(r);
      return 'approved';
    },
  });
  let n = 0;
  const call = (input: unknown, signal = new AbortController().signal) =>
    executor.execute({ type: 'tool_call', id: `c${++n}`, name: 'run_command', input }, { sessionId: 's', workspace, memoryNamespace: 'default', signal });
  return { workspace, sandbox, call, asked };
}

test('run_command is denied by default and never reaches the sandbox', async () => {
  const { call, sandbox } = setup();
  const r = await call({ command: 'echo hi' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.equal((sandbox as FakeSandbox).runs.length, 0);
  assert.equal((sandbox as FakeSandbox).checks, 0);
});

test('run_command passes cwd, timeout and the cancellation signal, and formats the result', async () => {
  const { call, sandbox } = setup({ exec: 'allow' });
  const fake = sandbox as FakeSandbox;
  const r = await call({ command: 'ls', cwd: 'proj', timeout_seconds: 5 });
  assert.equal(r.status, 'ok');
  assert.equal(r.content, 'exit code 0\n--- stdout ---\nhi\n--- stderr ---\n(empty)');
  assert.equal(fake.runs[0]!.cwd, 'proj');
  assert.equal(fake.runs[0]!.timeoutMs, 5_000);
  assert.equal(fake.runs[0]!.command, 'ls');
  const ac = new AbortController();
  await call({ command: 'ls' }, ac.signal);
  assert.equal(fake.runs[1]!.timeoutMs, 60_000, 'default timeout');
  ac.abort();
  assert.equal(fake.runs[1]!.signal.aborted, true, 'the session signal reaches the sandbox');
  assert.equal(fake.checks, 1, 'readiness is checked once');
});

test('run_command approval shows the working directory; escapes and bad input are rejected', async () => {
  const { call, asked, workspace, sandbox } = setup({ exec: 'ask' });
  assert.equal((await call({ command: 'make', cwd: 'proj' })).status, 'ok');
  assert.deepEqual(asked[0]!.targets, [join(realpathSync(workspace), 'proj')]);
  assert.match(asked[0]!.summary, /run_command on proj .*make/);
  const escape = await call({ command: 'ls', cwd: '../..' });
  assert.equal(escape.status === 'error' && escape.category, 'denied');
  for (const bad of [{ command: '' }, { command: 'x', timeout_seconds: 0 }, { command: 'x', timeout_seconds: 601 }, { command: 'x'.repeat(10_001) }]) {
    const r = await call(bad);
    assert.equal(r.status === 'error' && r.category, 'invalid_input');
  }
  assert.equal((sandbox as FakeSandbox).runs.length, 1);
});

test('an unavailable sandbox is a config error, rechecked on the next call', async () => {
  const { call, sandbox } = setup({ exec: 'allow' });
  const fake = sandbox as FakeSandbox;
  fake.ok = false;
  const r = await call({ command: 'ls' });
  assert.equal(r.status === 'error' && r.category, 'config');
  assert.match(r.content, /Docker is not available/);
  assert.equal(fake.runs.length, 0);
  fake.ok = true;
  assert.equal((await call({ command: 'ls' })).status, 'ok');
  assert.equal(fake.checks, 2);
});

test('a command that timed out is an error result that keeps its output', async () => {
  const { call, sandbox } = setup({ exec: 'allow' });
  (sandbox as FakeSandbox).result = { exitCode: null, stdout: 'partial\n', timedOut: true };
  const r = await call({ command: 'sleep 99', timeout_seconds: 1 });
  assert.equal(r.status === 'error' && r.category, 'timeout');
  assert.match(r.content, /timed out after 1s/);
  assert.match(r.content, /partial/);
  (sandbox as FakeSandbox).result = { exitCode: 1, stdout: '', stderr: 'no match\n' };
  assert.equal((await call({ command: 'grep x y' })).status, 'ok', 'a non-zero exit is a normal result; the exit code comes first');
});

test('a sandbox check that throws is retried on the next call', async () => {
  const { call, sandbox } = setup({ exec: 'allow' });
  const fake = sandbox as FakeSandbox;
  let throws = true;
  const check = fake.check.bind(fake);
  fake.check = async () => {
    if (throws) throw new Error('docker socket vanished');
    return check();
  };
  assert.equal((await call({ command: 'ls' })).status, 'error');
  throws = false;
  assert.equal((await call({ command: 'ls' })).status, 'ok');
});

test('timeouts, cancellation, truncation and non-isolation are stated in the output', () => {
  const base = { exitCode: 137, stdout: '', stderr: 'boom\n', timedOut: true, cancelled: false, truncated: true };
  const text = formatResult(base, 3, false);
  assert.match(text, /^exit code 137\n\[ran on the host: not sandboxed\]\n\[timed out after 3s/);
  assert.match(text, /only the beginning/);
  assert.match(text, /--- stdout ---\n\(empty\)\n--- stderr ---\nboom$/);
  assert.match(formatResult({ ...base, exitCode: null, timedOut: false, cancelled: true, truncated: false }, 3, true), /^exit code none \(killed\)\n\[cancelled/);
});

test('run_command works end to end with the local backend and says it is not sandboxed', async () => {
  const { call } = setup({ exec: 'allow', sandbox: (ws) => new LocalSandbox({ workspace: ws }) });
  const r = await call({ command: 'echo ok; exit 2', cwd: 'proj' });
  assert.equal(r.status, 'ok');
  assert.equal(r.content, 'exit code 2\n[ran on the host: not sandboxed]\n--- stdout ---\nok\n--- stderr ---\n(empty)');
});

test('run_command output is untrusted when the sandbox has network access, trusted when isolated without it', async () => {
  const isolated = setup({ exec: 'allow' });
  const clean = await isolated.call({ command: 'echo hi' });
  assert.equal(clean.status, 'ok');
  assert.equal(clean.untrusted, undefined, 'isolated with no network stays trusted');

  const networked = setup({ exec: 'allow' });
  (networked.sandbox as FakeSandbox).networked = true;
  const r = await networked.call({ command: 'curl https://example.com' });
  assert.equal(r.status, 'ok');
  assert.equal(r.untrusted?.source, 'command with network access');
  (networked.sandbox as FakeSandbox).result = { exitCode: null, timedOut: true };
  const t = await networked.call({ command: 'curl slow', timeout_seconds: 1 });
  assert.equal(t.status === 'error' && t.category, 'timeout');
  assert.equal(t.untrusted?.source, 'command with network access', 'a failed run is still marked');
});

test('the local backend is always networked; docker is networked unless network is none', () => {
  const ws = tempDir();
  assert.equal(new LocalSandbox({ workspace: ws }).networked, true);
  assert.equal(new DockerSandbox({ workspace: ws }).networked, false);
  assert.equal(new DockerSandbox({ workspace: ws, network: 'bridge' }).networked, true);
});
