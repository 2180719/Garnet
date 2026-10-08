import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isGarnetError } from '../contracts/index.ts';
import { CONFIG_VERSION, defaultConfig, loadConfig, parseConfig, providerKeyEnv, parseEnv, redact, setInEnvFile, validBasic } from './index.ts';

test('validBasic: one visible line only (it goes into every future system prompt)', () => {
  const ok = validBasic(20);
  assert.equal(ok('Sam'), null);
  assert.equal(ok(''), null, 'empty means skip');
  for (const bad of ['a\nb', 'a\rb', 'a b', 'a b', 'a\u0085b', 'a\u0000b', 'a\u001bb', 'a\tb', '   ', ' ', 'x --> y', 'x'.repeat(21)]) {
    assert.notEqual(ok(bad), null, JSON.stringify(bad));
  }
});

test('defaults are secure', () => {
  const c = defaultConfig();
  assert.equal(c.api.enabled, false);
  assert.equal(c.api.host, '127.0.0.1');
  assert.equal(c.dashboard.enabled, false);
  assert.equal(c.permissions.exec, 'deny');
  assert.equal(c.permissions['fs.write'], 'ask');
});

test('invalid config lists every problem', () => {
  try {
    parseConfig({ version: CONFIG_VERSION, api: { port: 0 }, bogus: true });
    assert.fail('expected an error');
  } catch (e) {
    assert.ok(isGarnetError(e, 'config'));
    const problems = e.detail?.problems as string[];
    assert.ok(problems.some((p) => p.startsWith('api.port')));
    assert.ok(problems.some((p) => p.includes('bogus')));
  }
});

test('chat: fullscreen with mouse wheel by default; an existing config without it needs no migration', () => {
  assert.deepEqual(defaultConfig().chat, { fullscreen: true, mouse: true });
  assert.deepEqual(parseConfig({ version: CONFIG_VERSION, chat: { fullscreen: false } }).chat, { fullscreen: false, mouse: true });
  assert.throws(() => parseConfig({ version: CONFIG_VERSION, chat: { fullScreen: false } }), (e) => isGarnetError(e, 'config'), 'a typo is an error');
});

test('timezone and api.corsOrigins are validated; CORS is off by default', () => {
  assert.deepEqual(defaultConfig().api.corsOrigins, []);
  assert.equal(defaultConfig().timezone, undefined);
  const c = parseConfig({ version: CONFIG_VERSION, timezone: 'Europe/London', api: { corsOrigins: ['https://chat.example.com', 'http://localhost:3000'] } });
  assert.equal(c.timezone, 'Europe/London');
  for (const bad of [{ timezone: 'Mars/Olympus' }, { api: { corsOrigins: ['*'] } }, { api: { corsOrigins: ['https://chat.example.com/app'] } }]) {
    assert.throws(() => parseConfig({ version: CONFIG_VERSION, ...bad }), (e) => isGarnetError(e, 'config'));
  }
});

test('config without a version is migrated and backed up', () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persona: 'Be brief.' }));
  const { config, migrated } = loadConfig(home);
  assert.equal(migrated, true);
  assert.equal(config.persona, 'Be brief.');
  assert.ok(existsSync(join(home, 'config.json.bak-v0')));
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).version, CONFIG_VERSION);
});

test('a second migration keeps the earlier backup', () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json.bak-v0'), 'earlier backup');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persona: 'Second.' }));
  assert.equal(loadConfig(home).migrated, true);
  assert.equal(readFileSync(join(home, 'config.json.bak-v0'), 'utf8'), 'earlier backup');
  const backups = readdirSync(home).filter((n) => n.startsWith('config.json.bak-v0-'));
  assert.equal(backups.length, 1);
  assert.match(readFileSync(join(home, backups[0]!), 'utf8'), /Second/);
});

test('sandbox.user is optional uid:gid and never root', () => {
  assert.equal(defaultConfig().sandbox.user, undefined);
  assert.equal(parseConfig({ version: CONFIG_VERSION, sandbox: { user: '1000:1000' } }).sandbox.user, '1000:1000');
  for (const user of ['0:0', '0:1000', 'root', '1000']) {
    assert.throws(() => parseConfig({ version: CONFIG_VERSION, sandbox: { user } }), (e) => isGarnetError(e, 'config'), user);
  }
});

test('config from a newer Garnet is rejected', () => {
  assert.throws(() => parseConfig({ version: CONFIG_VERSION + 1 }), /newer than this Garnet/);
});

test('redact hides secrets but keeps env var names', () => {
  const out = redact({ apiKeyEnv: 'ANTHROPIC_API_KEY', token: 'abc', note: 'key sk-ant-abcdefghijklmnopqrstu here' });
  assert.equal(out.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.note, 'key [redacted] here');
});

