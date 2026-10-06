import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
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

test('session log is paged, read-only, and never shows secrets, thinking or the frozen prompt', async () => {
  const s = await boot();
  const session = s.ruby.store.createSession('telegram chat');
  s.ruby.gatewayStore.bindConversation('telegram:main:42', session.id);
  s.ruby.store.append(session.id, { type: 'context_frozen', system: 'SYSTEM with memory: likes tea' });
  s.ruby.store.append(session.id, { type: 'user_message', source: 'telegram', message: { role: 'user', content: [{ type: 'text', text: 'my key is sk-abcdefghijklmnopqrstuvwxyz123456' }] } });
  s.ruby.store.append(session.id, {
    type: 'assistant_message',
    stopReason: 'tool_use',
    model: 'fake',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null },
    message: { role: 'assistant', content: [{ type: 'provider', provider: 'anthropic', data: { thinking: 'SECRET THOUGHTS' }, bound: true }, { type: 'tool_call', id: 'c1', name: 'shell', input: { cmd: 'ls', apiKey: 'hunter2' } }] },
  });
  s.ruby.store.append(session.id, { type: 'tool_finished', callId: 'c1', operationId: 'op', result: { status: 'ok', content: 'x'.repeat(10_000), truncated: false, durationMs: 3 } });
  for (let i = 0; i < 3; i++) s.ruby.store.append(session.id, { type: 'model_error', category: 'transient', message: `oops ${i}` });
  const task = s.ruby.store.createTask(session.id, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: null });
  task.status = 'completed';
  s.ruby.store.updateTask(task);

  const list = (await (await s.call('GET', '/api/log/sessions?q=telegram', s.reader)).json()) as any;
  assert.equal(list.total, 1);
  assert.equal(list.items[0].conversation, 'telegram:main:42');
  assert.equal(list.items[0].taskStatus, 'completed');
  assert.deepEqual(list.items[0].usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: null });
  assert.equal(list.items[0].events, 7);
  assert.equal(list.items[0].tainted, false);
  assert.equal(((await (await s.call('GET', '/api/log/sessions?q=nothing-like-this', s.reader)).json()) as any).total, 0);

  const first = (await (await s.call('GET', `/api/log/sessions/${session.id}/events?limit=4`, s.reader)).json()) as any;
  assert.equal(first.events.length, 4);
  assert.equal(first.lastSeq, 7);
  assert.equal(first.nextAfter, 4);
  const second = (await (await s.call('GET', `/api/log/sessions/${session.id}/events?limit=4&after=${first.nextAfter}`, s.reader)).json()) as any;
  assert.deepEqual(second.events.map((e: any) => e.seq), [5, 6, 7]);
  assert.equal(second.nextAfter, null);

  const text = JSON.stringify(first) + JSON.stringify(second);
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz'), 'key-shaped values are redacted');
  assert.ok(!text.includes('hunter2'), 'secret-named fields are redacted');
  assert.ok(!text.includes('SECRET THOUGHTS'), 'provider (thinking) blocks are omitted');
  assert.ok(!text.includes('likes tea'), 'the frozen prompt is not sent');
  assert.match(text, /more characters not shown/);

  // Untrusted content is flagged in the list and shown as its own event.
  s.ruby.store.append(session.id, { type: 'tainted', source: 'web_fetch https://evil.example/', callId: 'c1' });
  const tainted = (await (await s.call('GET', '/api/log/sessions?q=telegram', s.reader)).json()) as any;
  assert.equal(tainted.items[0].tainted, true);
  const last = (await (await s.call('GET', `/api/log/sessions/${session.id}/events?after=7`, s.reader)).json()) as any;
  assert.deepEqual(last.events.map((e: any) => [e.type, e.source]), [['tainted', 'web_fetch https://evil.example/']]);

  assert.equal((await s.call('GET', '/api/log/sessions/ses_missing/events', s.reader)).status, 400);
  assert.equal((await s.call('GET', '/api/log/sessions?limit=0', s.reader)).status, 400);
  assert.equal((await s.call('GET', '/api/log/sessions?limit=1000', s.reader)).status, 400);
  assert.equal((await s.call('GET', `/api/log/sessions/${session.id}/events?after=-1`, s.reader)).status, 400);
  assert.equal((await s.call('GET', '/api/log/sessions', 'ruby_nope_nope')).status, 401);
});

