// Optional built-ins wired end to end: config → registry → per-session frozen set → skill_view.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { CONFIG_VERSION } from '../src/config/index.ts';
import { FakeModel } from '../src/models/index.ts';
import { KICKOFF_MESSAGE, ONBOARDING_TITLE, bootstrapPrompt } from '../src/onboarding/index.ts';
import { createGarnet, extrasForScopes } from '../src/main.ts';

function homeWith(config: Record<string, unknown>): string {
  const home = join(tempDir(), 'garnet-home');
  createGarnet({ home, memoryDb: true, noModel: true }).close();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: CONFIG_VERSION, ...config }));
  return home;
}

const CONFIG = {
  skills: { channels: { telegram: { enable: ['web-research'] }, 'telegram:42': { enable: ['daily-briefing'] } } },
  connectors: { enabled: ['github'], channels: { telegram: { enable: ['weather'], disable: ['github'] } } },
};

test('nothing optional is registered or offered by default', async () => {
  const model = new FakeModel([{ text: 'hi' }]);
  const garnet = createGarnet({ home: homeWith({}), memoryDb: true, model });
  try {
    assert.deepEqual(garnet.connectors, []);
    for (const t of ['github', 'calendar', 'weather']) assert.equal(garnet.registry.get(t), undefined);
    const session = garnet.store.createSession();
    await garnet.agent.run(session.id, 'hello');
    assert.ok(!model.requests[0]!.system.includes('Built-in skills'));
    assert.deepEqual(garnet.extrasFor(session.id), { skills: [], connectors: [] });
  } finally {
    garnet.close();
  }
});

test('each conversation gets the set for its scope, frozen into its tools and prompt', async () => {
  const model = new FakeModel([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const garnet = createGarnet({ home: homeWith(CONFIG), memoryDb: true, model });
  try {
    assert.deepEqual(garnet.connectors, ['github', 'weather'], 'registered when on anywhere');
    const chat42 = garnet.store.createSession();
    garnet.gatewayStore.bindConversation('telegram:default:42', chat42.id);
    const chat7 = garnet.store.createSession();
    garnet.gatewayStore.bindConversation('telegram:default:7', chat7.id);
    const terminal = garnet.store.createSession();

    await garnet.agent.run(chat42.id, 'hi');
    await garnet.agent.run(chat7.id, 'hi');
    await garnet.agent.run(terminal.id, 'hi');
    const tools = (i: number) => model.requests[i]!.tools.map((t) => t.name);
    assert.ok(tools(0).includes('weather') && !tools(0).includes('github'));
    assert.ok(tools(1).includes('weather') && !tools(1).includes('github'));
    assert.ok(tools(2).includes('github') && !tools(2).includes('weather'), 'the terminal (cli scope) gets the global list');
    assert.match(model.requests[0]!.system, /Built-in skills \(shipped with Garnet\)[^]*- daily-briefing:[^]*- web-research:/);
    assert.match(model.requests[1]!.system, /- web-research:/);
    assert.ok(!model.requests[1]!.system.includes('daily-briefing'));
    assert.ok(!model.requests[2]!.system.includes('Built-in skills'));
    assert.deepEqual(garnet.extrasFor(chat42.id), { skills: ['daily-briefing', 'web-research'], connectors: ['weather'] });
    assert.deepEqual(extrasForScopes(garnet.config, ['job', 'job:x'], garnet.connectors), { skills: [], connectors: ['github'] });
  } finally {
    garnet.close();
  }
});

test('skill_view reads an active built-in; one that is off for the session is unknown to it', async () => {
  const model = new FakeModel([
    { toolCalls: [{ name: 'skill_view', input: { name: 'daily-briefing' } }, { name: 'skill_view', input: { name: 'github-triage' } }] },
    { text: 'done' },
  ]);
  const garnet = createGarnet({ home: homeWith(CONFIG), memoryDb: true, model });
  try {
    const s = garnet.store.createSession();
    garnet.gatewayStore.bindConversation('telegram:default:42', s.id);
    await garnet.agent.run(s.id, 'brief me');
    const results = garnet.store.events(s.id).flatMap((e) => (e.type === 'tool_finished' ? [e.result] : []));
    assert.equal(results[0]!.status, 'ok');
    assert.match(results[0]!.content, /# Skill: daily-briefing \(built in\)/);
    assert.equal(results[1]!.status, 'error');
    assert.match(results[1]!.content, /No skill named "github-triage"/);
  } finally {
    garnet.close();
  }
});

test('a running conversation keeps its set after config changes; /new (a new session) picks up the change', async () => {
  const home = homeWith(CONFIG);
  const first = createGarnet({ home, model: new FakeModel([{ text: 'one' }]) });
  const session = first.store.createSession();
  first.gatewayStore.bindConversation('telegram:default:7', session.id);
  await first.agent.run(session.id, 'hi');
  first.close();

  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: CONFIG_VERSION, connectors: { enabled: ['github', 'weather'], channels: { telegram: { disable: ['weather'] } } } }));
  const model = new FakeModel([{ text: 'two' }, { text: 'three' }]);
  const second = createGarnet({ home, model });
  try {
    await second.agent.run(session.id, 'again');
    const names = model.requests[0]!.tools.map((t) => t.name);
    assert.ok(names.includes('weather') && !names.includes('github'), 'the old session still has the set it started with');
    const fresh = second.store.createSession();
    second.gatewayStore.bindConversation('telegram:default:7', fresh.id);
    await second.agent.run(fresh.id, 'new conversation');
    const now = model.requests[1]!.tools.map((t) => t.name);
    assert.ok(now.includes('github') && !now.includes('weather'));
  } finally {
    second.close();
  }
});

