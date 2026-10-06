// Failure injection: model provider faults, tool faults and budgets, through the real gateway and agent loop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { ModelEvent, ModelRequest, ToolDefinition } from '../src/contracts/index.ts';
import type { RuntimeEvent } from '../src/runtime/index.ts';
import { msg, setup } from './fixtures.ts';

const noSleep = async () => {};
const overloaded = { error: { category: 'provider_transient' as const, message: 'overloaded_error (529)' } };

function tool(name: string, run: ToolDefinition['run'], timeoutMs?: number): ToolDefinition {
  return { name, version: 1, description: name, input: z.object({}), capability: 'fs.read', idempotent: true, ...(timeoutMs ? { timeoutMs } : {}), run };
}

const chat = (t: ReturnType<typeof setup>, text: string, signal?: AbortSignal) => {
  const events: RuntimeEvent[] = [];
  const done = t.gateway.chat('c', text, { source: 'test', onEvent: (e) => events.push(e), ...(signal ? { signal } : {}) });
  return Object.assign(done, { events });
};

/** Replaces the model's stream with scripted attempts; each attempt is a list of events (or a function that throws). */
function scriptStream(t: ReturnType<typeof setup>, attempts: (ModelEvent[] | (() => never))[]) {
  const original = t.model.stream.bind(t.model);
  let i = 0;
  t.model.stream = async function* (req: ModelRequest) {
    const next = attempts[i++];
    if (!next) return yield* original(req);
    if (typeof next === 'function') next();
    else yield* next;
  } as typeof t.model.stream;
}

/** AbortSignal.timeout timers are unref'd, so a test whose only pending work is a timeout needs something to keep the loop alive. */
const keepAlive = () => {
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);
};

const events = (t: ReturnType<typeof setup>, sessionId: string) => t.sessions.events(sessionId);

test('overloaded responses are retried and the task then completes', async () => {
  const t = setup([overloaded, overloaded, { text: 'Here you go.' }], { agent: { sleep: noSleep } });
  const run = chat(t, 'hi');
  const { task, text, sessionId } = await run;
  assert.equal(task.status, 'completed');
  assert.equal(text, 'Here you go.');
  assert.equal(t.model.requests.length, 3);
  assert.deepEqual(run.events.filter((e) => e.type === 'retry').map((e) => e.type === 'retry' && e.attempt), [1, 2]);
  assert.equal(events(t, sessionId).filter((e) => e.type === 'model_error').length, 0, 'recovered faults leave no error in history');
  assert.equal(events(t, sessionId).filter((e) => e.type === 'assistant_message').length, 1);
});

test('a retry-after hint from the provider is honoured', async () => {
  const delays: number[] = [];
  const t = setup([], { agent: { sleep: async (ms) => void delays.push(ms) } });
  scriptStream(t, [[{ type: 'error', category: 'provider_transient', message: '429', retryAfterMs: 1234 }]]);
  const { task } = await chat(t, 'hi');
  assert.equal(task.status, 'completed');
  assert.deepEqual(delays, [1234]);
});