test('audit log and failures are paged and filterable', async () => {
  const s = await boot();
  for (let i = 0; i < 5; i++) s.ruby.keyStore.audit({ keyId: 'k1', ip: '127.0.0.1', method: 'GET', path: `/api/thing${i}`, status: i === 4 ? 404 : 200 });
  s.ruby.keyStore.audit({ keyId: null, ip: null, method: 'POST', path: '/api/pairing/ABC123/approve', status: 200 });
  const p1 = (await (await s.call('GET', '/api/log/audit?limit=3&keyId=k1&status=2xx', s.reader)).json()) as any;
  assert.equal(p1.total, 4);
  assert.equal(p1.entries.length, 3);
  const p2 = (await (await s.call('GET', '/api/log/audit?limit=3&offset=3&keyId=k1&status=2xx', s.reader)).json()) as any;
  assert.deepEqual([...p1.entries, ...p2.entries].map((e: any) => e.path), ['/api/thing3', '/api/thing2', '/api/thing1', '/api/thing0']);
  const bad = (await (await s.call('GET', '/api/log/audit?status=404&keyId=k1', s.reader)).json()) as any;
  assert.deepEqual(bad.entries.map((e: any) => e.path), ['/api/thing4']);
  const post = (await (await s.call('GET', '/api/log/audit?method=POST&q=pairing', s.reader)).json()) as any;
  assert.equal(post.entries[0].path, '/api/pairing/…/approve', 'pairing codes are masked');
  assert.equal(((await (await s.call('GET', '/api/log/audit?q=%25', s.reader)).json()) as any).total, 0, 'LIKE wildcards are escaped');

  const session = s.ruby.store.createSession('x');
  const a = s.ruby.store.createTask(session.id, { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null });
  a.status = 'failed';
  a.reason = 'boom with Bearer abcdefghijklmnopqrstuvwxyz0123';
  a.endedAt = new Date().toISOString();
  s.ruby.store.updateTask(a);
  const out = s.ruby.gatewayStore.enqueue({ channel: 'telegram', account: 'main', chatId: '1', text: 'private reply' });
  s.ruby.gatewayStore.markOutbox(out.deliveryId, 'failed', 'HTTP 500');
  const all = (await (await s.call('GET', '/api/log/failures?limit=1', s.reader)).json()) as any;
  assert.equal(all.total, 2);
  assert.equal(all.items.length, 1);
  const next = (await (await s.call('GET', '/api/log/failures?limit=1&offset=1', s.reader)).json()) as any;
  assert.notEqual(next.items[0].id, all.items[0].id);
  const tasks = (await (await s.call('GET', '/api/log/failures?kind=task', s.reader)).json()) as any;
  assert.equal(tasks.total, 1);
  assert.equal(tasks.items[0].ref, session.id);
  assert.ok(!JSON.stringify(tasks).includes('abcdefghijklmnopqrstuvwxyz0123'));
  assert.ok(!JSON.stringify(all).includes('private reply'), 'message text is not exposed');
  assert.equal(((await (await s.call('GET', '/api/log/failures?status=uncertain', s.reader)).json()) as any).total, 0);
});

