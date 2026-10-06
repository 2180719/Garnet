// Backward compatibility with installs made before Ruby was renamed to Garnet.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deprecatedEnvVars, envVar, garnetHome, pathsFor, defaultConfig } from '../src/config/index.ts';
import { SecretStore, seal, KEY_FILE_ENV, unlockFrom } from '../src/secrets/index.ts';
import { SkillStore } from '../src/skills/index.ts';
import { installService, legacyServices, planService, resolveService } from '../src/service/index.ts';
import type { CommandResult } from '../src/service/index.ts';
import { tempDir } from './helpers.ts';

test('every RUBY_* variable is a fallback for its GARNET_* twin', () => {
  assert.equal(envVar({ RUBY_HOME: '/old' }, 'GARNET_HOME'), '/old');
  assert.equal(envVar({ RUBY_HOME: '/old', GARNET_HOME: '/new' }, 'GARNET_HOME'), '/new');
  assert.equal(envVar({}, 'GARNET_HOME'), undefined);
  assert.equal(envVar({ RUBY_COMMAND_NAME: 'x' }, 'GARNET_COMMAND_NAME'), 'x');
  assert.deepEqual(deprecatedEnvVars({ RUBY_HOME: '/a', RUBY_NODE: 'n', GARNET_NODE: 'n', RUBY_VERSION: '3.3' }), [{ old: 'RUBY_HOME', name: 'GARNET_HOME' }]);
});

test('secret store unlock reads the deprecated RUBY_SECRETS_* names', () => {
  const key = join(tempDir(), 'key');
  writeFileSync(key, 'a long enough key file content', { mode: 0o600 });
  assert.equal(unlockFrom({ RUBY_SECRETS_KEY_FILE: key })?.source, 'key file');
  assert.equal(unlockFrom({ RUBY_SECRETS_PASSPHRASE: 'pw' })?.source, 'passphrase');
  assert.equal(KEY_FILE_ENV, 'GARNET_SECRETS_KEY_FILE');
});

test('home resolution: GARNET_HOME, RUBY_HOME, ~/.garnet, legacy ~/.ruby, then ~/.garnet', () => {
  const u = tempDir();
  assert.equal(garnetHome({}, u), join(u, '.garnet'), 'fresh machine');
  assert.equal(garnetHome({ RUBY_HOME: '/r' }, u), '/r');
  assert.equal(garnetHome({ RUBY_HOME: '/r', GARNET_HOME: '/g' }, u), '/g');
  mkdirSync(join(u, '.ruby'));
  assert.equal(garnetHome({}, u), join(u, '.garnet'), '~/.ruby without a config.json is not an install');
  writeFileSync(join(u, '.ruby', 'config.json'), '{}');
  assert.equal(garnetHome({}, u), join(u, '.ruby'), 'legacy install keeps working');
  mkdirSync(join(u, '.garnet'));
  assert.equal(garnetHome({}, u), join(u, '.garnet'), '~/.garnet wins once it exists');
});

test('a legacy ruby.db is used until garnet.db exists', () => {
  const home = tempDir();
  const c = defaultConfig();
  assert.equal(pathsFor(home, c).database, join(home, 'garnet.db'));
  writeFileSync(join(home, 'ruby.db'), '');
  assert.equal(pathsFor(home, c).database, join(home, 'ruby.db'));
  writeFileSync(join(home, 'garnet.db'), '');
  assert.equal(pathsFor(home, c).database, join(home, 'garnet.db'));
});

test('a secret store written as "ruby-secrets" still opens, and is rewritten in the new format', () => {
  const home = tempDir();
  const kdf = { N: 2 ** 10, r: 8, p: 1 };
  const unlock = { source: 'passphrase' as const, material: Buffer.from('correct horse battery staple') };
  writeFileSync(join(home, 'secrets'), seal({ TOKEN: 'abc' }, unlock, kdf, 'ruby-secrets'), { mode: 0o600 });
  const s = new SecretStore({ file: join(home, 'secrets'), unlock: () => unlock, kdf, lockedHint: '' });
  assert.equal(s.get('TOKEN'), 'abc');
  s.set('OTHER', 'x');
  assert.equal(JSON.parse(readFileSync(join(home, 'secrets'), 'utf8')).format, 'garnet-secrets');
  assert.equal(new SecretStore({ file: join(home, 'secrets'), unlock: () => unlock, kdf, lockedHint: '' }).get('TOKEN'), 'abc');
});