test('retries are bounded: a provider that stays down fails the task with a clear reason', async () => {
  const t = setup([overloaded, overloaded, overloaded, overloaded, overloaded, { text: 'never' }], { agent: { sleep: noSleep, maxRetries: 3 } });
  const { task, text, sessionId } = await chat(t, 'hi');
  assert.equal(task.status, 'failed');
  assert.equal(t.model.requests.length, 4, 'one attempt plus three retries');
  assert.match(task.reason ?? '', /provider_transient.*overloaded/);
  assert.match(text, /couldn't finish/);
  assert.equal(events(t, sessionId).filter((e) => e.type === 'model_error').length, 1);
  assert.equal(t.sessions.unfinishedTasks().length, 0);
});

test('a stream that dies after text was shown is not retried (it would duplicate output) and leaves no partial message', async () => {
  const t = setup([], { agent: { sleep: noSleep } });
  scriptStream(t, [[{ type: 'text_delta', text: 'The answer is ' }, { type: 'error', category: 'provider_transient', message: 'connection reset' }]]);
  const { task, sessionId } = await chat(t, 'hi');
  assert.equal(task.status, 'failed');
  assert.equal(t.model.requests.length, 0, 'no second attempt');
  assert.equal(events(t, sessionId).filter((e) => e.type === 'assistant_message').length, 0, 'a half answer is never stored as history');
});

test('an adapter that throws mid-stream fails the task cleanly instead of crashing the caller', async () => {
  const t = setup([], { agent: { sleep: noSleep } });
  scriptStream(t, [() => { throw new Error('TypeError: terminated'); }]);
  const { task } = await chat(t, 'hi');
  assert.equal(task.status, 'failed');
  assert.match(task.reason ?? '', /terminated/);
  assert.ok(task.endedAt);
});

test('a stream that ends with no result is a failure, not a hang', async () => {
  const t = setup([], { agent: { sleep: noSleep } });
  scriptStream(t, [[{ type: 'text_delta', text: 'partial' }]]);
  const { task } = await chat(t, 'hi');
  assert.equal(task.status, 'failed');
  assert.match(task.reason ?? '', /without a result/);
});

test('a non-retryable model error reaches the user in chat and the conversation stays usable', async () => {
  const t = setup([{ error: { category: 'provider_fatal', message: 'invalid x-api-key' } }, { text: 'Back again.' }], { agent: { sleep: noSleep } });
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  await t.channel.sink!(msg('hello'));
  await t.lanes.idle();
  await t.gateway.deliver();
  assert.equal(t.model.requests.length, 1, 'fatal errors are not retried');
  assert.equal(t.channel.sent.length, 1);
  assert.match(t.channel.sent[0]!.text, /couldn't finish.*invalid x-api-key/);
  assert.equal(t.store.inboxByStatus('done').length, 1);
  await t.channel.sink!(msg('try again'));
  await t.lanes.idle();
  await t.gateway.deliver();
  assert.equal(t.channel.sent[1]!.text, 'Back again.');
  await t.gateway.stop(0);
});

test('a task that crashes the agent outright gets a generic apology and is marked done, never re-run', async () => {
  const t = setup([{ text: 'never' }], { agent: { sleep: noSleep } });
  t.store.addIdentity('fake', 'u1', 'Ada');
  t.sessions.createTask = () => { throw new Error('database exploded'); };
  await t.gateway.start();
  await t.channel.sink!(msg('hello'));
  await t.lanes.idle();
  await t.gateway.deliver();
  assert.match(t.channel.sent[0]!.text, /something went wrong/);
  assert.doesNotMatch(t.channel.sent[0]!.text, /database exploded/, 'internals are not leaked to the chat');
  assert.equal(t.store.inboxByStatus('done').length, 1);
  assert.equal(t.model.requests.length, 0);
  await t.gateway.stop(0);
});

test('model-call budget exhaustion stops a runaway loop and tells the user', async () => {
  const loop = Array.from({ length: 20 }, () => ({ toolCalls: [{ name: 'list_files', input: {} }] }));
  const t = setup(loop, { agent: { budget: { maxModelCalls: 3, maxToolCalls: 50, maxTokens: 1_000_000, maxWallMs: 60_000 } } });
  t.store.addIdentity('fake', 'u1', 'Ada');
  await t.gateway.start();
  await t.channel.sink!(msg('loop forever'));
  await t.lanes.idle();
  await t.gateway.deliver();
  assert.equal(t.model.requests.length, 3);
  assert.match(t.channel.sent[0]!.text, /Stopped early: Reached the limit of 3 model calls/);
  assert.equal(t.sessions.unfinishedTasks().length, 0);
  await t.gateway.stop(0);
});

test('token and wall-clock budgets stop the task too', async () => {
  const big = { toolCalls: [{ name: 'list_files', input: {} }], usage: { inputTokens: 600, outputTokens: 0 } };
  const tokens = setup([big, big, big], { agent: { budget: { maxModelCalls: 50, maxToolCalls: 50, maxTokens: 1000, maxWallMs: 60_000 } } });
  const a = await chat(tokens, 'go');
  assert.equal(a.task.status, 'budget_exhausted');
  assert.match(a.task.reason ?? '', /1000 tokens/);

  const wall = setup([big, big], { agent: { budget: { maxModelCalls: 50, maxToolCalls: 50, maxTokens: 1_000_000, maxWallMs: 0 } } });
  const b = await chat(wall, 'go');
  assert.equal(b.task.status, 'budget_exhausted');
  assert.equal(wall.model.requests.length, 0, 'the model is never called once the time budget is gone');
});

test('the tool-call budget turns further calls into error results instead of running them', async () => {
  let runs = 0;
  const t = setup([{ toolCalls: [{ name: 'count', input: {} }, { name: 'count', input: {} }, { name: 'count', input: {} }] }, { text: 'ok' }], {
    tools: [tool('count', async () => ({ content: String(++runs) }))],
    agent: { budget: { maxModelCalls: 10, maxToolCalls: 2, maxTokens: 1_000_000, maxWallMs: 60_000 } },
  });
  const { task, sessionId } = await chat(t, 'go');
  assert.equal(task.status, 'completed');
  assert.equal(runs, 2);
  const results = events(t, sessionId).flatMap((e) => (e.type === 'tool_finished' ? [e.result] : []));
  assert.equal(results.length, 3);
  assert.ok(results[2]!.status === 'error' && results[2]!.category === 'budget_exhausted');
});

test('a tool that throws returns an error result to the model and the loop continues', async () => {
  const t = setup(
    [
      { toolCalls: [{ name: 'explode', input: {} }] },
      (req) => {
        const r = req.messages.at(-1)!.content[0];
        assert.ok(r?.type === 'tool_result' && r.isError && /disk on fire/.test(r.content), JSON.stringify(r));
        return { text: 'The tool failed, so I could not do that.' };
      },
    ],
    { tools: [tool('explode', async () => { throw new Error('disk on fire'); })] },
  );
  const { task, text, sessionId } = await chat(t, 'go');
  assert.equal(task.status, 'completed');
  assert.equal(text, 'The tool failed, so I could not do that.');
  const types = events(t, sessionId).map((e) => e.type);
  assert.ok(types.indexOf('tool_started') < types.indexOf('tool_finished'), 'intent is recorded before the effect');
});

test('a tool that throws a non-Error, or throws synchronously, is contained', async () => {
  const sync = tool('sync_throw', (() => { throw new Error('sync boom'); }) as ToolDefinition['run']);
  const odd = tool('odd_throw', async () => { throw 'a bare string'; });
  const t = setup([{ toolCalls: [{ name: 'sync_throw', input: {} }, { name: 'odd_throw', input: {} }] }, { text: 'done' }], { tools: [sync, odd] });
  const { task, sessionId } = await chat(t, 'go');
  assert.equal(task.status, 'completed');
  const results = events(t, sessionId).flatMap((e) => (e.type === 'tool_finished' ? [e.result] : []));
  assert.deepEqual(results.map((r) => r.status), ['error', 'error']);
});

test('a tool that hangs past its limit times out, even if it ignores the abort signal, and the loop continues', async () => {
  let afterTimeout = false;
  const t = setup(
    [
      { toolCalls: [{ name: 'hang', input: {} }] },
      (req) => {
        const r = req.messages.at(-1)!.content[0];
        afterTimeout = true;
        assert.ok(r?.type === 'tool_result' && r.isError && /timed out/.test(r.content), JSON.stringify(r));
        return { text: 'It hung.' };
      },
    ],
    { tools: [tool('hang', () => new Promise(() => {}), 10)] },
  );
  const stop = keepAlive();
  const { task, sessionId } = await chat(t, 'go').finally(stop);
  assert.equal(task.status, 'completed');
  assert.ok(afterTimeout);
  const result = events(t, sessionId).flatMap((e) => (e.type === 'tool_finished' ? [e.result] : []))[0]!;
  assert.ok(result.status === 'error' && result.category === 'timeout');
});

test('cancelling while a tool hangs ends the task as cancelled without another model call', async () => {
  const ac = new AbortController();
  let started!: () => void;
  const toolRunning = new Promise<void>((r) => (started = r));
  const t = setup([{ toolCalls: [{ name: 'hang', input: {} }] }, { text: 'never' }], {
    tools: [tool('hang', () => { started(); return new Promise(() => {}); }, 60_000)],
  });
  const stop = keepAlive();
  const run = chat(t, 'go', ac.signal);
  await toolRunning;
  ac.abort();
  const { task } = await run.finally(stop);
  assert.equal(task.status, 'cancelled');
  assert.equal(t.model.requests.length, 1);
});

test('one failing tool in a batch does not stop its siblings', async () => {
  const ran: string[] = [];
  const t = setup([{ toolCalls: [{ name: 'bad', input: {} }, { name: 'good', input: {} }] }, { text: 'mixed results' }], {
    tools: [tool('bad', async () => { throw new Error('nope'); }), tool('good', async () => { ran.push('good'); return { content: 'fine' }; })],
  });
  const { task, sessionId } = await chat(t, 'go');
  assert.equal(task.status, 'completed');
  assert.deepEqual(ran, ['good']);
  const results = events(t, sessionId).flatMap((e) => (e.type === 'tool_finished' ? [e.result.status] : []));
  assert.deepEqual(results, ['error', 'ok']);
});