test('routing is readable with read scope; unlinking and denying need admin', async () => {
  const s = await boot();
  const one = s.ruby.store.createSession('a');
  const two = s.ruby.store.createSession('b');
  s.ruby.gatewayStore.bindConversation('telegram:main:1', one.id);
  s.ruby.gatewayStore.bindConversation('route:home', two.id);
  s.ruby.gatewayStore.addIdentity('telegram', '1', 'Ada');
  s.ruby.gatewayStore.addPairing({ code: 'ABCD2345', channel: 'telegram', account: 'main', senderId: '9', senderName: 'Eve', chatId: '9', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });

  const r = (await (await s.call('GET', '/api/routing?limit=1', s.reader)).json()) as any;
  assert.equal(r.conversations.total, 2);
  assert.equal(r.conversations.items.length, 1);
  assert.equal(r.identities.length, 1);
  assert.equal(r.pending.length, 1);
  const r2 = (await (await s.call('GET', '/api/routing?limit=1&offset=1', s.reader)).json()) as any;
  assert.notEqual(r2.conversations.items[0].key, r.conversations.items[0].key);

  assert.equal((await s.call('DELETE', '/api/conversations/telegram%3Amain%3A1', s.reader)).status, 403);
  assert.equal((await s.call('DELETE', '/api/pairing/ABCD2345', s.reader)).status, 403);
  assert.equal(s.ruby.gatewayStore.conversation('telegram:main:1'), one.id, 'a refused unlink changes nothing');

  const un = (await (await s.call('DELETE', '/api/conversations/telegram%3Amain%3A1', s.admin)).json()) as any;
  assert.equal(un.removed, true);
  assert.equal(s.ruby.gatewayStore.conversation('telegram:main:1'), undefined);
  assert.ok(s.ruby.store.getSession(one.id), 'the session and its log are kept');
  assert.equal(((await (await s.call('DELETE', '/api/conversations/telegram%3Amain%3A1', s.admin)).json()) as any).removed, false);
  assert.equal(((await (await s.call('DELETE', '/api/pairing/ABCD2345', s.admin)).json()) as any).removed, true);
  assert.equal(s.ruby.gatewayStore.pairings(new Date().toISOString()).length, 0);
});

test('protected config fields cannot be changed over the API; GET returns the file', async () => {
  const s = await boot();
  const file = join(s.home, 'config.json');
  const { config } = (await (await s.call('GET', '/api/config', s.admin)).json()) as any;
  const before = readFileSync(file, 'utf8');
  for (const bad of [
    { ...config, model: { ...config.model, apiKeyEnv: 'HOME', baseUrl: 'https://evil.example/v1' } },
    { ...config, sandbox: { ...config.sandbox, backend: 'local' }, permissions: { ...config.permissions, exec: 'allow' } },
  ]) {
    const r = await s.call('PUT', '/api/config', s.admin, bad);
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as any).error.message, /model\.apiKeyEnv|sandbox\.backend/);
  }
  assert.equal(readFileSync(file, 'utf8'), before, 'file unchanged');
  assert.equal((await s.call('PUT', '/api/config', s.admin, { ...config, persona: 'Be terse.' })).status, 200);
  const after = (await (await s.call('GET', '/api/config', s.reader)).json()) as any;
  assert.equal(after.config.persona, 'Be terse.', 'GET reflects the saved file');
  assert.ok(after.protectedPaths.includes('model.apiKeyEnv'));
});

test('raw session events are sanitized for read keys', async () => {
  const s = await boot();
  const session = s.ruby.store.createSession('x');
  s.ruby.store.append(session.id, { type: 'context_frozen', system: 'SYSTEM with memory: likes tea' });
  s.ruby.store.append(session.id, {
    type: 'assistant_message',
    stopReason: 'end_turn',
    model: 'fake',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null },
    message: { role: 'assistant', content: [{ type: 'provider', provider: 'anthropic', data: { thinking: 'SECRET THOUGHTS' }, bound: true }] },
  });
  const res = await s.call('GET', `/api/sessions/${session.id}/events`, s.reader);
  assert.equal(res.status, 200);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes('likes tea') && !text.includes('SECRET THOUGHTS'), 'frozen prompt and thinking are not exposed');
});

test('redactingLog hides key-shaped values before they reach the sink', async () => {
  const { redactingLog } = await import('../src/main.ts');
  const seen: string[] = [];
  redactingLog((_l, m) => seen.push(m))('info', `key ruby_${'a'.repeat(8)}_${'b'.repeat(32)} and sk-abcdefghijklmnopqrstuvwxyz`);
  assert.ok(!seen[0]!.includes('ruby_a') && !seen[0]!.includes('sk-abc'));
});