test('a skill with a legacy .ruby.json sidecar keeps its agent provenance', () => {
  const root = tempDir();
  const store = new SkillStore({ root });
  mkdirSync(join(root, 'old-skill'), { recursive: true });
  writeFileSync(join(root, 'old-skill', 'SKILL.md'), '---\nname: old-skill\ndescription: d\n---\nbody\n');
  writeFileSync(join(root, 'old-skill', '.ruby.json'), JSON.stringify({ provenance: 'agent', createdAt: 'a', updatedAt: 'b', uses: 3, agentHash: null, archived: false }));
  assert.equal(store.list().find((s) => s.name === 'old-skill')?.provenance, 'agent');
});

const OLD_UNIT = (home: string) => `[Unit]\nDescription=Ruby personal agent\n\n[Service]\nEnvironment="RUBY_HOME=${home}"\nExecStart=/usr/bin/node /x/src/cli/bin.ts start\n`;

test('service install removes our legacy ruby unit (same home), and leaves foreign or other-home units alone', async () => {
  const userHome = tempDir();
  const home = join(tempDir(), 'h');
  const unitDir = join(userHome, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const legacy = join(unitDir, 'ruby.service');
  writeFileSync(legacy, OLD_UNIT(home));
  const base = { platform: 'linux' as const, home, userHome, nodePath: '/usr/bin/node', entry: '/opt/garnet/src/cli/bin.ts' };
  assert.equal(legacyServices(base).length, 1);
  const calls: string[] = [];
  const run = async (cmd: string[]): Promise<CommandResult> => (calls.push(cmd.join(' ')), { code: 0, stdout: '', stderr: '' });
  const resolved = resolveService(base);
  assert.ok(!('unsupported' in resolved));
  const plan = resolved.plan;
  const r = await installService(plan, { run });
  assert.ok(calls.includes('systemctl --user disable --now ruby.service'));
  assert.ok(calls.indexOf('systemctl --user disable --now ruby.service') < calls.indexOf('systemctl --user restart garnet.service'));
  assert.ok(r.notes.some((n) => /legacy service/.test(n)));
  assert.equal(legacyServices(base).length, 0);
  assert.ok(r.files.includes(legacy));

  // A unit that is not ours (no marker), and one that runs another home, are never removed.
  writeFileSync(legacy, '[Service]\nExecStart=/usr/bin/ruby script.rb\n');
  calls.length = 0;
  await installService(plan, { run });
  assert.ok(!calls.some((c) => c.includes('ruby.service')));
  writeFileSync(legacy, OLD_UNIT('/somewhere/else'));
  await installService(plan, { run });
  assert.ok(!calls.some((c) => c.includes('ruby.service')));
});

test('a legacy launchd agent is detected and booted out; an instance name is carried over', async () => {
  const userHome = tempDir();
  const home = join(tempDir(), 'h');
  const dir = join(userHome, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dev.ruby.agent.work.plist'), `<plist><dict><key>Label</key><string>dev.ruby.agent.work</string><key>RUBY_HOME</key>\n<string>${home}</string></dict></plist>`);
  const base = { platform: 'darwin' as const, home, userHome, nodePath: '/usr/bin/node', entry: '/opt/garnet/src/cli/bin.ts', uid: 501 };
  const resolved = resolveService(base);
  assert.ok(!('unsupported' in resolved));
  assert.match(resolved.plan.path, /dev\.garnet\.agent\.work\.plist$/, 'the instance this home had keeps its name');
  const calls: string[] = [];
  await installService(resolved.plan, { run: async (c) => (calls.push(c.join(' ')), { code: 0, stdout: '', stderr: '' }) });
  assert.ok(calls.includes('launchctl bootout gui/501/dev.ruby.agent.work'));
  assert.equal(legacyServices(base).length, 0);
  assert.ok(planService(base));
});
