import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { defaultConfig } from '../../config/index.ts';
import type { ToolDefinition } from '../../contracts/index.ts';
import { Policy } from '../../policy/index.ts';
import { ToolExecutor, ToolRegistry, calculateTool, clarifyTool, datetimeTool, editFileTool, evaluate, globToRegExp, searchFilesTool, todoListTool } from '../index.ts';

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
