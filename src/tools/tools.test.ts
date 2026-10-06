import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { ToolDefinition } from '../contracts/index.ts';
import { Policy, type ApprovalDecision } from '../policy/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from './index.ts';

function setup(opts: { decision?: ApprovalDecision; perms?: Partial<ReturnType<typeof defaultConfig>['permissions']> } = {}) {
  const workspace = tempDir();
  const registry = new ToolRegistry();
  for (const t of fileTools) registry.register(t);
  const asked: string[] = [];
  const executor = new ToolExecutor({
    registry,
    policy: new Policy({ ...defaultConfig().permissions, ...opts.perms }),
    approver: async (r) => {
      asked.push(r.tool);
      return opts.decision ?? 'approved';
    },
  });
  let n = 0;
  const call = (name: string, input: unknown, signal = new AbortController().signal) =>
    executor.execute({ type: 'tool_call', id: `c${++n}`, name, input }, { sessionId: 's', workspace, memoryNamespace: 'default', signal });
  return { workspace, registry, call, asked };
}

test('unknown tools and invalid arguments return actionable errors', async () => {
  const { call } = setup();
  const unknown = await call('nope', {});
  assert.equal(unknown.status, 'error');
  assert.match(unknown.content, /Available tools: list_files, read_file, write_file/);
  const invalid = await call('read_file', { path: 42 });
  assert.equal(invalid.status === 'error' && invalid.category, 'invalid_input');
  assert.match(invalid.content, /path/);
});

test('unknown arguments are rejected, not silently dropped', async () => {
  const { call, workspace } = setup({ perms: { 'fs.write': 'allow' } });
  // `append` does not exist: dropping it would overwrite where the model meant to append.
  const r = await call('write_file', { path: 'a.txt', content: 'x', append: true });
  assert.equal(r.status === 'error' && r.category, 'invalid_input');
  assert.match(r.content, /unknown argument "append"/);
  assert.match(r.content, /Allowed: path, content, overwrite/);
  assert.equal(existsSync(join(workspace, 'a.txt')), false, 'nothing ran');
});

test('a tool that reports a failed operation is an error result, never a success', async () => {
  const { registry, call } = setup();
  registry.register({
    name: 'half', version: 1, description: 'd', input: z.object({}), capability: 'fs.read', idempotent: true, maxOutputChars: 10,
    run: async () => ({ content: 'y'.repeat(50), error: 'timeout' }),
  });
  const r = await call('half', {});
  assert.equal(r.status === 'error' && r.category, 'timeout');
  assert.match(r.content, /showing 10 of 50/, 'output limits still apply');
});

test('an approver that throws becomes an error result', async () => {
  const workspace = tempDir();
  const registry = new ToolRegistry();
  for (const t of fileTools) registry.register(t);
  const executor = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => { throw new Error('db locked'); } });
  const r = await executor.execute({ type: 'tool_call', id: 'c', name: 'write_file', input: { path: 'a', content: 'b' } }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal });
  assert.equal(r.status === 'error' && r.category, 'internal');
  assert.match(r.content, /db locked/);
  assert.equal(existsSync(join(workspace, 'a')), false);
});

test('write asks for approval and respects the answer', async () => {
  const approved = setup({ decision: 'approved' });
  const ok = await approved.call('write_file', { path: 'notes/a.txt', content: 'hi' });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(approved.asked, ['write_file']);
  assert.equal(readFileSync(join(approved.workspace, 'notes/a.txt'), 'utf8'), 'hi');

  const denied = setup({ decision: 'denied' });
  const no = await denied.call('write_file', { path: 'a.txt', content: 'hi' });
  assert.equal(no.status === 'error' && no.category, 'denied');

  const deferred = setup({ decision: 'deferred' });
  const later = await deferred.call('write_file', { path: 'a.txt', content: 'hi' });
  assert.equal(later.status === 'error' && later.category, 'needs_approval');
});

test('denied capabilities never run', async () => {
  const { call, asked } = setup({ perms: { 'fs.read': 'deny' } });
  const r = await call('list_files', {});
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.deepEqual(asked, []);
});

test('file tools round-trip and refuse silent overwrites and escapes', async () => {
  const { call } = setup({ perms: { 'fs.write': 'allow' } });
  assert.equal((await call('write_file', { path: 'a.txt', content: 'one\ntwo\nthree' })).status, 'ok');
  const again = await call('write_file', { path: 'a.txt', content: 'x' });
  assert.match(again.content, /overwrite=true/);
  const read = await call('read_file', { path: 'a.txt', offset: 2, limit: 1 });
  assert.match(read.content, /2 {2}two/);
  assert.match(read.content, /use offset=3/);
  assert.match((await call('list_files', {})).content, /a\.txt/);
  const escape = await call('read_file', { path: '../../etc/passwd' });
  assert.equal(escape.status === 'error' && escape.category, 'denied');
});

