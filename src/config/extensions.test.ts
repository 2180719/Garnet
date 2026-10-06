import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { isGarnetError } from '../contracts/index.ts';
import {
  BUILTIN_SKILLS,
  CONFIG_VERSION,
  CONNECTORS,
  activeNames,
  changedProtectedPaths,
  defaultConfig,
  enabledAnywhere,
  isProtectedConfigPath,
  loadConfig,
  parseConfig,
  redact,
  resolveToggles,
  secretNames,
  setToggle,
  SCOPE_RE,
  type Toggles,
} from './index.ts';

test('built-in skills and connectors are all off by default', () => {
  const c = defaultConfig();
  assert.deepEqual(c.skills, { enabled: [], channels: {} });
  assert.deepEqual(c.connectors.enabled, []);
  assert.deepEqual(c.connectors.channels, {});
  assert.equal(c.connectors.github.write, false, 'no write access by default');
  assert.equal(c.connectors.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(c.connectors.calendar.urlEnv, 'GARNET_CALENDAR_URL');
  for (const kind of ['skills', 'connectors'] as const) assert.deepEqual(activeNames(kind === 'skills' ? BUILTIN_SKILLS : CONNECTORS, c[kind], ['telegram', 'telegram:1']), []);
});

test('a version 1 config is migrated to the current version with a backup, keeping every setting', () => {
  assert.equal(CONFIG_VERSION, 2);
  const home = tempDir();
  // A version 1 config may already use settings added without a version bump (ssh sandbox, persona markers).
  const v1 = {
    version: 1,
    timezone: 'Europe/London',
    permissions: { exec: 'ask' },
    persona: '<!-- garnet setup -->\nName: Garnet\n<!-- /garnet setup -->',
    sandbox: { backend: 'ssh', ssh: { host: 'box.example', user: 'garnet', workdir: '/srv/garnet', agent: true, passphraseEnv: 'SSH_PASS' } },
  };
  writeFileSync(join(home, 'config.json'), JSON.stringify(v1));
  const { config, migrated } = loadConfig(home);
  assert.equal(migrated, true);
  assert.equal(config.version, 2);
  assert.equal(config.timezone, 'Europe/London');
  assert.equal(config.permissions.exec, 'ask');
  assert.equal(config.persona, v1.persona);
  assert.equal(config.sandbox.backend, 'ssh');
  assert.equal(config.sandbox.ssh.host, 'box.example');
  assert.equal(config.sandbox.ssh.passphraseEnv, 'SSH_PASS');
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json.bak-v1'), 'utf8')).sandbox.ssh.host, 'box.example', 'the backup is the original file');
  assert.deepEqual(config.skills.enabled, []);
  assert.ok(readdirSync(home).includes('config.json.bak-v1'));
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).version, 2);
  // Version 0 (no version field) still goes all the way.
  assert.equal(parseConfig({}).version, 2);
});

test('names, scopes and overrides are validated', () => {
  const bad: object[] = [
    { skills: { enabled: ['not-a-skill'] } },
    { skills: { enabled: ['web-research', 'web-research'] } },
    { connectors: { enabled: ['gmail'] } },
    { connectors: { channels: { 'whatsapp': { enable: ['weather'] } } } },
    { connectors: { channels: { 'route:Family Chat': { enable: ['weather'] } } } },
    { connectors: { channels: { telegram: { enable: ['weather'], disable: ['weather'] } } } },
    { connectors: { channels: { telegram: { enable: ['weather'], bogus: [] } } } },
    { connectors: { github: { apiUrl: 'not a url' } } },
    { connectors: { github: { repos: ['../etc'] } } },
    { connectors: { calendar: { maxDays: 0 } } },
    { connectors: { weather: { units: 'kelvin' } } },
  ];
  for (const b of bad) assert.throws(() => parseConfig({ version: CONFIG_VERSION, ...b }), (e) => isGarnetError(e, 'config'), JSON.stringify(b));
  const ok = parseConfig({
    version: CONFIG_VERSION,
    skills: { enabled: ['web-research'], channels: { 'telegram:-100123': { disable: ['web-research'] }, 'signal:group:abc+/=': { enable: ['daily-briefing'] } } },
    connectors: { channels: { telegram: { enable: ['weather'] }, 'route:family': { disable: ['weather'] }, 'api:k1': {}, 'job:morning': { enable: ['calendar'] }, cli: { enable: ['github'] } }, github: { repos: ['me/*', 'org/app'] } },
  });
  assert.deepEqual(ok.skills.channels['telegram:-100123'], { enable: [], disable: ['web-research'] });
  assert.deepEqual(ok.connectors.channels['api:k1'], { enable: [], disable: [] });
  for (const scope of ['telegram', 'discord:123', 'signal:+15551234567', 'api', 'api:abc', 'cli', 'job', 'job:x', 'route:a-b']) assert.ok(SCOPE_RE.test(scope), scope);
  for (const scope of ['cli:x', 'route:', 'web', 'telegram:', 'TELEGRAM', 'telegram:a b']) assert.ok(!SCOPE_RE.test(scope), scope);
});

