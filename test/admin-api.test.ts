import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from './helpers.ts';
import { createBackend } from '../src/backend.ts';
import { ApiServer } from '../src/gateway/index.ts';
import { FakeModel } from '../src/models/index.ts';
import { buildService, createRuby } from '../src/main.ts';

async function boot() {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, jobs: [{ id: 'tea', kind: 'heartbeat', everyMinutes: 60, instructions: 'Tea?' }] }));
  const ruby = createRuby({ home, model: new FakeModel([{ text: 'Brewing.' }]), memoryDb: true });
  const { gateway, scheduler } = buildService(ruby, () => {}, [], false);
  const api = new ApiServer({ gateway, keys: ruby.keys, keyStore: ruby.keyStore, sessions: ruby.store, rateLimitPerMinute: 1000, version: 't', admin: createBackend(ruby, gateway, scheduler, 't') });
  const { port } = await api.listen('127.0.0.1', 0);
  after(async () => {
    await api.close(0);
    ruby.close();
  });
  const admin = ruby.keys.create('admin', ['admin']).key;
  const reader = ruby.keys.create('reader', ['read']).key;
  const call = (method: string, path: string, key: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ruby, home, admin, reader, call };
}

test('reads need read scope; changes need admin', async () => {
  const s = await boot();
  assert.equal((await s.call('GET', '/api/overview', s.reader)).status, 200);
  assert.equal((await s.call('GET', '/api/keys', s.reader)).status, 403, 'listing keys is admin-only');
  assert.equal((await s.call('PUT', '/api/memory/user', s.reader, { content: '- likes tea' })).status, 403);
  const ok = await s.call('PUT', '/api/memory/user', s.admin, { content: '- likes tea' });
  assert.equal(ok.status, 200);
  const mem = (await (await s.call('GET', '/api/memory', s.reader)).json()) as { files: { file: string; content: string }[] };
  assert.match(mem.files.find((f) => f.file === 'user')!.content, /likes tea/);
});

test('config edits are validated and written', async () => {
  const s = await boot();
  const { config, schema } = (await (await s.call('GET', '/api/config', s.reader)).json()) as { config: any; schema: any };
  assert.ok(schema.properties.model.description);
  const bad = await s.call('PUT', '/api/config', s.admin, { ...config, api: { ...config.api, port: 0 } });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as any).error.message, /api\.port/);
  const good = await s.call('PUT', '/api/config', s.admin, { ...config, persona: 'Be brief.' });
  assert.equal(((await good.json()) as any).restartRequired, true);
});

test('jobs run on demand, keys are shown once, achievements and easter eggs', async () => {
  const s = await boot();
  const run = (await (await s.call('POST', '/api/jobs/tea/run', s.admin)).json()) as any;
  assert.equal(run.last.status, 'completed');
  const created = (await (await s.call('POST', '/api/keys', s.admin, { name: 'phone', scopes: ['chat'] })).json()) as any;
  assert.match(created.key, /^ruby_/);
  const list = JSON.stringify(await (await s.call('GET', '/api/keys', s.admin)).json());
  assert.ok(!list.includes(created.key.split('_')[2]), 'secrets are never listed');
  assert.equal(((await (await s.call('POST', '/api/achievements/regular/unlock', s.reader)).json()) as any).unlocked, false);
  assert.equal(((await (await s.call('POST', '/api/achievements/konami/unlock', s.reader)).json()) as any).unlocked, true);
  const ach = (await (await s.call('GET', '/api/achievements', s.reader)).json()) as any;
  assert.ok(ach.achievements.find((a: any) => a.id === 'hello-ruby').unlockedAt, 'the job run completed a task');
  assert.ok(ach.achievements.find((a: any) => a.id === 'open-door').unlockedAt);
});

test('archived skills stay restorable; encoded ids route; config errors are structured', async () => {
  const s = await boot();
  s.ruby.skills.create('tidy', 'Tidy things', 'Steps.');
  s.ruby.skills.archive('tidy');
  const list = (await (await s.call('GET', '/api/skills', s.reader)).json()) as any;
  assert.deepEqual(list.archived.map((x: any) => x.name), ['tidy']);
  assert.equal((await s.call('GET', '/api/skills/tidy', s.reader)).status, 200);
  assert.equal((await s.call('POST', '/api/skills/tidy/unarchive', s.admin)).status, 200);
  s.ruby.gatewayStore.addIdentity('signal', 'ada@example', 'Ada');
  const revoked = (await (await s.call('DELETE', `/api/identities/signal/${encodeURIComponent('ada@example')}`, s.admin)).json()) as any;
  assert.equal(revoked.revoked, true);
  const { config } = (await (await s.call('GET', '/api/config', s.reader)).json()) as any;
  const bad = (await (await s.call('PUT', '/api/config', s.admin, { ...config, api: { ...config.api, port: 0 } })).json()) as any;
  assert.ok(bad.error.issues.some((i: string) => i.startsWith('api.port')));
});