test('connectors need net.fetch: with it denied none is registered or offered', () => {
  const garnet = createGarnet({ home: homeWith({ ...CONFIG, permissions: { 'net.fetch': 'deny' } }), memoryDb: true, noModel: true });
  try {
    assert.deepEqual(garnet.connectors, []);
    assert.equal(garnet.registry.get('weather'), undefined);
    assert.deepEqual(extrasForScopes(garnet.config, ['telegram'], garnet.connectors).connectors, []);
  } finally {
    garnet.close();
  }
});

test('wake-up and connectors coexist: the onboarding session gets set_profile and the bootstrap prompt, a scope session keeps its connector through compaction', async () => {
  const home = homeWith({
    ...CONFIG,
    permissions: { 'memory.write': 'ask', 'net.fetch': 'ask' },
    context: { compactAtTokens: 10_000, keepTurns: 1 },
  });
  const model = new FakeModel([
    { text: 'hello, I am new here' }, // the wake-up session
    { text: 'one', usage: { inputTokens: 20_000, outputTokens: 5 } }, // the Telegram chat crosses compactAtTokens
    { text: '<summary>earlier</summary>' }, // compaction before its next turn
    { text: 'two' },
  ]);
  const garnet = createGarnet({ home, memoryDb: true, model, onboarding: true });
  try {
    const wake = garnet.store.createSession(ONBOARDING_TITLE);
    await garnet.agent.run(wake.id, KICKOFF_MESSAGE);
    const wakeReq = model.requests[0]!;
    assert.ok(wakeReq.tools.some((t) => t.name === 'set_profile'), 'the onboarding session can save the profile');
    assert.ok(wakeReq.system.includes(bootstrapPrompt()), 'and gets the bootstrap prompt');
    assert.ok(wakeReq.tools.some((t) => t.name === 'github') && !wakeReq.tools.some((t) => t.name === 'weather'), 'the terminal scope gets the global connectors only');

    const chat = garnet.store.createSession();
    garnet.gatewayStore.bindConversation('telegram:default:7', chat.id);
    await garnet.agent.run(chat.id, 'weather?');
    await garnet.agent.run(chat.id, 'and tomorrow?');
    const events = garnet.store.events(chat.id);
    assert.ok(events.some((e) => e.type === 'checkpoint'), 'the chat was compacted');
    const frozen = events.filter((e) => e.type === 'context_frozen');
    assert.equal(frozen.length, 2, 'frozen at the first task and again at compaction');
    for (const f of frozen) {
      assert.ok(f.type === 'context_frozen');
      assert.deepEqual(f.extras?.connectors, ['weather']);
      assert.ok(f.tools?.some((t) => t.name === 'weather') && !f.tools.some((t) => t.name === 'github'));
      assert.ok(!f.system.includes(bootstrapPrompt()), 'the bootstrap prompt belongs to the onboarding session only');
    }
    const last = model.requests.at(-1)!;
    assert.ok(last.tools.some((t) => t.name === 'weather'), 'the connector is still offered after compaction');
    assert.ok(!last.system.includes(bootstrapPrompt()));
    // The wake-up session's own freeze is untouched by the other session's compaction.
    const wakeFrozen = garnet.store.events(wake.id).filter((e) => e.type === 'context_frozen');
    assert.equal(wakeFrozen.length, 1);
    assert.ok(wakeFrozen[0]!.type === 'context_frozen' && wakeFrozen[0]!.system.includes(bootstrapPrompt()));
  } finally {
    garnet.close();
  }
});

