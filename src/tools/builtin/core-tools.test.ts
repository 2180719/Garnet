import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { defaultConfig } from '../../config/index.ts';
import type { ToolDefinition } from '../../contracts/index.ts';
import { Policy } from '../../policy/index.ts';
import type { RunResult, Sandbox } from '../../sandbox/index.ts';
import { ToolExecutor, ToolRegistry, calculateTool, clarifyTool, datetimeTool, editFileTool, evaluate, executeCodeTool, globToRegExp, searchFilesTool, sessionSearchTool, todoListTool } from '../index.ts';

function setup(...tools: ToolDefinition[]) {
  const workspace = tempDir();
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const perms = { ...defaultConfig().permissions, 'fs.read': 'allow', 'fs.write': 'allow' } as const;
  const executor = new ToolExecutor({ registry, policy: new Policy(perms), approver: async () => 'denied' });
  let n = 0;
  const call = (name: string, input: unknown) =>
    executor.execute({ type: 'tool_call', id: `c${++n}`, name, input }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal });
  return { workspace, call };
}

test('edit_file replaces a unique match and keeps the rest of the file', async () => {
  const { workspace, call } = setup(editFileTool);
  writeFileSync(join(workspace, 'a.txt'), 'one\ntwo $& three\n');
  const r = await call('edit_file', { path: 'a.txt', edits: [{ old_string: 'two', new_string: 'TWO $&' }] });
  assert.equal(r.status, 'ok');
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'one\nTWO $& $& three\n');
});

test('edit_file refuses ambiguous and missing matches, and leaves the file untouched when any edit fails', async () => {
  const { workspace, call } = setup(editFileTool);
  writeFileSync(join(workspace, 'a.txt'), 'x x y');
  const ambiguous = await call('edit_file', { path: 'a.txt', edits: [{ old_string: 'x', new_string: 'z' }] });
  assert.equal(ambiguous.status, 'error');
  assert.match(ambiguous.content, /matches 2 places/);
  const partial = await call('edit_file', { path: 'a.txt', edits: [{ old_string: 'y', new_string: 'Y' }, { old_string: 'nope', new_string: 'q' }] });
  assert.equal(partial.status, 'error');
  assert.match(partial.content, /Edit 2: old_string was not found/);
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'x x y');
  const all = await call('edit_file', { path: 'a.txt', edits: [{ old_string: 'x', new_string: 'z', replace_all: true }] });
  assert.equal(all.status, 'ok');
  assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'z z y');
});

test('edit_file stays inside the workspace and does not write through symlinks', async () => {
  const { workspace, call } = setup(editFileTool);
  const outside = tempDir();
  writeFileSync(join(outside, 'secret.txt'), 'keep');
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
  const link = await call('edit_file', { path: 'link.txt', edits: [{ old_string: 'keep', new_string: 'gone' }] });
  assert.equal(link.status, 'error');
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'keep');
  const escape = await call('edit_file', { path: '../x.txt', edits: [{ old_string: 'a', new_string: 'b' }] });
  assert.equal(escape.status, 'error');
});

test('search_files finds content with line numbers, filters by glob and skips node_modules', async () => {
  const { workspace, call } = setup(searchFilesTool);
  mkdirSync(join(workspace, 'src'));
  mkdirSync(join(workspace, 'node_modules'));
  writeFileSync(join(workspace, 'src', 'a.ts'), 'const a = 1;\nconst Needle = 2;\n');
  writeFileSync(join(workspace, 'src', 'b.md'), 'needle in docs\n');
  writeFileSync(join(workspace, 'node_modules', 'c.ts'), 'needle\n');
  const hits = await call('search_files', { pattern: 'needle', ignore_case: true });
  assert.equal(hits.status, 'ok');
  assert.equal(hits.content, 'src/a.ts:2: const Needle = 2;\nsrc/b.md:1: needle in docs');
  const ts = await call('search_files', { pattern: 'needle', glob: '**/*.ts', ignore_case: true });
  assert.equal(ts.content, 'src/a.ts:2: const Needle = 2;');
  const names = await call('search_files', { glob: '*.md' });
  assert.equal(names.content, 'src/b.md');
  assert.equal((await call('search_files', { pattern: '(' })).status, 'error');
  assert.equal((await call('search_files', {})).status, 'error');
});