test('redact hides Garnet API keys in strings', () => {
  const key = `garnet_${'a1B2c3D4'}_${'x'.repeat(32)}`;
  assert.equal(redact(`using ${key} now`), 'using [redacted] now');
});

test('protected config paths', async () => {
  const { isProtectedConfigPath, changedProtectedPaths } = await import('./index.ts');
  assert.ok(isProtectedConfigPath('permissions.exec'));
  assert.ok(isProtectedConfigPath('channels.telegram.tokenEnv'));
  assert.ok(isProtectedConfigPath('model.apiKeyEnv'));
  assert.ok(!isProtectedConfigPath('persona'));
  assert.ok(!isProtectedConfigPath('api.rateLimitPerMinute'));
  // Arrays are single leaves, so a script job added through the API changes the protected `jobs` leaf.
  assert.ok(isProtectedConfigPath('jobs'));
  assert.deepEqual(changedProtectedPaths({ jobs: [] }, { jobs: [{ id: 'j', kind: 'heartbeat', everyMinutes: 1, script: { command: 'touch x' } }] }), ['jobs']);
  assert.deepEqual(changedProtectedPaths({ jobs: [{ id: 'j' }] }, { jobs: [{ id: 'j' }] }), []);
  assert.deepEqual(changedProtectedPaths({ a: 1, model: { baseUrl: 'x' } }, { a: 2, model: { baseUrl: 'y' } }), ['model.baseUrl']);
});