test('timeouts, cancellation and output limits are enforced', async () => {
  const { registry, call } = setup();
  const slow: ToolDefinition<{ ms: number }> = {
    name: 'slow', version: 1, description: 'slow', input: z.object({ ms: z.number() }), capability: 'fs.read',
    idempotent: true, timeoutMs: 20, run: ({ ms }) => new Promise((r) => setTimeout(() => r({ content: 'done' }), ms)),
  };
  const loud: ToolDefinition<object> = {
    name: 'loud', version: 1, description: 'loud', input: z.object({}), capability: 'fs.read',
    idempotent: true, maxOutputChars: 10, run: async () => ({ content: 'x'.repeat(100) }),
  };
  registry.register(slow).register(loud);
  const t = await call('slow', { ms: 500 });
  assert.equal(t.status === 'error' && t.category, 'timeout');
  const ac = new AbortController();
  ac.abort();
  const c = await call('slow', { ms: 1 }, ac.signal);
  assert.equal(c.status === 'error' && c.category, 'cancelled');
  const l = await call('loud', {});
  assert.ok(l.status === 'ok' && l.truncated);
  assert.match(l.content, /showing 10 of 100/);
});

test('tool schemas are stable JSON Schema', () => {
  const { registry } = setup();
  const [schema] = registry.schemas(['read_file']);
  assert.equal(schema?.inputSchema.type, 'object');
  assert.deepEqual(registry.schemas(), registry.schemas());
});

test('repairs never guess ambiguous names; oversized output becomes an artifact', async () => {
  const { repairCall, ArtifactStore, readArtifactTool } = await import('./index.ts');
  assert.equal(repairCall({ type: 'tool_call', id: '1', name: 'files', input: {} }, ['list_files', 'read_file']).repairs.length, 0);
  assert.equal(repairCall({ type: 'tool_call', id: '1', name: 'read-file', input: {} }, ['read_file']).call.name, 'read_file');
  const workspace = tempDir();
  const registry = new ToolRegistry();
  const artifacts = new ArtifactStore(join(workspace, '.artifacts'));
  const big: ToolDefinition<object> = {
    name: 'big', version: 1, description: 'big', input: z.object({}), capability: 'fs.read',
    idempotent: true, maxOutputChars: 10, run: async () => ({ content: '0123456789abcdefghij' }),
  };
  registry.register(big).register(readArtifactTool(artifacts));
  const executor = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => 'approved', artifacts });
  const ctx = { sessionId: 's1', workspace, memoryNamespace: 'default', signal: new AbortController().signal };
  const r = await executor.execute({ type: 'tool_call', id: 'a', name: 'big', input: {} }, ctx);
  assert.ok(r.artifactId);
  const more = await executor.execute({ type: 'tool_call', id: 'b', name: 'read_artifact', input: { id: r.artifactId, offset: 10 } }, ctx);
  assert.equal(more.content, 'abcdefghij');
  const other = await executor.execute({ type: 'tool_call', id: 'c', name: 'read_artifact', input: { id: r.artifactId } }, { ...ctx, sessionId: 's2' });
  assert.equal(other.status === 'error' && other.category, 'denied');
});

test('trailing-comma repair never changes string contents', async () => {
  const { repairCall } = await import('./index.ts');
  const repaired = (input: string) => repairCall({ type: 'tool_call', id: '1', name: 'write_file', input }, ['write_file']).call.input;
  assert.deepEqual(repaired('{"path": "a.js", "content": "f({a:1,})",}'), { path: 'a.js', content: 'f({a:1,})' });
  // An escaped quote does not end the string: `,  ]` inside it is content.
  assert.deepEqual(repaired(String.raw`{"content": "x\",  ]", "list": [1, 2,],}`), { content: 'x",  ]', list: [1, 2] });
  assert.deepEqual(repaired(String.raw`{"content": "x\\", "n": [1,],}`), { content: 'x\\', n: [1] });
  assert.deepEqual(repaired('{"a": {"b": [1,]},}'), { a: { b: [1] } });
});

