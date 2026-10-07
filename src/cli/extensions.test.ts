// `garnet skills|connectors ...` and doctor's checks for optional built-ins.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig, writeConfig, type GarnetConfig } from '../config/index.ts';
import { diagnose, type DoctorDeps, type Finding } from './doctor.ts';
import { scopeChain } from './extensions.ts';
import { main } from './main.ts';

const home = tempDir();
const saved = { home: process.env.GARNET_HOME, token: process.env.GITHUB_TOKEN, ics: process.env.GARNET_CALENDAR_URL };
process.env.GARNET_HOME = home;
delete process.env.GITHUB_TOKEN;
delete process.env.GARNET_CALENDAR_URL;
after(() => {
  for (const [k, v] of [['GARNET_HOME', saved.home], ['GITHUB_TOKEN', saved.token], ['GARNET_CALENDAR_URL', saved.ics]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}
const config = (): GarnetConfig => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as GarnetConfig;

test('enable, disable and reset built-ins globally or per scope; config.json is validated and written', async () => {
  writeConfig(home, { ...defaultConfig(), channels: { ...defaultConfig().channels, telegram: { enabled: true, tokenEnv: 'TELEGRAM_BOT_TOKEN' } }, routes: [{ match: { channel: 'telegram', chatId: '5' }, conversation: 'family' }] });

  let r = await run('connectors', 'enable', 'weather');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Enabled weather globally\. It is now on \(global\)/);
  assert.match(r.out, /add geocoding-api\.open-meteo\.com and api\.open-meteo\.com to web\.allowHosts/);
  assert.match(r.out, /garnet service restart/);
  assert.deepEqual(config().connectors.enabled, ['weather']);

  r = await run('connectors', 'disable', 'weather', '--channel', 'route:family');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /In route:family it is now off \(route:family override\)/);
  r = await run('connectors', 'enable', 'calendar', '--channel', 'telegram:42');
  assert.match(r.out, /Warning: GARNET_CALENDAR_URL is not set \(the private feed address\)\. Store it with `garnet secrets set GARNET_CALENDAR_URL`/);
  r = await run('skills', 'enable', 'daily-briefing', '--channel', 'telegram');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(config().skills.channels, { telegram: { enable: ['daily-briefing'], disable: [] } });
  assert.deepEqual(config().connectors.channels, { 'route:family': { enable: [], disable: ['weather'] }, 'telegram:42': { enable: ['calendar'], disable: [] } });

  r = await run('connectors', 'effective', '--channel', 'telegram:42');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'A new conversation in telegram:42 gets [telegram > telegram:42]:\n  skills:     daily-briefing\n  connectors: calendar, weather\n');
  r = await run('skills', 'effective');
  assert.match(r.out, /^Everywhere without an override:\n  skills:     none\n  connectors: weather\n/);
  assert.match(r.out, /route:family \[route:family, fed by telegram > telegram:5\]:\n  skills:     daily-briefing\n  connectors: none/);

  r = await run('connectors', 'list', '--channel', 'route:family');
  assert.match(r.out, /weather +off \(route:family override\)/);
  assert.match(r.out, /calendar +off \(default\)/);
  assert.match(r.out, /secret GARNET_CALENDAR_URL not set/);
  r = await run('skills', 'list');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Built-in skills \(off unless enabled/);
  assert.match(r.out, /daily-briefing +off \(default\)/, 'globally it is off; the telegram override shows with --channel');
  r = await run('skills', 'builtin', '--channel', 'telegram');
  assert.match(r.out, /daily-briefing +on \(telegram override\)/);
  r = await run('skills', 'show', 'web-research');
  assert.match(r.out, /^\(built-in skill\)\n# Web research/);

  r = await run('connectors', 'reset', 'weather', '--channel', 'route:family');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Removed the route:family override for weather\. In route:family it is now on \(global\)/);
  assert.deepEqual(Object.keys(config().connectors.channels), ['telegram:42']);
  r = await run('connectors', 'disable', 'weather');
  assert.deepEqual(config().connectors.enabled, []);
});

