import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { Budget, ModelAdapter, ModelEvent, ToolDefinition, Usage } from '../contracts/index.ts';
import { FakeModel, type FakeScript } from '../models/index.ts';
import { Policy, type Approver } from '../policy/index.ts';
import { openDb, SessionStore } from '../store/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from '../tools/index.ts';
import { Agent, LaneQueue, type RuntimeEvent } from './index.ts';

function setup(script: FakeScript, opts: { budget?: Partial<Budget>; approver?: Approver; sections?: () => string[]; compactAtTokens?: number; refuse?: () => string | null; recordSpend?: (u: Usage) => void } = {}) {
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
    ...(opts.sections ? { promptSections: opts.sections } : {}),
    ...(opts.compactAtTokens ? { compactAtTokens: opts.compactAtTokens, keepTurns: 1 } : {}),
    ...(opts.refuse ? { refuse: opts.refuse } : {}),
    ...(opts.recordSpend ? { recordSpend: opts.recordSpend } : {}),
    sleep: async () => {},
  });
  const session = store.createSession();
  const events: RuntimeEvent[] = [];
  const run = (text: string, signal?: AbortSignal) => agent.run(session.id, text, { onEvent: (e) => events.push(e), ...(signal ? { signal } : {}) });
  return { workspace, store, model, registry, session, events, run, agent };
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
  assert.deepEqual(types, ['user_message', 'context_frozen', 'assistant_message', 'tool_started', 'tool_finished', 'assistant_message', 'task_status']);
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
    { toolCalls: [{ name: 'write_file', input: { path: 'a', content: 'partial' } }], stopReason: 'max_tokens' },
    { text: 'done' },
  ]);
  await t.run('write');
  assert.equal(t.store.events(t.session.id).filter((e) => e.type === 'tool_started').length, 0);
});

test('a retry-after beyond the task time limit fails instead of waiting', async () => {
  const t = setup([{ error: { category: 'provider_transient', message: 'rate limited', retryAfterMs: 3_600_000 } }, { text: 'never' }], {
    budget: { maxWallMs: 60_000 },
  });
  const task = await t.run('hi');
  assert.equal(task.status, 'failed');
  assert.match(task.reason ?? '', /time limit/);
  assert.equal(t.model.requests.length, 1);
  assert.ok(!t.events.some((e) => e.type === 'retry'));
});

test('an unexpected failure marks the task failed instead of leaving it running', async () => {
  const t = setup([{ toolCalls: [{ name: 'list_files', input: {} }] }]);
  const append = t.store.append.bind(t.store);
  t.store.append = ((sessionId, event) => {
    if (event.type === 'tool_started') throw new Error('disk full');
    return append(sessionId, event);
  }) as typeof t.store.append;
  await assert.rejects(t.run('go'), /disk full/);
  const [running] = t.store.unfinishedTasks();
  assert.equal(running, undefined);
  const lastStatus = t.store.events(t.session.id).findLast((e) => e.type === 'task_status');
  assert.ok(lastStatus?.type === 'task_status');
  const task = t.store.getTask(lastStatus.taskId);
  assert.equal(task?.status, 'failed');
  assert.match(task?.reason ?? '', /disk full/);
  assert.notEqual(task?.endedAt, null);
});

test('a summary cut off at the output limit is not used as a checkpoint', async () => {
  const t = setup([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: '<summary>Said one, tw', stopReason: 'max_tokens' }]);
  for (const m of ['a', 'b', 'c']) await t.run(m);
  assert.equal((await t.agent.compact(t.session.id)).status, 'failed');
  assert.ok(!t.store.events(t.session.id).some((e) => e.type === 'checkpoint'));
});

test('manual compaction respects the daily spending cap: at the cap, no model call is made', async () => {
  let capped = false;
  const t = setup([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: '<summary>Said one, two, three.</summary>' }], { refuse: () => (capped ? 'Daily spending cap reached.' : null) });
  for (const m of ['a', 'b', 'c']) await t.run(m);
  const calls = t.model.requests.length;
  capped = true;
  const outcome = await t.agent.compact(t.session.id);
  assert.equal(outcome.status, 'refused');
  assert.match(outcome.reason ?? '', /Daily spending cap reached/);
  assert.equal(t.model.requests.length, calls, 'no model call was made');
  assert.ok(!t.store.events(t.session.id).some((e) => e.type === 'checkpoint'));
  capped = false;
  assert.equal((await t.agent.compact(t.session.id)).status, 'compacted', 'under the cap it compacts');
});

