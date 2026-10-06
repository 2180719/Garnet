import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isRubyError } from '../contracts/index.ts';
import { CONFIG_VERSION, defaultConfig, loadConfig, parseConfig, parseEnv, redact, setInEnvFile } from './index.ts';

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
    assert.ok(isRubyError(e, 'config'));
    const problems = e.detail?.problems as string[];
    assert.ok(problems.some((p) => p.startsWith('api.port')));
    assert.ok(problems.some((p) => p.includes('bogus')));
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
    assert.throws(() => parseConfig({ version: CONFIG_VERSION, sandbox: { user } }), (e) => isRubyError(e, 'config'), user);
  }
});

test('config from a newer Ruby is rejected', () => {
  assert.throws(() => parseConfig({ version: CONFIG_VERSION + 1 }), /newer than this Ruby/);
});

test('redact hides secrets but keeps env var names', () => {
  const out = redact({ apiKeyEnv: 'ANTHROPIC_API_KEY', token: 'abc', note: 'key sk-ant-abcdefghijklmnopqrstu here' });
  assert.equal(out.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.note, 'key [redacted] here');
});

test('redact hides Ruby API keys in strings', () => {
  const key = `ruby_${'a1B2c3D4'}_${'x'.repeat(32)}`;
  assert.equal(redact(`using ${key} now`), 'using [redacted] now');
});

test('protected config paths', async () => {
  const { isProtectedConfigPath, changedProtectedPaths } = await import('./index.ts');
  assert.ok(isProtectedConfigPath('permissions.exec'));
  assert.ok(isProtectedConfigPath('channels.telegram.tokenEnv'));
  assert.ok(isProtectedConfigPath('model.apiKeyEnv'));
  assert.ok(!isProtectedConfigPath('persona'));
  assert.ok(!isProtectedConfigPath('api.rateLimitPerMinute'));
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
