// The composition root's own safety checks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { isGarnetError, startOfDayIso } from '../src/contracts/index.ts';
import { StatsStore } from '../src/store/index.ts';
import { createGarnet } from '../src/main.ts';

const withWorkspace = (workspace: string) => {
  const home = join(tempDir(), 'garnet-home');
  const parent = dirname(home);
  return { home, parent, config: { version: 1, workspace: workspace.replace('{home}', home).replace('{parent}', parent) } };
};

test('a workspace that contains Garnet’s home is refused: tools could rewrite config, secrets or skills', () => {
  for (const ws of ['{home}', '{parent}', '.', '..']) {
    const { home, config } = withWorkspace(ws);
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    assert.throws(() => createGarnet({ home, memoryDb: true, noModel: true }), (e) => isGarnetError(e, 'config') && /workspace/.test(e.message), ws);
  }
});

test('a workspace beside or below home is fine', () => {
  for (const ws of ['workspace', '{parent}/elsewhere', '{home}/deep/work']) {
    const { home, config } = withWorkspace(ws);
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    createGarnet({ home, memoryDb: true, noModel: true }).close();
  }
});

test('web tools follow net.fetch and the search backend; the owner policy carries containment', () => {
  const withConfig = (extra: Record<string, unknown>) => {
    const home = join(tempDir(), 'garnet-home');
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, ...extra }));
    return createGarnet({ home, memoryDb: true, noModel: true });
  };
  const names = (extra: Record<string, unknown>) => {
    const garnet = withConfig(extra);
    try {
      return garnet.registry.names().filter((n) => n.startsWith('web_'));
    } finally {
      garnet.close();
    }
  };
  assert.deepEqual(names({}), ['web_fetch', 'web_search'], 'net.fetch is ask by default');
  assert.deepEqual(names({ permissions: { 'net.fetch': 'deny' } }), []);
  assert.deepEqual(names({ web: { search: { backend: 'none' } } }), ['web_fetch']);
  assert.throws(() => withConfig({ web: { search: { backend: 'searxng' } } }), /searxngUrl/);

  const garnet = withConfig({ permissions: { 'net.fetch': 'allow', 'fs.write': 'allow' }, web: { allowHosts: ['example.com'] } });
  try {
    const taint = { sources: ['web_fetch https://evil.example/'], ownerUrls: new Set<string>(), seenUrls: new Set<string>() };
    assert.equal(garnet.ownerPolicy.check('fs.write', { taint }).verdict, 'ask');
    assert.equal(garnet.ownerPolicy.check('net.fetch', { targets: ['https://html.duckduckgo.com/html/?q=x'], taint }).verdict, 'allow', 'the configured search endpoint');
    assert.equal(garnet.ownerPolicy.check('net.fetch', { targets: ['https://example.com/?q=secret'], taint }).verdict, 'ask');
  } finally {
    garnet.close();
  }
});

test('budgets.dailyUsd refuses new model tasks once today\'s known cost reaches the cap', async () => {
  const home = join(tempDir(), 'garnet-home');
  createGarnet({ home, memoryDb: true, noModel: true }).close();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, model: { pricing: { input: 10, output: 10 } }, budgets: { dailyUsd: 1 } }));
  const garnet = createGarnet({ home, memoryDb: true, noModel: true });
  try {
    const session = garnet.store.createSession();
    const spent = garnet.store.createTask(session.id, { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    spent.modelCalls = 1;
    garnet.store.updateTask(spent);
    const task = await garnet.agent.run(session.id, 'hello');
    assert.equal(task.status, 'budget_exhausted');
    assert.match(task.reason ?? '', /Daily spending cap reached: \$1\.00 spent today \(/);
  } finally {
    garnet.close();
  }
});

function cappedGarnet(cfg: object) {
  const home = join(tempDir(), 'garnet-home');
  createGarnet({ home, memoryDb: true, noModel: true }).close();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, timezone: 'UTC', ...cfg }));
  return createGarnet({ home, memoryDb: true, noModel: true });
}

const used = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

test('daily cap: spend without a task row (manual compaction) counts toward it', async () => {
  const garnet = cappedGarnet({ model: { pricing: { input: 10, output: 10 } }, budgets: { dailyUsd: 1 } });
  try {
    new StatsStore(garnet.db).recordSpend(used(100_000));
    const task = await garnet.agent.run(garnet.store.createSession().id, 'hello');
    assert.equal(task.status, 'budget_exhausted');
    assert.match(task.reason ?? '', /Daily spending cap reached/);
  } finally {
    garnet.close();
  }
});

test('daily cap fails safe: a finished task of unknown cost, or no price at all, refuses new tasks', async () => {
  const garnet = cappedGarnet({ model: { pricing: { input: 10, output: 10 } }, budgets: { dailyUsd: 1 } });
  try {
    const session = garnet.store.createSession();
    const t = garnet.store.createTask(session.id, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
    t.modelCalls = 1;
    t.status = 'failed';
    t.endedAt = new Date().toISOString();
    garnet.store.updateTask(t);
    const task = await garnet.agent.run(session.id, 'hello');
    assert.equal(task.status, 'budget_exhausted');
    assert.match(task.reason ?? '', /unknown cost.*model\.pricing/);
  } finally {
    garnet.close();
  }
  const noPrice = cappedGarnet({ model: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', name: 'm' }, budgets: { dailyUsd: 1 } });
  try {
    const task = await noPrice.agent.run(noPrice.store.createSession().id, 'hello');
    assert.equal(task.status, 'budget_exhausted');
    assert.match(task.reason ?? '', /no known price/);
  } finally {
    noPrice.close();
  }
});

test('daily cap: partial custom pricing (no cache prices) derives them instead of making cost unknown', async () => {
  const garnet = cappedGarnet({ model: { pricing: { input: 10, output: 10 } }, budgets: { dailyUsd: 100 } });
  try {
    const session = garnet.store.createSession();
    const t = garnet.store.createTask(session.id, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    t.modelCalls = 1;
    t.status = 'completed';
    t.endedAt = new Date().toISOString();
    garnet.store.updateTask(t);
    const task = await garnet.agent.run(session.id, 'hello');
    assert.notEqual(task.status, 'budget_exhausted');
  } finally {
    garnet.close();
  }
});

test('daily cap uses the owner time zone for "today"', async () => {
  const tz = 'Pacific/Kiritimati';
  const midnight = new Date(startOfDayIso(tz)).getTime();
  const garnet = cappedGarnet({ timezone: tz, model: { pricing: { input: 10, output: 10 } }, budgets: { dailyUsd: 1 } });
  try {
    const session = garnet.store.createSession();
    const t = garnet.store.createTask(session.id, used(100_000));
    t.modelCalls = 1;
    garnet.store.updateTask(t);
    const setStart = (ms: number) => garnet.db.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(new Date(ms).toISOString(), t.id);
    setStart(midnight - 60_000); // yesterday in the owner's zone: not counted
    assert.notEqual((await garnet.agent.run(session.id, 'hello')).status, 'budget_exhausted');
    setStart(midnight); // today in the owner's zone: counted
    const task = await garnet.agent.run(session.id, 'hello');
    assert.equal(task.status, 'budget_exhausted');
    assert.match(task.reason ?? '', /Pacific\/Kiritimati/);
  } finally {
    garnet.close();
  }
});