test('lanes serialize per key and run different keys concurrently', async () => {
  const lanes = new LaneQueue(4);
  const log: string[] = [];
  const job = (id: string, ms: number) => () => new Promise<void>((r) => { log.push(`start ${id}`); setTimeout(() => { log.push(`end ${id}`); r(); }, ms); });
  await Promise.all([lanes.run('a', job('a1', 20)), lanes.run('a', job('a2', 1)), lanes.run('b', job('b1', 1))]);
  assert.ok(log.indexOf('end a1') < log.indexOf('start a2'), 'same key is serialized');
  assert.ok(log.indexOf('start b1') < log.indexOf('end a1'), 'different keys overlap');
});

test('lanes never exceed the global concurrency cap', async () => {
  const lanes = new LaneQueue(2);
  let active = 0;
  let peak = 0;
  const job = (ticks: number) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    for (let i = 0; i < ticks; i++) await null;
    active -= 1;
  };
  const all: Promise<void>[] = [];
  for (let i = 0; i < 200; i++) {
    all.push(lanes.run(`k${i % 7}`, job(i % 5)));
    if (i % 3 === 0) await null; // interleave new work with jobs finishing
  }
  await Promise.all(all);
  assert.equal(peak, 2);
});

test('the system prompt is frozen per session and refreshed only by compaction', async () => {
  let memory = 'likes tea';
  const t = setup(
    [
      { text: 'one', usage: { inputTokens: 10 } },
      { text: 'two', usage: { inputTokens: 5000 } },
      { text: '<summary>Owner likes tea; discussed one and two.</summary>' },
      { text: 'three' },
    ],
    { sections: () => [`# Memory\n${memory}`], compactAtTokens: 1000 },
  );
  await t.run('first');
  memory = 'likes coffee';
  await t.run('second');
  assert.match(t.model.requests[1]!.system, /likes tea/, 'mid-session memory writes do not change the prompt');
  assert.equal(t.model.requests[0]!.system, t.model.requests[1]!.system);
  await t.run('third'); // previous request used 5000 tokens -> compact first
  const summarize = t.model.requests[2]!;
  assert.match(String((summarize.messages.at(-1)!.content.at(-1) as { text: string }).text), /Summarize the transcript/);
  const after = t.model.requests[3]!;
  assert.match(after.system, /likes coffee/, 'compaction re-freezes the prompt with fresh memory');
  const first = after.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text.includes('Owner likes tea; discussed one and two.'));
  assert.equal(after.messages.length, 1, 'only the summary and the kept turn remain');
  assert.ok(JSON.stringify(after.messages[0]!.content).includes('third'), 'the current turn is kept verbatim');
  assert.ok(t.store.events(t.session.id).some((e) => e.type === 'checkpoint'));
});

test('malformed but unambiguous tool calls are repaired and noted', async () => {
  const t = setup([
    { toolCalls: [{ name: 'ListFiles', input: '```json\n{"path": ".",}\n```' }] },
    (req) => {
      const r = req.messages.at(-1)!.content[0];
      assert.ok(r?.type === 'tool_result' && !r.isError && /auto-corrected/.test(r.content));
      return { text: 'ok' };
    },
  ]);
  assert.equal((await t.run('list')).status, 'completed');
  const finished = t.store.events(t.session.id).find((e) => e.type === 'tool_finished');
  assert.ok(finished?.type === 'tool_finished' && finished.result.repairs?.length === 2);
});

test('a request cancelled before it starts adds nothing to the conversation', async () => {
  const t = setup([{ text: 'never' }]);
  const ac = new AbortController();
  ac.abort();
  const task = await t.run('queued then cancelled', ac.signal);
  assert.equal(task.status, 'cancelled');
  assert.equal(t.model.requests.length, 0);
  assert.equal(t.store.events(t.session.id).filter((e) => e.type === 'user_message').length, 0);
});

