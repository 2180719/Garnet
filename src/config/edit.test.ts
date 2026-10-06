import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGarnetError } from '../contracts/index.ts';
import { changeConfig, configSchema, defaultConfig, getConfigValue, parseConfigValue, showConfigValue, unknownGarnetEnv } from './index.ts';

test('parseConfigValue reads JSON, else text', () => {
  assert.deepEqual(parseConfigValue('42'), 42);
  assert.deepEqual(parseConfigValue('true'), true);
  assert.deepEqual(parseConfigValue('["a","b"]'), ['a', 'b']);
  assert.equal(parseConfigValue('claude-opus'), 'claude-opus');
});

test('changeConfig validates with the schema and lists problems', () => {
  const c = defaultConfig();
  assert.equal(changeConfig(c, 'api.port', 8080).config.api.port, 8080);
  assert.throws(() => changeConfig(c, 'api.port', 0), (e) => isGarnetError(e, 'config'));
  assert.throws(() => changeConfig(c, 'api.bogus', 1), (e) => isGarnetError(e, 'config'));
  assert.throws(() => changeConfig(c, '__proto__.x', 1), (e) => isGarnetError(e, 'config'));
  assert.equal(c.api.port, defaultConfig().api.port, 'the input is not mutated');
});

test('secret NAME fields refuse secret values and non-names; plain fields refuse credential shapes', () => {
  const c = defaultConfig();
  assert.equal(changeConfig(c, 'model.apiKeyEnv', 'MY_KEY').config.model.apiKeyEnv, 'MY_KEY');
  for (const bad of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'my key', 'abcDEF0123456789abcdefABCDEF0123456789abcdefABCD']) {
    assert.throws(() => changeConfig(c, 'model.apiKeyEnv', bad), (e) => isGarnetError(e, 'config') && !String((e as Error).message).includes(bad));
  }
  assert.throws(() => changeConfig(c, 'persona', 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), (e) => isGarnetError(e, 'config'));
  assert.equal(showConfigValue('x.token', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), '"[redacted]"');
});

test('unset returns a field to its default', () => {
  const c = changeConfig(defaultConfig(), 'api.port', 8080).config;
  const r = changeConfig(c, 'api.port', undefined, true);
  assert.equal(r.after, defaultConfig().api.port);
  assert.equal(getConfigValue(r.config, 'api.port'), defaultConfig().api.port);
});

test('GARNET_* variables nothing reads are reported; known ones are not', () => {
  assert.deepEqual(unknownGarnetEnv({ GARNET_HOME: '/x', GARNET_NODE: 'n', GARNET_MODEL: 'm', PATH: '/bin' }), ['GARNET_MODEL']);
  // The calendar connector's default secret name, and any secret name the config points at (an ssh passphrase), are read.
  const env = { GARNET_CALENDAR_URL: 'https://cal.example/x.ics', GARNET_SSH_KEY_PASSPHRASE: 'p', GARNET_MODEL: 'm' };
  assert.deepEqual(unknownGarnetEnv(env), ['GARNET_MODEL', 'GARNET_SSH_KEY_PASSPHRASE']);
  assert.deepEqual(unknownGarnetEnv(env, ['GARNET_SSH_KEY_PASSPHRASE']), ['GARNET_MODEL']);
});

test('every setting in the schema is described, so `garnet config explain` covers it', () => {
  type S = { description?: string; properties?: Record<string, S>; items?: S };
  const missing: string[] = [];
  const walk = (s: S, path: string) => {
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (!v.description) missing.push(`${path}${k}`);
      walk(v, `${path}${k}.`);
    }
    if (s.items) walk(s.items, `${path}[].`);
  };
  walk(configSchema.toJSONSchema() as S, '');
  assert.deepEqual(missing.filter((m) => m !== 'version'), []);
});