test('globToRegExp: * stays in a directory, ** crosses them', () => {
  assert.ok(globToRegExp('*.ts').test('a/b/c.ts'), 'a bare name pattern matches at any depth');
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('calculate: precedence, functions and clear errors', async () => {
  assert.equal(evaluate('2 + 3 * 4'), 14);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('(1 + 2) * 3 % 5'), 4);
  assert.equal(evaluate('max(1, 5, 3) + sqrt(16)'), 9);
  assert.equal(evaluate('round(pi * 100) / 100'), 3.14);
  assert.throws(() => evaluate('1 / 0'), /Division by zero/);
  assert.throws(() => evaluate('process.exit()'), /Unknown name|Unexpected/);
  assert.throws(() => evaluate('foo(1)'), /Unknown function/);
  assert.throws(() => evaluate('1 +'), /ends unexpectedly/);
  assert.throws(() => evaluate('1 2'), /Unexpected/);
  const { call } = setup(calculateTool);
  assert.equal((await call('calculate', { expression: '0.1 + 0.2' })).content, '0.1 + 0.2 = 0.3');
  assert.equal((await call('calculate', { expression: 'sqrt(0-1)' })).status, 'error');
});

test('datetime: zones, DST-aware conversion, arithmetic and diff', async () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const { call } = setup(datetimeTool({ defaultTimeZone: 'Europe/Lisbon', now: () => now }));
  const current = await call('datetime', { operation: 'now' });
  assert.match(current.content, /^2026-10-08T13:00:00\+01:00 \(Thursday, Europe\/Lisbon\)/);
  const conv = await call('datetime', { operation: 'convert', time: '2026-01-15T09:00', timezone: 'America/New_York', to_timezone: 'Asia/Tokyo' });
  assert.match(conv.content, /= 2026-01-15T23:00:00\+09:00/);
  const add = await call('datetime', { operation: 'add', time: '2026-03-28T12:00', timezone: 'UTC', days: 2, hours: 3 });
  assert.match(add.content, /= 2026-03-30T15:00:00\+00:00/);
  const diff = await call('datetime', { operation: 'diff', time: '2026-10-08', to: '2026-10-10T06:30', timezone: 'UTC' });
  assert.match(diff.content, /= 2d 6h 30m/);
  assert.equal((await call('datetime', { operation: 'now', timezone: 'Mars/Base' })).status, 'error');
  assert.equal((await call('datetime', { operation: 'add', time: 'tomorrow' })).status, 'error');
});

test('todo_list renders the list and rejects two in-progress items; clarify numbers its options', async () => {
  const { call } = setup(todoListTool, clarifyTool);
  const ok = await call('todo_list', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] });
  assert.equal(ok.content, 'Checklist (1/3 done):\n[x] a\n[~] b\n[ ] c');
  assert.equal((await call('todo_list', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] })).status, 'error');
  const q = await call('clarify', { question: 'Which one?', options: ['red', 'blue'] });
  assert.match(q.content, /Which one\?\n1\. red\n2\. blue/);
  assert.equal((await call('clarify', { question: 'x', options: ['only'] })).status, 'error');
});

test('session_search formats hits, marks results from tainted sessions untrusted, and reports an unavailable index', async () => {
  const hit = { sessionId: 'ses_a', title: 'Trip', at: '2026-09-01T10:00:00.000Z', role: 'user' as const, snippet: 'book [flights]\nnow', tainted: false };
  let result: typeof hit[] | null = [hit];
  const { call } = setup(sessionSearchTool({ search: () => result }));
  const ok = await call('session_search', { query: 'flights' });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.content, '- 2026-09-01 user in "Trip": book [flights] now');
  assert.equal((ok as { untrusted?: unknown }).untrusted, undefined);
  result = [{ ...hit, tainted: true }];
  assert.ok((await call('session_search', { query: 'flights' }) as { untrusted?: unknown }).untrusted, 'a tainted past session taints this one');
  result = [];
  assert.equal((await call('session_search', { query: 'x' })).content, 'No matches in past conversations.');
  result = null;
  assert.equal((await call('session_search', { query: 'x' })).status, 'error');
});

test('execute_code feeds the script to the interpreter on stdin and explains a missing interpreter', async () => {
  const workspace = tempDir();
  const runs: { command: string; stdin?: string | undefined; timeoutMs: number }[] = [];
  let next: Partial<RunResult> = {};
  const sandbox: Sandbox = {
    kind: 'docker', isolated: true, networked: false, workspace: realpathSync(workspace),
    check: async () => ({ ok: true, detail: '' }),
    run: async (req) => {
      runs.push({ command: req.command, stdin: req.stdin, timeoutMs: req.timeoutMs });
      return { exitCode: 0, stdout: '42\n', stderr: '', timedOut: false, cancelled: false, truncated: false, ...next };
    },
  };
  const registry = new ToolRegistry().register(executeCodeTool(sandbox));
  const executor = new ToolExecutor({ registry, policy: new Policy({ ...defaultConfig().permissions, exec: 'allow' }), approver: async () => 'denied' });
  const call = (input: unknown) => executor.execute({ type: 'tool_call', id: 'c', name: 'execute_code', input }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal });
  const ok = await call({ language: 'python', code: 'print(6*7)', timeout_seconds: 5 });
  assert.equal(ok.status, 'ok');
  assert.match(ok.content, /^exit code 0\n--- stdout ---\n42/);
  assert.deepEqual(runs[0], { command: 'python3 -', stdin: 'print(6*7)', timeoutMs: 5000 });
  next = { exitCode: 127, stderr: 'sh: 1: node: not found\n' };
  assert.match((await call({ language: 'node', code: 'x' })).content, /node is not installed in the sandbox/);
  const denied = await new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => 'denied' }).execute({ type: 'tool_call', id: 'd', name: 'execute_code', input: { language: 'sh', code: 'ls' } }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal });
  assert.equal(denied.status === 'error' && denied.category, 'denied', 'exec stays denied by default');
});

