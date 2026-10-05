import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    executor.execute({ type: 'tool_call', id: `c${++n}`, name, input }, { sessionId: 's', workspace, signal });
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
