// Optional built-ins (skills, connectors) are chosen once per session and frozen with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { ActiveExtras, ToolDefinition } from '../contracts/index.ts';
import { FakeModel, type FakeScript } from '../models/index.ts';
import { Policy } from '../policy/index.ts';
import { openDb, SessionStore } from '../store/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from '../tools/index.ts';
import { Agent } from './index.ts';

const fakeConnector = (name: string): ToolDefinition => ({
  name, version: 1, description: `${name} connector`, input: z.object({}), capability: 'fs.read', idempotent: true,
  async run() { return { content: `${name} ran` }; },
});

function setup(script: FakeScript, choose: () => ActiveExtras) {
  const store = new SessionStore(openDb(':memory:'));
  const registry = new ToolRegistry();
  for (const t of [...fileTools, fakeConnector('weather'), fakeConnector('github')]) registry.register(t);
  const config = defaultConfig();
  const model = new FakeModel(script);
  const calls: string[] = [];
  const agent = new Agent({
    store, model, registry, workspace: tempDir(), maxOutputTokens: 1000, budget: config.budgets,
    executor: new ToolExecutor({ registry, policy: new Policy(config.permissions), approver: async () => 'approved' }),
    selectExtras: (sessionId) => {
      calls.push(sessionId);
      return choose();
    },
    connectorOfTool: (name) => (name === 'weather' || name === 'github' ? name : undefined),
    promptSections: (_ns, _sessionId, extras) => [`Active skills: ${extras.skills.join(', ') || 'none'}`],
    compactAtTokens: 10_000,
    keepTurns: 1,
    sleep: async () => {},
  });
  return { store, model, agent, calls, session: store.createSession() };
}

test('only the session’s connectors are frozen into its tools, and its skills into its prompt', async () => {
  const t = setup([{ text: 'hi' }], () => ({ skills: ['web-research'], connectors: ['weather'] }));
  await t.agent.run(t.session.id, 'hello');
  const req = t.model.requests[0]!;
  const names = req.tools.map((s) => s.name);
  assert.ok(names.includes('weather'));
  assert.ok(!names.includes('github'), 'a connector that is off for this session is not offered');
  assert.ok(names.includes('read_file'), 'ordinary tools are unaffected');
  assert.match(req.system, /Active skills: web-research/);
  const frozen = t.store.events(t.session.id).find((e) => e.type === 'context_frozen');
  assert.deepEqual(frozen?.type === 'context_frozen' && frozen.extras, { skills: ['web-research'], connectors: ['weather'] });
});

test('a tool outside the session’s set is refused even if the model calls it', async () => {
  const t = setup([{ toolCalls: [{ name: 'github', input: {} }] }, { text: 'ok' }], () => ({ skills: [], connectors: [] }));
  await t.agent.run(t.session.id, 'check github');
  const result = t.store.events(t.session.id).find((e) => e.type === 'tool_finished');
  assert.equal(result?.type === 'tool_finished' && result.result.status, 'error');
  assert.match(result?.type === 'tool_finished' ? result.result.content : '', /not available in this session/);
});

test('the set is chosen once: later turns and compaction keep it even when config would now say otherwise', async () => {
  let current: ActiveExtras = { skills: ['daily-briefing'], connectors: ['weather'] };
  const t = setup(
    [
      { text: 'one', usage: { inputTokens: 20_000, outputTokens: 5 } },
      { text: '<summary>earlier</summary>' }, // compaction before turn two (the first turn crossed compactAtTokens)
      { text: 'two' },
      { text: 'three' },
    ],
    () => current,
  );
  await t.agent.run(t.session.id, 'first');
  current = { skills: [], connectors: ['github'] }; // the owner changed config.json and restarted
  await t.agent.run(t.session.id, 'second');
  await t.agent.run(t.session.id, 'third');
  assert.equal(t.calls.length, 1, 'chosen exactly once');
  const frozen = t.store.events(t.session.id).filter((e) => e.type === 'context_frozen');
  assert.equal(frozen.length, 2, 'frozen at the first task and again at compaction');
  for (const f of frozen) assert.deepEqual(f.type === 'context_frozen' && f.extras, { skills: ['daily-briefing'], connectors: ['weather'] });
  const last = t.model.requests.at(-1)!;
  assert.ok(last.tools.some((s) => s.name === 'weather') && !last.tools.some((s) => s.name === 'github'));
  assert.match(last.system, /Active skills: daily-briefing/);

  // A new session (what /new does) asks again and gets the new set.
  const fresh = t.store.createSession();
  await t.agent.run(fresh.id, 'hi');
  assert.equal(t.calls.length, 2);
  assert.ok(t.model.requests.at(-1)!.tools.some((s) => s.name === 'github'));
});