test('resolution: global list, then the channel, then the chat (narrowest wins)', () => {
  const t: Toggles = {
    enabled: ['github', 'weather'],
    channels: {
      telegram: { enable: ['calendar'], disable: ['github'] },
      'telegram:42': { enable: ['github'], disable: ['weather'] },
      'route:family': { disable: ['calendar'], enable: [] },
    },
  };
  const names = ['calendar', 'github', 'weather'];
  assert.deepEqual(activeNames(names, t, []), ['github', 'weather']);
  assert.deepEqual(activeNames(names, t, ['telegram']), ['calendar', 'weather']);
  assert.deepEqual(activeNames(names, t, ['telegram', 'telegram:42']), ['calendar', 'github']);
  assert.deepEqual(activeNames(names, t, ['telegram', 'route:family']), ['weather']);
  assert.deepEqual(activeNames(names, t, ['discord', 'discord:42']), ['github', 'weather'], 'another channel only gets the global list');
  assert.deepEqual(
    resolveToggles(names, t, ['telegram', 'telegram:42']),
    [
      { name: 'calendar', on: true, from: 'telegram' },
      { name: 'github', on: true, from: 'telegram:42' },
      { name: 'weather', on: false, from: 'telegram:42' },
    ],
  );
  assert.deepEqual(resolveToggles(['calendar'], { enabled: [], channels: {} }, ['cli']), [{ name: 'calendar', on: false, from: 'default' }]);
  assert.deepEqual(enabledAnywhere(t), ['calendar', 'github', 'weather']);
});

test('setToggle switches names globally or per scope, resets overrides and never mutates', () => {
  const start: Toggles = { enabled: [], channels: {} };
  const a = setToggle(start, 'weather', true);
  assert.deepEqual(a, { enabled: ['weather'], channels: {} });
  assert.deepEqual(start, { enabled: [], channels: {} });
  const b = setToggle(a, 'weather', false, 'telegram');
  assert.deepEqual(b.channels, { telegram: { enable: [], disable: ['weather'] } });
  const c = setToggle(b, 'weather', true, 'telegram');
  assert.deepEqual(c.channels, { telegram: { enable: ['weather'], disable: [] } }, 'enable replaces a disable in the same scope');
  const d = setToggle(c, 'weather', null, 'telegram');
  assert.deepEqual(d.channels, {}, 'an empty override is removed');
  assert.deepEqual(setToggle(d, 'weather', false).enabled, []);
  assert.deepEqual(setToggle(setToggle(start, 'b', true), 'a', true).enabled, ['a', 'b'], 'sorted');
});

test('connector secret names are known to `garnet secrets import-env` only when the connector is on; none are secrets themselves', () => {
  const off = defaultConfig();
  assert.ok(!secretNames(off).includes('GITHUB_TOKEN'));
  assert.ok(!secretNames(off).includes('GARNET_CALENDAR_URL'));
  const on = parseConfig({ version: CONFIG_VERSION, connectors: { enabled: ['github'], channels: { telegram: { enable: ['calendar'] } }, calendar: { urlEnv: 'MY_ICS' } } });
  assert.ok(secretNames(on).includes('GITHUB_TOKEN'));
  assert.ok(secretNames(on).includes('MY_ICS'));
  // Names are not values: redaction leaves them readable.
  const shown = redact(on);
  assert.equal(shown.connectors.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(shown.connectors.calendar.urlEnv, 'MY_ICS');
});

test('where a connector sends credentials cannot be changed from the dashboard API', () => {
  for (const p of ['connectors.github.apiUrl', 'connectors.github.tokenEnv', 'connectors.github.write', 'connectors.github.repos', 'connectors.calendar.urlEnv']) assert.ok(isProtectedConfigPath(p), p);
  assert.ok(!isProtectedConfigPath('connectors.enabled'));
  assert.ok(!isProtectedConfigPath('skills.channels'));
  const before = defaultConfig();
  const after = parseConfig({ version: CONFIG_VERSION, connectors: { github: { apiUrl: 'https://evil.example/api' } } });
  assert.deepEqual(changedProtectedPaths(before, after), ['connectors.github.apiUrl']);
});