test('the tool set is frozen per session and refreshed only by compaction', async () => {
  const t = setup(
    [
      { text: 'one', usage: { inputTokens: 10 } },
      { text: 'two', usage: { inputTokens: 5000 } },
      { text: '<summary>Discussed one and two.</summary>' },
      { text: 'three' },
    ],
    { compactAtTokens: 1000 },
  );
  const names = (i: number) => t.model.requests[i]!.tools.map((s) => s.name);
  await t.run('first');
  t.registry.register({ ...fileTools[0]!, name: 'late_tool' } as (typeof fileTools)[number]);
  await t.run('second');
  assert.deepEqual(names(1), names(0), 'a tool registered mid-session is not sent until compaction');
  assert.ok(!names(1).includes('late_tool'));
  await t.run('third'); // compacts first
  assert.deepEqual(names(2), names(0), 'the summarization call reuses the frozen tools');
  assert.ok(names(3).includes('late_tool'), 'compaction re-freezes the tool set');
});

test('compact() summarizes on request, regardless of the threshold', async () => {
  const t = setup([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: '<summary>Said one, two, three.</summary>' }, { text: 'four' }]);
  assert.equal((await t.agent.compact(t.session.id)).status, 'nothing_to_compact', 'nothing older than the kept turns');
  for (const m of ['a', 'b', 'c']) await t.run(m);
  const outcome = await t.agent.compact(t.session.id);
  assert.equal(outcome.status, 'compacted');
  assert.equal(outcome.usage?.inputTokens, 100);
  assert.ok(t.store.events(t.session.id).some((e) => e.type === 'checkpoint'));
  assert.equal((await t.agent.compact(t.session.id)).status, 'nothing_to_compact', 'already covered by the checkpoint');
  await t.run('d');
  const first = t.model.requests.at(-1)!.messages[0]!.content[0];
  assert.ok(first?.type === 'text' && first.text.includes('Said one, two, three.'), 'the next request starts from the summary');
});

test('a failed compact() keeps the full history', async () => {
  const t = setup([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { error: { category: 'provider_fatal', message: 'down' } }]);
  for (const m of ['a', 'b', 'c']) await t.run(m);
  assert.equal((await t.agent.compact(t.session.id)).status, 'failed');
  assert.ok(!t.store.events(t.session.id).some((e) => e.type === 'checkpoint'));
});

test('a refusing spending cap stops the task before any model call and keeps the message out of history', async () => {
  const t = setup([{ text: 'never sent' }], { refuse: () => 'Daily spending cap reached.' });
  const task = await t.run('hello');
  assert.equal(task.status, 'budget_exhausted');
  assert.equal(task.reason, 'Daily spending cap reached.');
  assert.equal(t.model.requests.length, 0);
  assert.equal(t.store.events(t.session.id).some((e) => e.type === 'user_message'), false);
});

test('the spending cap is re-checked before every model call, so a running task stops once it is reached', async () => {
  let calls = 0;
  const loop: FakeScript = Array.from({ length: 10 }, () => () => (calls += 1, { toolCalls: [{ name: 'list_files', input: {} }] }));
  const t = setup(loop, { refuse: () => (calls >= 2 ? 'Daily spending cap reached.' : null) });
  const task = await t.run('loop');
  assert.equal(task.status, 'budget_exhausted');
  assert.equal(task.modelCalls, 2);
  assert.match(task.reason ?? '', /Daily spending cap/);
});

test('manual compaction reports its usage as task-less spend', async () => {
  const spend: Usage[] = [];
  const t = setup([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: '<summary>notes</summary>', usage: { inputTokens: 7, outputTokens: 3 } }], { recordSpend: (u) => spend.push(u) });
  for (const m of ['a', 'b', 'c']) await t.run(m);
  const outcome = await t.agent.compact(t.session.id);
  assert.equal(outcome.status, 'compacted');
  assert.equal(spend.length, 1);
  assert.equal(spend[0]!.inputTokens, 7);
});

test('time spent waiting for an interactive approval does not count against the time limit', async () => {
  const t = setup(
    [
      { toolCalls: [{ name: 'write_file', input: { path: 'a.md', content: 'x' } }] },
      { text: 'Saved.' },
    ],
    { budget: { maxWallMs: 100 }, approver: () => new Promise((resolve) => setTimeout(() => resolve('approved'), 250)) },
  );
  const task = await t.run('save a.md');
  assert.equal(task.status, 'completed', task.reason ?? '');
  assert.equal(readFileSync(join(t.workspace, 'a.md'), 'utf8'), 'x');
});

/** A started signal plus a way to wait for it, so a test acts only once the model or tool is really running. */
function started() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, signal: resolve };
}