test('a session keeps its connector after the last scope that enabled it is turned off and Garnet restarts, through compaction; a new session does not get it', async () => {
  const home = homeWith({ connectors: { channels: { telegram: { enable: ['weather'] } } }, permissions: { 'net.fetch': 'ask' } });
  const first = createGarnet({ home, model: new FakeModel([{ text: 'one' }]) });
  const session = first.store.createSession();
  first.gatewayStore.bindConversation('telegram:default:7', session.id);
  await first.agent.run(session.id, 'hi');
  first.close();

  // The owner turns weather off everywhere and restarts.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: CONFIG_VERSION, permissions: { 'net.fetch': 'ask' }, context: { compactAtTokens: 10_000, keepTurns: 1 } }));
  const model = new FakeModel([
    // Invalid input: the call reaches the weather tool, which refuses before any network request.
    { toolCalls: [{ name: 'weather', input: { latitude: 1 } }] },
    { text: 'ok', usage: { inputTokens: 20_000, outputTokens: 5 } }, // crosses compactAtTokens
    { text: '<summary>earlier</summary>' }, // compaction before the next turn
    { text: 'two' },
    { text: 'fresh' },
  ]);
  const second = createGarnet({ home, model, approver: async () => 'approved' });
  try {
    await second.agent.run(session.id, 'weather?');
    assert.ok(model.requests[0]!.tools.some((t) => t.name === 'weather'), 'the old session is still offered weather');
    assert.deepEqual(second.extrasFor(session.id).connectors, ['weather']);
    const result = second.store.events(session.id).find((e) => e.type === 'tool_finished');
    assert.ok(result?.type === 'tool_finished');
    assert.doesNotMatch(result.result.content, /Unknown tool/);
    assert.match(result.result.content, /both latitude and longitude/, 'the weather tool itself answered');

    await second.agent.run(session.id, 'and tomorrow?');
    const frozen = second.store.events(session.id).filter((e) => e.type === 'context_frozen');
    assert.equal(frozen.length, 2, 'compacted and frozen again');
    const last = frozen.at(-1)!;
    assert.ok(last.type === 'context_frozen' && last.tools?.some((t) => t.name === 'weather'), 'compaction keeps the connector tool');
    assert.deepEqual(last.type === 'context_frozen' && last.extras?.connectors, ['weather']);
    assert.ok(model.requests.at(-1)!.tools.some((t) => t.name === 'weather'));

    const fresh = second.store.createSession();
    second.gatewayStore.bindConversation('telegram:default:7', fresh.id);
    await second.agent.run(fresh.id, 'new conversation');
    assert.ok(!model.requests.at(-1)!.tools.some((t) => t.name === 'weather'), 'a new session gets only what config enables now');
    assert.deepEqual(second.extrasFor(fresh.id).connectors, []);
  } finally {
    second.close();
  }

  // net.fetch denied still means no connector tool at all, even for a session that had one.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: CONFIG_VERSION, permissions: { 'net.fetch': 'deny' } }));
  const third = createGarnet({ home, noModel: true });
  try {
    assert.equal(third.registry.get('weather'), undefined);
    assert.deepEqual(third.connectors, []);
  } finally {
    third.close();
  }
});
