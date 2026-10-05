import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { Budget } from '../contracts/index.ts';
import { FakeModel, type FakeScript } from '../models/index.ts';
import { Policy, type Approver } from '../policy/index.ts';
import { openDb, SessionStore } from '../store/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from '../tools/index.ts';
import { Agent, LaneQueue, type RuntimeEvent } from './index.ts';

function setup(script: FakeScript, opts: { budget?: Partial<Budget>; approver?: Approver } = {}) {
  const workspace = tempDir();
  const store = new SessionStore(openDb(':memory:'));
  const registry = new ToolRegistry();
  for (const t of fileTools) registry.register(t);
  const config = defaultConfig();
  const executor = new ToolExecutor({ registry, policy: new Policy(config.permissions), approver: opts.approver ?? (async () => 'approved') });
  const model = new FakeModel(script);
  const agent = new Agent({
    store, model, registry, executor, workspace, maxOutputTokens: 1000,
    budget: { ...config.budgets, ...opts.budget },
    sleep: async () => {},
  });
  const session = store.createSession();
  const events: RuntimeEvent[] = [];
  const run = (text: string, signal?: AbortSignal) => agent.run(session.id, text, { onEvent: (e) => events.push(e), ...(signal ? { signal } : {}) });
  return { workspace, store, model, session, events, run };
}

test('a tool-backed task completes and records usage', async () => {
  const t = setup([
    { toolCalls: [{ name: 'write_file', input: { path: 'todo.md', content: '- milk' } }], usage: { inputTokens: 50, outputTokens: 10 } },
    { text: 'Saved your list to todo.md.', usage: { inputTokens: 80, outputTokens: 8 } },
  ]);
  const task = await t.run('save a todo');
  assert.equal(task.status, 'completed');
  assert.equal(readFileSync(join(t.workspace, 'todo.md'), 'utf8'), '- milk');
  assert.equal(task.usage.inputTokens, 130);
  assert.equal(task.usage.cacheReadTokens, null, 'unknown usage stays unknown');
  assert.equal(task.modelCalls, 2);
  assert.equal(task.toolCalls, 1);
  // The second model call saw the tool result.
  const second = t.model.requests[1]!.messages.at(-1)!;
  assert.equal(second.content[0]?.type, 'tool_result');
  const types = t.store.events(t.session.id).map((e) => e.type);
  assert.deepEqual(types, ['user_message', 'assistant_message', 'tool_started', 'tool_finished', 'assistant_message', 'task_status']);
  assert.ok(t.events.some((e) => e.type === 'text'));
});

test('invalid tool arguments go back to the model, which can recover', async () => {
  const t = setup([
    { toolCalls: [{ name: 'read_file', input: { file: 'x' } }] },
    (req) => {
      const r = req.messages.at(-1)!.content[0];
      assert.ok(r?.type === 'tool_result' && r.isError && /path/.test(r.content));
      return { text: 'Sorry, retrying correctly is not needed.' };
    },
  ]);
  assert.equal((await t.run('read x')).status, 'completed');
});

test('budgets stop runaway loops', async () => {
  const loop = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'list_files', input: {} }] }));
  const t = setup(loop, { budget: { maxModelCalls: 3 } });
  const task = await t.run('loop');
  assert.equal(task.status, 'budget_exhausted');
  assert.equal(task.modelCalls, 3);
});

test('approval deferral pauses the task without running the tool', async () => {
  const t = setup([{ toolCalls: [{ name: 'write_file', input: { path: 'a', content: 'b' } }, { name: 'list_files', input: {} }] }], {
    approver: async () => 'deferred',
  });
  const task = await t.run('write');
  assert.equal(task.status, 'waiting_for_approval');
  assert.equal(task.endedAt, null);
  const finished = t.store.events(t.session.id).filter((e) => e.type === 'tool_finished');
  assert.equal(finished.length, 2, 'every call gets a result so history stays valid');
  assert.equal(t.store.events(t.session.id).filter((e) => e.type === 'tool_started').length, 1);
});

test('cancellation stops before the next model call', async () => {
  const ac = new AbortController();
  const t = setup([
    () => {
      ac.abort();
      return { toolCalls: [{ name: 'list_files', input: {} }] };
    },
    { text: 'never' },
  ]);
  const task = await t.run('go', ac.signal);
  assert.equal(task.status, 'cancelled');
  assert.equal(t.model.requests.length, 1);
});

test('transient provider errors are retried; fatal ones fail the task', async () => {
  const t = setup([{ error: { category: 'provider_transient', message: 'overloaded' } }, { text: 'ok' }]);
  assert.equal((await t.run('hi')).status, 'completed');
  assert.ok(t.events.some((e) => e.type === 'retry'));
  const f = setup([{ error: { category: 'provider_fatal', message: 'bad key' } }]);
  const task = await f.run('hi');
  assert.equal(task.status, 'failed');
  assert.match(task.reason ?? '', /bad key/);
});

test('tool calls from a truncated response are never executed', async () => {
  const t = setup([
    () => ({ toolCalls: [{ name: 'write_file', input: { path: 'a', content: 'partial' } }] }),
    { text: 'done' },
  ]);
  // Simulate max_tokens by wrapping the model's stream.
  const original = t.model.stream.bind(t.model);
  let first = true;
  t.model.stream = async function* (req) {
    for await (const e of original(req)) {
      if (e.type === 'done' && first) {
        first = false;
        yield { ...e, stopReason: 'max_tokens' as const };
      } else yield e;
    }
  };
  await t.run('write');
  assert.equal(t.store.events(t.session.id).filter((e) => e.type === 'tool_started').length, 0);
});

test('lanes serialize per key and run different keys concurrently', async () => {
  const lanes = new LaneQueue(4);
  const log: string[] = [];
  const job = (id: string, ms: number) => () => new Promise<void>((r) => { log.push(`start ${id}`); setTimeout(() => { log.push(`end ${id}`); r(); }, ms); });
  await Promise.all([lanes.run('a', job('a1', 20)), lanes.run('a', job('a2', 1)), lanes.run('b', job('b1', 1))]);
  assert.ok(log.indexOf('end a1') < log.indexOf('start a2'), 'same key is serialized');
  assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), 'different keys overlap');
});