test('env file loads without overriding existing variables', async () => {
  const { loadEnvFile } = await import('./index.ts');
  const home = tempDir();
  writeFileSync(join(home, 'env'), '# secrets\nA_KEY="one"\nexport B_KEY=two\nC_KEY=three\n', { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { C_KEY: 'kept' };
  const { loaded, warning } = loadEnvFile(home, env);
  assert.deepEqual(loaded, ['A_KEY', 'B_KEY']);
  assert.equal(env.A_KEY, 'one');
  assert.equal(env.C_KEY, 'kept');
  assert.equal(warning, null);
});

test('setInEnvFile replaces, de-duplicates and appends, keeps other lines, quotes when needed, mode 0600', () => {
  const home = tempDir();
  setInEnvFile(home, { A: 'one' });
  assert.equal(readFileSync(join(home, 'env'), 'utf8'), 'A=one\n');
  assert.equal(statSync(join(home, 'env')).mode & 0o777, 0o600);
  writeFileSync(join(home, 'env'), '# keep me\nexport A=old\nB=2\nA=dup\n');
  setInEnvFile(home, { A: 'new', C: '/path with space/key' });
  const text = readFileSync(join(home, 'env'), 'utf8');
  assert.equal(text, "# keep me\nA=new\nB=2\nC='/path with space/key'\n");
  assert.deepEqual([...parseEnv(text)], [['A', 'new'], ['B', '2'], ['C', '/path with space/key']]);
  assert.throws(() => setInEnvFile(home, { 'BAD-NAME': 'x' }), /Invalid variable name/);
  assert.throws(() => setInEnvFile(home, { A: 'two\nlines' }), /single line/);
});

test('owner timezone, one-shot, message and script jobs validate', () => {
  assert.equal(parseConfig({ version: CONFIG_VERSION, timezone: 'Europe/London' }).timezone, 'Europe/London');
  assert.throws(() => parseConfig({ version: CONFIG_VERSION, timezone: 'Mars/Olympus' }), /timezone: Unknown time zone/);
  const c = defaultConfig();
  assert.equal(c.timezone, undefined, 'unset means the host zone');
  assert.equal(c.scheduler.maxAgentJobs, 25);
  assert.equal(c.gateway.messagesPerHour, 20);
  const jobs = (j: object) => parseConfig({ version: CONFIG_VERSION, jobs: [{ id: 'j', ...j }] }).jobs[0]!;
  assert.equal(jobs({ kind: 'once', at: '2026-12-24T09:00:00+01:00', message: 'Hi' }).at, '2026-12-24T09:00:00+01:00');
  assert.equal(jobs({ kind: 'heartbeat', everyMinutes: 30, script: { command: 'date' } }).script?.timeoutSeconds, 60);
  assert.throws(() => jobs({ kind: 'once', message: 'Hi' }), /once jobs need `at`/);
  assert.throws(() => jobs({ kind: 'once', at: '2026-12-24 09:00', message: 'Hi' }), /at/);
  assert.throws(() => jobs({ kind: 'heartbeat', everyMinutes: 30 }), /exactly one of instructions, message or script/);
  assert.throws(() => jobs({ kind: 'heartbeat', everyMinutes: 30, message: 'a', instructions: 'b' }), /exactly one of/);
  assert.throws(() => jobs({ kind: 'heartbeat', everyMinutes: 30, message: 'a', notify: { channel: 'irc', chatId: '1' } }), /notify.channel must be/);
});

test('media: safe defaults, transcription validation, protected host commands, secret names', async () => {
  const { isProtectedConfigPath, secretNames } = await import('./index.ts');
  const c = defaultConfig();
  assert.equal(c.media.enabled, true);
  assert.equal(c.media.transcription.backend, 'none');
  assert.equal(c.media.pdfText.command, undefined);
  assert.equal(c.media.maxBytes, 20 * 1024 * 1024);
  assert.equal(c.model.vision, undefined, 'decided per provider');
  const bad = (media: object) => {
    try {
      parseConfig({ version: CONFIG_VERSION, media });
      return [];
    } catch (e) {
      return (e as { detail?: { problems?: string[] } }).detail?.problems ?? [];
    }
  };
  assert.ok(bad({ transcription: { backend: 'openai-compatible' } }).some((p) => p.startsWith('media.transcription.baseUrl')));
  assert.ok(bad({ transcription: { backend: 'command' } }).some((p) => p.startsWith('media.transcription.command')));
  assert.ok(bad({ transcription: { backend: 'none', path: 'no-slash' } }).some((p) => p.startsWith('media.transcription.path')));
  assert.deepEqual(bad({ transcription: { backend: 'command', command: ['whisper-cli', '-f', '{input}'] } }), []);
  for (const p of ['media.transcription.command', 'media.transcription.baseUrl', 'media.transcription.apiKeyEnv', 'media.pdfText.command']) assert.ok(isProtectedConfigPath(p), p);
  assert.ok(!isProtectedConfigPath('media.maxInContext'));
  const withKey = parseConfig({ version: CONFIG_VERSION, media: { transcription: { backend: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' } } });
  assert.ok(secretNames(withKey).includes('GROQ_API_KEY'));
  assert.ok(!secretNames(c).includes('GROQ_API_KEY'));
});

test('model.pricing and budgets.dailyUsd are optional and validated', () => {
  const c = defaultConfig();
  assert.equal(c.model.pricing, undefined);
  assert.equal(c.budgets.dailyUsd, undefined);
  const p = parseConfig({ version: CONFIG_VERSION, model: { pricing: { input: 3, output: 15 } }, budgets: { dailyUsd: 5 } });
  assert.deepEqual(p.model.pricing, { input: 3, output: 15 });
  assert.equal(p.budgets.dailyUsd, 5);
  for (const bad of [{ model: { pricing: { input: -1, output: 1 } } }, { model: { pricing: { input: 1 } } }, { budgets: { dailyUsd: 0 } }]) {
    assert.throws(() => parseConfig({ version: CONFIG_VERSION, ...bad }), (e) => isGarnetError(e, 'config'));
  }
});

test('sandbox.ssh: documented non-secret options, safe defaults, required fields only for the ssh backend', async () => {
  const { isProtectedConfigPath, secretNames, configSchema } = await import('./index.ts');
  const d = defaultConfig();
  assert.equal(d.sandbox.backend, 'docker');
  assert.equal(d.sandbox.ssh.hostKeyChecking, 'strict');
  assert.equal(d.sandbox.ssh.port, 22);
  assert.equal(d.sandbox.ssh.agent, false);
  assert.equal(d.sandbox.ssh.host, undefined);
  const ok = { backend: 'ssh', ssh: { host: 'build.example.com', user: 'garnet', workdir: '/srv/garnet', agent: true } };
  const c = parseConfig({ version: CONFIG_VERSION, sandbox: ok });
  assert.equal(c.sandbox.ssh.hostKeyChecking, 'strict');
  assert.equal(c.sandbox.ssh.connectTimeoutSeconds, 10);
  const bad = (ssh: Record<string, unknown>) => () => parseConfig({ version: CONFIG_VERSION, sandbox: { backend: 'ssh', ssh: { ...ok.ssh, ...ssh } } });
  assert.throws(bad({ host: undefined }), (e) => isGarnetError(e, 'config') && /needs sandbox\.ssh\.host/.test((e as Error).message));
  assert.throws(bad({ workdir: undefined }), (e) => isGarnetError(e, 'config'));
  assert.throws(bad({ agent: false }), /identityFile or sandbox\.ssh\.agent/);
  assert.doesNotThrow(bad({ agent: false, identityFile: '/home/o/.ssh/id' }));
  assert.throws(bad({ hostKeyChecking: 'ask' }), (e) => isGarnetError(e, 'config'));
  assert.throws(bad({ port: 70000 }), (e) => isGarnetError(e, 'config'));
  assert.throws(bad({ passphraseEnv: 'not a name' }), (e) => isGarnetError(e, 'config'));
  assert.throws(bad({ passphrase: 'literal secret' }), (e) => isGarnetError(e, 'config'), 'no secret value fields');
  // The docker backend needs none of it.
  assert.doesNotThrow(() => parseConfig({ version: CONFIG_VERSION, sandbox: { backend: 'docker' } }));
  // Protected from the admin API, named (never valued) in secretNames only when used.
  assert.ok(isProtectedConfigPath('sandbox.ssh.host') && isProtectedConfigPath('sandbox.backend') && isProtectedConfigPath('sandbox.ssh.hostKeyChecking'));
  const withPass = parseConfig({ version: CONFIG_VERSION, sandbox: { ...ok, ssh: { ...ok.ssh, agent: false, identityFile: '/k', passphraseEnv: 'GARNET_SSH_KEY_PASSPHRASE' } } });
  assert.ok(secretNames(withPass).includes('GARNET_SSH_KEY_PASSPHRASE'));
  assert.ok(!secretNames(parseConfig({ version: CONFIG_VERSION, sandbox: { backend: 'docker', ssh: { passphraseEnv: 'UNUSED' } } })).includes('UNUSED'));
  // Every ssh field is documented (config explain renders these).
  const ssh = (configSchema.toJSONSchema() as unknown as { properties: { sandbox: { properties: { ssh: { properties: Record<string, { description?: string }> } } } } }).properties.sandbox.properties.ssh.properties;
  for (const key of ['host', 'port', 'user', 'workdir', 'identityFile', 'agent', 'passphraseEnv', 'hostKeyChecking', 'knownHostsFile', 'connectTimeoutSeconds', 'sshPath']) {
    assert.ok(ssh[key]?.description && !ssh[key]!.description!.includes('—'), key);
  }
});

test('providerKeyEnv derives a valid, distinct secret name that never hits a well-known or already-used key', () => {
  const c = defaultConfig();
  assert.equal(providerKeyEnv(c, 'my-laptop'), 'MY_LAPTOP_API_KEY');
  assert.equal(providerKeyEnv(c, '1x'), 'GARNET_1X_API_KEY');
  assert.equal(providerKeyEnv(c, 'anthropic'), 'GARNET_ANTHROPIC_API_KEY');
  assert.equal(providerKeyEnv(c, 'local-model'), 'GARNET_LOCAL_MODEL_API_KEY');
  const withKey = parseConfig({ version: CONFIG_VERSION, providers: { other: { provider: 'openai-compatible', baseUrl: 'https://x.example/v1', name: 'm', apiKeyEnv: 'MY_LAPTOP_API_KEY' } } });
  assert.equal(providerKeyEnv(withKey, 'my-laptop'), 'GARNET_MY_LAPTOP_API_KEY');
  assert.equal(providerKeyEnv(c, 'brave'), 'GARNET_BRAVE_API_KEY', 'web search default');
  const web = parseConfig({ version: CONFIG_VERSION, web: { search: { backend: 'brave', apiKeyEnv: 'MY_SEARCH_API_KEY' } } });
  assert.equal(providerKeyEnv(web, 'my-search'), 'GARNET_MY_SEARCH_API_KEY', 'a configured credential of another subsystem');
  const both = parseConfig({ version: CONFIG_VERSION, providers: { 'garnet-anthropic': { provider: 'openai-compatible', baseUrl: 'https://x.example/v1', name: 'm', apiKeyEnv: 'GARNET_ANTHROPIC_API_KEY' } } });
  assert.equal(providerKeyEnv(both, 'anthropic'), 'GARNET_GARNET_ANTHROPIC_API_KEY', 'the prefixed name is rechecked');
});

test('a version 3 config (before delegation and the http connector) migrates to the current version with defaults', () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 3, persona: 'Old.' }));
  const { config, migrated } = loadConfig(home);
  assert.equal(migrated, true);
  assert.ok(existsSync(join(home, 'config.json.bak-v3')));
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).version, CONFIG_VERSION);
  assert.equal(config.delegation.enabled, true);
  assert.equal(config.delegation.maxDepth, 2);
  assert.deepEqual(config.connectors.http, { credentials: {}, write: false });
});

test('http credentials are named in secretNames only while the http connector is on, and are protected', async () => {
  const { isProtectedConfigPath, secretNames } = await import('./index.ts');
  const credentials = { notion: { secretEnv: 'NOTION_TOKEN', hosts: ['api.notion.com'] } };
  assert.ok(!secretNames(parseConfig({ version: CONFIG_VERSION, connectors: { http: { credentials } } })).includes('NOTION_TOKEN'));
  assert.ok(secretNames(parseConfig({ version: CONFIG_VERSION, connectors: { enabled: ['http'], http: { credentials } } })).includes('NOTION_TOKEN'));
  assert.ok(isProtectedConfigPath('connectors.http.credentials.notion.hosts'));
  assert.ok(isProtectedConfigPath('connectors.http.write'));
});