test('bad names, scopes and usage are refused without touching config.json', async () => {
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  const cases: [string[], RegExp][] = [
    [['connectors', 'enable', 'gmail'], /No built-in connector named "gmail"\. Available: calendar, github, weather/],
    [['skills', 'enable', 'nope'], /No built-in skill named "nope"/],
    [['connectors', 'enable', 'weather', '--channel', 'whatsapp'], /"whatsapp" is not a scope/],
    [['skills', 'enable', 'web-research', '--channel', 'route:Bad Name'], /is not a scope/],
    [['connectors', 'reset', 'weather'], /reset drops a scope's override: give --channel/],
    [['connectors', 'enable'], /Usage: garnet connectors/],
    [['connectors', 'frobnicate'], /Usage: garnet connectors/],
  ];
  for (const [argv, err] of cases) {
    const r = await run(...argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.err, err, argv.join(' '));
  }
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
});

test('help and config explain cover the new commands and fields', async () => {
  const help = await run('help');
  assert.match(help.out, /garnet connectors list\|enable\|disable\|reset\|effective/);
  const explain = await run('config', 'explain');
  for (const key of ['skills.enabled', 'skills.channels.<key>.enable', 'connectors.channels.<key>.disable', 'connectors.github.tokenEnv', 'connectors.github.repos', 'connectors.calendar.urlEnv', 'connectors.weather.units']) {
    assert.match(explain.out, new RegExp(`^${key.replace(/[.<>]/g, (c) => `\\${c}`)} `, 'm'), key);
  }
  const show = await run('config', 'show');
  assert.match(show.out, /"connectors": \{/);
});

test('scopeChain follows the runtime: channel, then chat, route, API key or job; a routed chat resolves as its route', () => {
  const c = { ...defaultConfig(), routes: [{ match: { channel: 'signal' }, conversation: 'fam' }] };
  const fam = { scopes: { scopes: ['route:fam'], feeds: [['signal']] }, route: 'route:fam' };
  assert.deepEqual(scopeChain(undefined, c), { scopes: { scopes: [] }, route: null });
  assert.deepEqual(scopeChain('cli', c), { scopes: { scopes: ['cli'] }, route: null });
  assert.deepEqual(scopeChain('telegram', c), { scopes: { scopes: ['telegram'] }, route: null });
  assert.deepEqual(scopeChain('telegram:9', c), { scopes: { scopes: ['telegram', 'telegram:9'] }, route: null });
  assert.deepEqual(scopeChain('signal', c), fam, 'every signal chat goes to the channel-wide route');
  assert.deepEqual(scopeChain('signal:group:abc', c), fam);
  assert.deepEqual(scopeChain('route:fam', c), { ...fam, route: null });
  assert.deepEqual(scopeChain('api:k1', c), { scopes: { scopes: ['api', 'api:k1'] }, route: null });
  assert.deepEqual(scopeChain('job:morning', c), { scopes: { scopes: ['job', 'job:morning'] }, route: null });
});

// ---------- doctor ----------

function doctorDeps(doctorHome: string, env: NodeJS.ProcessEnv = { PATH: '' }): DoctorDeps {
  const install = tempDir('garnet-install-');
  return {
    home: doctorHome, env, platform: 'linux', nodeVersion: '22.18.0', userHome: tempDir(), entry: join(install, 'src', 'cli', 'bin.ts'), version: '0.1.0',
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    sqlite: () => ({ ok: true, detail: 'ok' }),
    sandboxCheck: async () => ({ ok: true, detail: 'ok' }),
  };
}
const area = (fs: Finding[], ...areas: string[]) => fs.filter((f) => areas.includes(f.area));

test('doctor: nothing enabled is fine; enabled connectors are checked for permissions, secrets and shadowing', async () => {
  const h = tempDir();
  writeConfig(h, defaultConfig());
  let fs = await diagnose(doctorDeps(h));
  assert.deepEqual(area(fs, 'builtins', 'skills', 'connector').map((f) => [f.status, f.message]), [['info', 'No built-in skills or connectors enabled (all optional)']]);

  const c = defaultConfig();
  c.skills.enabled = ['web-research'];
  c.connectors.enabled = ['calendar', 'github', 'weather'];
  c.connectors.github.write = true;
  c.permissions['message.send'] = 'deny';
  c.connectors.channels = { 'discord:9': { enable: [], disable: ['weather'] } };
  writeConfig(h, c);
  mkdirSync(join(h, 'skills', 'web-research'), { recursive: true });
  writeFileSync(join(h, 'skills', 'web-research', 'SKILL.md'), '---\nname: web-research\ndescription: mine\n---\nx');
  fs = await diagnose(doctorDeps(h, { PATH: '', GITHUB_TOKEN: 'ghp_NEVERPRINTED' }));
  const shown = area(fs, 'builtins', 'skills', 'connector');
  const text = JSON.stringify(shown);
  assert.ok(!text.includes('ghp_NEVERPRINTED'), 'secret values are never printed');
  assert.ok(shown.some((f) => f.status === 'fail' && /calendar · on \(global\), but GARNET_CALENDAR_URL \(the private feed address\) is not set/.test(f.message)));
  assert.ok(shown.some((f) => f.status === 'ok' && f.message === 'github · on (global) · GITHUB_TOKEN (environment)'));
  assert.ok(shown.some((f) => f.status === 'warn' && /connectors\.github\.write is on but permissions\.message\.send is deny/.test(f.message)));
  assert.ok(shown.some((f) => f.status === 'ok' && f.message === 'weather · on (global)'));
  assert.ok(shown.some((f) => f.status === 'warn' && /built-in skill web-research is on \(global\) but a skill of the same name/.test(f.message)));
  assert.ok(shown.some((f) => f.status === 'info' && /The override for discord:9 has no effect: discord is not enabled/.test(f.message)));

  c.permissions['net.fetch'] = 'deny';
  writeConfig(h, c);
  fs = await diagnose(doctorDeps(h));
  assert.equal(area(fs, 'connector').filter((f) => f.status === 'warn' && /net\.fetch is deny, so it is not offered/.test(f.message)).length, 3);
});
