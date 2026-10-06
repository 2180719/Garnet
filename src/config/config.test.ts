import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isRubyError } from '../contracts/index.ts';
import { CONFIG_VERSION, defaultConfig, loadConfig, parseConfig, redact } from './index.ts';

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

test('config from a newer Ruby is rejected', () => {
  assert.throws(() => parseConfig({ version: CONFIG_VERSION + 1 }), /newer than this Ruby/);
});

test('redact hides secrets but keeps env var names', () => {
  const out = redact({ apiKeyEnv: 'ANTHROPIC_API_KEY', token: 'abc', note: 'key sk-ant-abcdefghijklmnopqrstu here' });
  assert.equal(out.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.note, 'key [redacted] here');
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