test('file tools never write or read through symlinks that leave the workspace', async () => {
  const { workspace, call } = setup({ perms: { 'fs.write': 'allow' } });
  const outside = tempDir();
  // A dangling link (e.g. planted by a sandboxed command) pointing outside.
  symlinkSync(join(outside, 'autostart.desktop'), join(workspace, 'dangling'));
  const w = await call('write_file', { path: 'dangling', content: 'pwned' });
  assert.equal(w.status === 'error' && w.category, 'denied');
  assert.ok(!existsSync(join(outside, 'autostart.desktop')), 'nothing was written outside the workspace');
  const w2 = await call('write_file', { path: 'dangling/x.txt', content: 'pwned' });
  assert.equal(w2.status, 'error');
  // Even a link to a file inside the workspace is not written through.
  writeFileSync(join(workspace, 'real.txt'), 'orig');
  symlinkSync(join(workspace, 'real.txt'), join(workspace, 'alias'));
  const w3 = await call('write_file', { path: 'alias', content: 'new', overwrite: true });
  assert.equal(w3.status === 'error' && w3.category, 'denied');
  assert.equal(readFileSync(join(workspace, 'real.txt'), 'utf8'), 'orig');
  // Reads may follow links that stay inside, never ones that leave.
  assert.equal((await call('read_file', { path: 'alias' })).status, 'ok');
  mkdirSync(join(outside, 'd'));
  writeFileSync(join(outside, 'd', 'secret'), 'secret');
  symlinkSync(join(outside, 'd'), join(workspace, 'out'));
  const r = await call('read_file', { path: 'out/secret' });
  assert.equal(r.status === 'error' && r.category, 'denied');
  assert.equal((await call('list_files', { path: 'out' })).status, 'error');
});

test('list_files shows workspace-relative paths when the workspace path goes through a symlink', async () => {
  const real = tempDir();
  mkdirSync(join(real, 'src'));
  writeFileSync(join(real, 'src', 'a.ts'), '');
  const linked = join(tempDir(), 'ws-link');
  symlinkSync(real, linked);
  const registry = new ToolRegistry();
  for (const t of fileTools) registry.register(t);
  const executor = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => 'approved' });
  const r = await executor.execute({ type: 'tool_call', id: 'c', name: 'list_files', input: {} }, { sessionId: 's', workspace: linked, memoryNamespace: 'default', signal: new AbortController().signal });
  assert.equal(r.content, 'src/\nsrc/a.ts');
});

test('file tools explain missing paths and wrong kinds without host paths', async () => {
  const { call, workspace } = setup();
  writeFileSync(join(workspace, 'f.txt'), 'x');
  const missing = await call('list_files', { path: 'nope' });
  assert.equal(missing.status === 'error' && missing.category, 'invalid_input');
  assert.match(missing.content, /"nope" does not exist/);
  assert.ok(!missing.content.includes(workspace), 'no absolute host path');
  const file = await call('list_files', { path: 'f.txt' });
  assert.equal(file.status === 'error' && file.category, 'invalid_input');
  assert.match(file.content, /is a file/);
});

test('read_file pages through a file line by line', async () => {
  const { call, workspace } = setup();
  writeFileSync(join(workspace, 'big.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = await call('read_file', { path: 'big.txt', offset: 4999, limit: 10 });
  assert.equal(r.content, ' 4999  line 4999\n 5000  line 5000');
  const head = await call('read_file', { path: 'big.txt', limit: 2 });
  assert.equal(head.content, '    1  line 1\n    2  line 2\n[lines 1-2 of 5000; use offset=3 for more]');
  writeFileSync(join(workspace, 'crlf.txt'), 'a\r\nb');
  assert.equal((await call('read_file', { path: 'crlf.txt' })).content, '    1  a\n    2  b');
  writeFileSync(join(workspace, 'empty.txt'), '');
  assert.equal((await call('read_file', { path: 'empty.txt' })).content, '(empty file)');
  const past = await call('read_file', { path: 'crlf.txt', offset: 9 });
  assert.match(past.content, /only 2 lines/);
  writeFileSync(join(workspace, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
  assert.match((await call('read_file', { path: 'bin' })).content, /binary/);
});

test('a registered tool absent from the frozen tool list is refused', async () => {
  const { registry, workspace } = setup();
  const executor = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => 'approved' });
  const run = (allowedTools: string[]) =>
    executor.execute({ type: 'tool_call', id: 'c', name: 'list_files', input: {} }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal, allowedTools });
  const refused = await run(['read_file']);
  assert.equal(refused.status, 'error');
  assert.match(refused.content, /not available in this session/);
  assert.equal((await run(['list_files'])).status, 'ok');
});