test('search_files cuts off a catastrophic regex instead of freezing, and edit_file refuses a symlink inside the workspace', async () => {
  const { workspace, call } = setup(searchFilesTool, editFileTool);
  writeFileSync(join(workspace, 'evil.txt'), `${'a'.repeat(40)}!\n`);
  const started = Date.now();
  const r = await call('search_files', { pattern: '^(a+)+$' });
  assert.equal(r.status, 'error');
  assert.match(r.content, /took too long to match/);
  assert.ok(Date.now() - started < 5000, 'returned promptly');
  assert.equal((await call('search_files', { pattern: '^a+!$' })).status, 'ok', 'ordinary patterns still work afterwards');
  writeFileSync(join(workspace, 'target.txt'), 'one');
  symlinkSync(join(workspace, 'target.txt'), join(workspace, 'link.txt'));
  const link = await call('edit_file', { path: 'link.txt', edits: [{ old_string: 'one', new_string: 'two' }] });
  assert.equal(link.status, 'error');
  assert.match(link.content, /symlink/);
  assert.equal(readFileSync(join(workspace, 'target.txt'), 'utf8'), 'one');
});

test('datetime rejects impossible dates and resolves clock changes predictably', async () => {
  const { call } = setup(datetimeTool({ defaultTimeZone: 'UTC', now: () => 0 }));
  for (const time of ['2026-02-31', '2026-13-01', '2026-10-08T25:00']) assert.equal((await call('datetime', { operation: 'now', time })).status, 'error', time);
  const at = async (time: string, timezone: string) => (await call('datetime', { operation: 'now', time, timezone })).content.split('\n')[0];
  assert.match((await at('2026-03-08T02:30', 'America/New_York'))!, /^2026-03-08T03:30:00-04:00/, 'a skipped time lands after the gap');
  assert.match((await at('2026-11-01T01:30', 'America/New_York'))!, /^2026-11-01T01:30:00-04:00/, 'a repeated time is the first one');
  assert.match((await at('2026-03-29T02:30', 'Europe/Berlin'))!, /^2026-03-29T03:30:00\+02:00/);
});

test('datetime handles very early years and refuses nonsense offsets', async () => {
  const { call } = setup(datetimeTool({ defaultTimeZone: 'UTC', now: () => 0 }));
  assert.match((await call('datetime', { operation: 'now', time: '0050-06-01', timezone: 'UTC' })).content, /^0050-06-01T00:00:00\+00:00/);
  assert.equal((await call('datetime', { operation: 'now', time: '2026-01-01T00:00+25:00' })).status, 'error');
  assert.equal((await call('datetime', { operation: 'now', time: '2026-01-01T00:00+05:99' })).status, 'error');
});

test('calculate refuses integers it cannot hold exactly; datetime refuses +14:30; edit_file approvals show the whole edit', async () => {
  assert.throws(() => evaluate('9007199254740993 - 9007199254740992'), /too large to calculate exactly/);
  assert.equal(evaluate('9007199254740991 - 1'), 9007199254740990);
  assert.equal(evaluate('1e300 / 1e299'), 10, 'scientific notation is an explicit approximation');
  const { call } = setup(datetimeTool({ defaultTimeZone: 'UTC', now: () => 0 }));
  assert.equal((await call('datetime', { operation: 'now', time: '2026-01-01T00:00+14:30' })).status, 'error');
  assert.equal((await call('datetime', { operation: 'now', time: '2026-01-01T00:00+14:00' })).status, 'ok');
  const long = 'x'.repeat(500);
  const summary = editFileTool.summarize!({ path: 'a.txt', edits: [{ old_string: 'a', new_string: `${long}END`, replace_all: false }] }, { sessionId: 's', callId: 'c', workspace: '/w', memoryNamespace: 'default', signal: new AbortController().signal });
  assert.ok(summary.includes(`${long}END`));
});