/**
 * A model that, once called, never answers on its own: it waits for the request to be aborted (or, with
 * `honorsSignal: false`, for `lateMs`, then answers) and keeps the process alive meanwhile, since abort timers do not.
 */
function stuckModel(opts: { honorsSignal?: boolean; lateMs?: number } = {}) {
  const fast = new FakeModel([{ text: 'late answer' }]);
  const running = started();
  const model: ModelAdapter = {
    id: 'stuck',
    capabilities: fast.capabilities,
    async *stream(request): AsyncIterable<ModelEvent> {
      running.signal();
      const keepAlive = setInterval(() => {}, 1000);
      const outcome = await new Promise<'late' | 'aborted'>((resolve) => {
        if (opts.honorsSignal !== false) request.signal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        if (opts.lateMs !== undefined) setTimeout(() => resolve('late'), opts.lateMs);
      });
      clearInterval(keepAlive);
      if (outcome === 'aborted') {
        yield { type: 'error', category: 'cancelled', message: 'aborted' };
        return;
      }
      yield* fast.stream({ ...request, signal: undefined }); // the fake would refuse an aborted signal
    },
  };
  return { model, running: running.promise };
}

function slowSetup(model: ModelAdapter, maxWallMs: number, extraTools: ToolDefinition[] = []) {
  const store = new SessionStore(openDb(':memory:'));
  const registry = new ToolRegistry();
  for (const tool of extraTools) registry.register(tool);
  const executor = new ToolExecutor({ registry, policy: new Policy(defaultConfig().permissions), approver: async () => 'approved' });
  const agent = new Agent({ store, model, registry, executor, workspace: tempDir(), maxOutputTokens: 1000, budget: { ...defaultConfig().budgets, maxWallMs }, sleep: async () => {} });
  return { store, run: (text: string, signal?: AbortSignal) => agent.run(store.createSession().id, text, signal ? { signal } : {}) };
}

test('the wall-clock limit aborts a model call that is still running', async () => {
  const m = stuckModel();
  const t = slowSetup(m.model, 300);
  const task = await t.run('go');
  await m.running; // the model was called, so it was the deadline that stopped it
  assert.equal(task.status, 'budget_exhausted');
  assert.match(task.reason ?? '', /time limit/);
});

test('a complete answer that arrives after the deadline is kept as completed', async () => {
  const m = stuckModel({ honorsSignal: false, lateMs: 250 });
  const t = slowSetup(m.model, 100);
  const task = await t.run('go');
  assert.equal(task.status, 'completed');
});

test('caller cancellation still wins over the deadline', async () => {
  const m = stuckModel();
  const t = slowSetup(m.model, 60_000);
  const ac = new AbortController();
  const done = t.run('go', ac.signal);
  await m.running;
  ac.abort();
  assert.equal((await done).status, 'cancelled');
});

test('a provider error is reported as the failure it is, not as the time limit', async () => {
  const t = slowSetup(new FakeModel([{ error: { category: 'provider_fatal', message: 'bad key' } }]), 60_000);
  const task = await t.run('go');
  assert.equal(task.status, 'failed');
  assert.match(task.reason ?? '', /bad key/);
});

test('the wall-clock limit also stops a running tool', async () => {
  const running = started();
  const hang: ToolDefinition = {
    name: 'hang', version: 1, description: 'never returns', input: z.object({}), capability: 'fs.read', idempotent: true,
    async run(_input, ctx) {
      running.signal();
      const keepAlive = setInterval(() => {}, 1000); // a real tool holds a socket; abort timers do not keep the process alive
      await new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(null), { once: true }));
      clearInterval(keepAlive);
      return { content: 'stopped' };
    },
  };
  const t = slowSetup(new FakeModel([{ toolCalls: [{ name: 'hang', input: {} }] }, { text: 'never' }]), 300, [hang]);
  const task = await t.run('go');
  await running.promise;
  assert.equal(task.status, 'budget_exhausted');
  assert.match(task.reason ?? '', /time limit/);
});

test('a wall limit beyond the timer range still works', async () => {
  const t = slowSetup(new FakeModel([{ toolCalls: [{ name: 'ping', input: {} }] }, { text: 'ok' }]), 2 ** 40, [
    { name: 'ping', version: 1, description: 'ping', input: z.object({}), capability: 'fs.read', idempotent: true, run: async () => ({ content: 'pong' }) },
  ]);
  assert.equal((await t.run('go')).status, 'completed');
});
