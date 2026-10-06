// `ruby dashboard` login links: short-lived, one-time, never a long-lived key in a URL.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from './helpers.ts';
import { createBackend } from '../src/backend.ts';
import { dashboard, dashboardUrl, LOGIN_LINK_MINUTES } from '../src/cli/admin.ts';
import { ApiServer } from '../src/gateway/index.ts';
import { FakeModel } from '../src/models/index.ts';
import { buildService, createRuby } from '../src/main.ts';

// The dashboard's own module (plain browser JS without a DOM dependency).
const loginModule = join(import.meta.dirname, '..', 'dashboard', 'login.js');
const { credentialIn, exchangeLoginKey, SESSION_DAYS } = (await import(loginModule)) as {
  credentialIn: (hash: string) => { kind: string; key: string } | null;
  exchangeLoginKey: (key: string, request: (key: string, method: string, path: string, body?: unknown) => Promise<any>) => Promise<string>;
  SESSION_DAYS: number;
};

test('the dashboard URL opens loopback for wildcard binds and brackets IPv6', () => {
  assert.equal(dashboardUrl('127.0.0.1', 7311), 'http://127.0.0.1:7311/');
  assert.equal(dashboardUrl('0.0.0.0', 1), 'http://127.0.0.1:1/');
  assert.equal(dashboardUrl('::', 1), 'http://127.0.0.1:1/');
  assert.equal(dashboardUrl('::1', 7311), 'http://[::1]:7311/');
  assert.equal(dashboardUrl('ruby.lan', 80), 'http://ruby.lan:80/');
});

test('`ruby dashboard` prints a one-time link holding a key that expires in minutes', () => {
  const home = tempDir();
  const saved = process.env.RUBY_HOME;
  process.env.RUBY_HOME = home;
  try {
    const out: string[] = [];
    assert.equal(dashboard({ out: (t) => out.push(t), err: () => {} }), 0);
    const text = out.join('');
    const m = /http:\/\/127\.0\.0\.1:7311\/#login=(ruby_\w+)/.exec(text);
    assert.ok(m, text);
    assert.ok(!text.includes('#key='), 'no long-lived key in the link');
    assert.match(text, /works once/);
    const ruby = createRuby({ home, noModel: true });
    try {
      const row = ruby.keys.list().find((k) => k.id === m[1]!.split('_')[1]);
      assert.ok(row?.expiresAt);
      const minutes = (Date.parse(row.expiresAt) - Date.now()) / 60_000;
      assert.ok(minutes > LOGIN_LINK_MINUTES - 1 && minutes <= LOGIN_LINK_MINUTES, `expires in ${minutes} minutes`);
    } finally {
      ruby.close();
    }
  } finally {
    if (saved === undefined) delete process.env.RUBY_HOME;
    else process.env.RUBY_HOME = saved;
  }
});

test('credentials are recognised only in the fragment forms the dashboard uses', () => {
  assert.deepEqual(credentialIn('#login=ruby_abc_def'), { kind: 'login', key: 'ruby_abc_def' });
  assert.deepEqual(credentialIn('#/overview&key=ruby_abc_def'), { kind: 'key', key: 'ruby_abc_def' });
  assert.equal(credentialIn('#/overview'), null);
  assert.equal(credentialIn(''), null);
});

test('a login key is exchanged once for a session key and then stops working', async () => {
  const home = tempDir();
  const ruby = createRuby({ home, model: new FakeModel(), memoryDb: true });
  const { gateway, scheduler } = buildService(ruby, () => {}, [], false);
  const api = new ApiServer({ gateway, keys: ruby.keys, keyStore: ruby.keyStore, sessions: ruby.store, rateLimitPerMinute: 1000, version: 't', admin: createBackend(ruby, gateway, scheduler, 't') });
  const { port } = await api.listen('127.0.0.1', 0);
  after(async () => {
    await api.close(0);
    ruby.close();
  });
  const request = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  };
  const login = ruby.keys.create('dashboard login', ['admin'], LOGIN_LINK_MINUTES / 1440).key;
  const sessionKey = await exchangeLoginKey(login, request);
  assert.notEqual(sessionKey, login);
  assert.ok(await request(sessionKey, 'GET', '/api/overview'), 'the session key works');
  await assert.rejects(request(login, 'GET', '/api/overview'), (e: { status?: number }) => e.status === 401, 'the login key is revoked');
  await assert.rejects(exchangeLoginKey(login, request), (e: { status?: number }) => e.status === 401, 'the link works only once');
  const row = ruby.keys.list().find((k) => k.id === sessionKey.split('_')[1])!;
  const days = (Date.parse(row.expiresAt!) - Date.now()) / 86_400_000;
  assert.ok(days > SESSION_DAYS - 0.01 && days <= SESSION_DAYS, 'the session key is short-lived too');
  assert.deepEqual(row.scopes, ['admin']);
});
