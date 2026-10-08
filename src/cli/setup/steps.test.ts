// The tools and extras steps of `garnet setup`: abilities, web search, approvals, connectors, skills,
// voice notes, time zone, spending cap and dashboard.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness } from '../../../test/setup-harness.ts';
import { KEY_FILE_ENV, openSecretStore } from '../../secrets/index.ts';
import { defaultConfig, writeConfig, type GarnetConfig } from '../../config/index.ts';
import { AnswerPrompter } from './prompt.ts';
import { setup } from './command.ts';
import type { ApprovalBinding, ApprovalMode } from './shared.ts';
import { applyAbilities, enabledAbilities } from './tools.ts';
import { runSetup } from './wizard.ts';

const NO_CHANNELS = { channels: 'none', service: false };
const FAKE = { provider: 'fake', name: 'Juno', ...NO_CHANNELS };

/** An existing install, so the re-run menu is used. */
function existing(h: { home: string }, edit: (c: GarnetConfig) => void = () => {}): void {
  const c = defaultConfig();
  edit(c);
  writeConfig(h.home, c);
}

async function menu(h: ReturnType<typeof harness>, section: string, answers: Record<string, string | boolean | string[]>, secrets: Record<string, string> = {}) {
  const p = new AnswerPrompter({ section: [section, 'done'], ...answers }, { interactive: true, secrets });
  assert.equal(await runSetup(p, h.io, h.deps), 0);
  return p;
}

test('abilities: ticked ones keep their setting or start at ask, unticked ones are denied', () => {
  const perms = { ...defaultConfig().permissions, 'memory.write': 'allow' as const };
  assert.deepEqual(enabledAbilities(perms), ['web', 'files', 'memory', 'reminders', 'messages']);
  const next = applyAbilities(perms, ['memory', 'commands']);
  assert.equal(next['memory.write'], 'allow');
  assert.equal(next.exec, 'ask');
  assert.equal(next['net.fetch'], 'deny');
  assert.equal(next['fs.write'], 'deny');
  assert.equal(next['fs.read'], 'allow');
});

test('tools step: commands are off by default; ticking them asks where they run and starts at ask', async () => {
  const h = harness();
  existing(h);
  const p = await menu(h, 'tools', { tools: 'web,files,memory,reminders,messages,commands', sandbox: 'local' });
  const c = h.config();
  assert.equal(c.permissions.exec, 'ask');
  assert.equal(c.sandbox.backend, 'local');
  assert.ok(p.asked.includes('sandbox'));
  assert.match(h.out(), /garnet sandbox check/);

  const off = harness();
  existing(off, (x) => (x.permissions.exec = 'allow'));
  await menu(off, 'tools', { tools: 'web,files' });
  const o = off.config().permissions;
  assert.deepEqual([o.exec, o['memory.write'], o['schedule.edit'], o['message.send'], o['net.fetch'], o['fs.write']], ['deny', 'deny', 'deny', 'deny', 'ask', 'ask']);
});

test('tools step: a script keeps the current abilities unless --tools says otherwise', async () => {
  const h = harness();
  const { done } = h.run({ ...FAKE, extras: 'more' }, {}, false);
  assert.equal(await done, 0);
  assert.deepEqual(h.config().permissions, defaultConfig().permissions);
  const none = harness();
  assert.equal(await none.run({ ...FAKE, tools: 'none' }, {}, false).done, 0);
  const perms = none.config().permissions;
  assert.deepEqual([perms.exec, perms['net.fetch'], perms['fs.write'], perms['memory.write'], perms['fs.read']], ['deny', 'deny', 'deny', 'deny', 'allow']);
});

test('web search: Brave asks for a key and stores it by name; SearXNG asks for the address; none turns search off', async () => {
  const h = harness();
  existing(h);
  await menu(h, 'tools', { tools: 'web', 'web-search': 'brave', secrets: 'encrypted', check: false }, { 'web-search-key': 'BSA-secret-value-123' });
  const c = h.config();
  assert.equal(c.web.search.backend, 'brave');
  assert.equal(c.web.search.apiKeyEnv, 'BRAVE_API_KEY');
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8').includes('BSA-secret'), false);
  assert.equal(openSecretStore(h.home, { [KEY_FILE_ENV]: h.deps.defaultKeyFile }, { kdf: h.deps.kdf! }).get('BRAVE_API_KEY'), 'BSA-secret-value-123');

  const sx = harness();
  existing(sx);
  await menu(sx, 'tools', { tools: 'web', 'web-search': 'searxng', 'searxng-url': 'http://127.0.0.1:8888' });
  assert.equal(sx.config().web.search.searxngUrl, 'http://127.0.0.1:8888');
  await assert.rejects(menu(sx, 'tools', { tools: 'web', 'web-search': 'searxng', 'searxng-url': 'nope' }), /--searxng-url/);

  const none = harness();
  existing(none);
  const p = await menu(none, 'tools', { tools: 'web', 'web-search': 'none' });
  assert.equal(none.config().web.search.backend, 'none');
  assert.equal(p.asked.includes('web-search-key'), false);
});

// A stand-in for the policy's setting, kept in a field the schema has today.
const MODES: ApprovalMode[] = ['default', 'ask-all', 'allow-all', 'custom', 'reviewer'];
const binding = (available: readonly ApprovalMode[]): ApprovalBinding => ({
  read: (c) => MODES[c.gateway.maxConcurrent - 1] ?? 'default',
  write: (c, mode) => ({ ...c, gateway: { ...c.gateway, maxConcurrent: MODES.indexOf(mode) + 1 } }),
  options: () => ({}),
  available,
});

test('approvals: skipped until the policy exposes the setting; then it reads and writes through the binding', async () => {
  const h = harness();
  existing(h);
  const without = await menu(h, 'tools', { tools: 'web' });
  assert.equal(without.asked.includes('approvals'), false);

  const w = harness();
  existing(w);
  w.deps.approvalMode = binding(['default', 'ask-all', 'allow-all']);
  const p = await menu(w, 'tools', { tools: 'web', approvals: 'ask-all' });
  assert.ok(p.asked.includes('approvals'));
  assert.equal(w.config().gateway.maxConcurrent, 2);
  // Modes the running version lacks are not offered.
  await assert.rejects(menu(w, 'tools', { tools: 'web', approvals: 'reviewer' }), /must be one of default, ask-all, allow-all/);
});

test('approvals: never-ask needs a second yes, and a no goes back to the question', async () => {
  const h = harness();
  existing(h);
  h.deps.approvalMode = binding(['default', 'ask-all', 'allow-all']);
  const p = new AnswerPrompter({ section: ['tools', 'done'], tools: 'web', approvals: ['allow-all', 'ask-all'], 'approvals-allow-all': false }, { interactive: true });
  assert.equal(await runSetup(p, h.io, h.deps), 0);
  assert.equal(h.config().gateway.maxConcurrent, 2);
  assert.deepEqual(p.asked.filter((id) => id.startsWith('approvals')), ['approvals', 'approvals-allow-all', 'approvals']);
});

test('approvals: a custom rules file must be absolute; a reviewer is one of the configured providers', async () => {
  const h = harness();
  existing(h, (c) => void (c.providers.cheap = { ...c.model, name: 'claude-haiku-4-5' }));
  const seen: { mode: ApprovalMode; options: object }[] = [];
  h.deps.approvalMode = { ...binding(MODES), write: (c, mode, options) => (seen.push({ mode, options }), c) };
  await assert.rejects(menu(h, 'tools', { tools: 'web', approvals: 'custom', 'approval-rules': 'rules.json' }), /absolute/);
  await menu(h, 'tools', { tools: 'web', approvals: 'custom', 'approval-rules': '/etc/garnet/rules.json' });
  await menu(h, 'tools', { tools: 'web', approvals: 'reviewer', 'approval-reviewer': 'cheap' });
  assert.deepEqual(seen.map((x) => x.mode), ['custom', 'reviewer']);
  assert.deepEqual(seen[0]!.options, { rulesFile: '/etc/garnet/rules.json' });
  assert.deepEqual(seen[1]!.options, { reviewer: 'cheap' });
});

test('connectors: calendar address is stored as a secret and only its name is in config', async () => {
  const h = harness();
  existing(h);
  const feed = 'https://calendar.example.com/private/abcdef0123456789/basic.ics';
  await menu(h, 'integrations', { connectors: 'calendar', skills: 'daily-briefing', secrets: 'encrypted', check: false }, { 'calendar-url': feed });
  const c = h.config();
  assert.deepEqual(c.connectors.enabled, ['calendar']);
  assert.deepEqual(c.skills.enabled, ['daily-briefing']);
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8').includes('abcdef0123456789'), false);
  assert.equal(h.out().includes('abcdef0123456789'), false);
  assert.equal(openSecretStore(h.home, { [KEY_FILE_ENV]: h.deps.defaultKeyFile }, { kdf: h.deps.kdf! }).get('GARNET_CALENDAR_URL'), feed);
});

test('connectors: http (generic path) asks for the secret of each credential it already has', async () => {
  const h = harness();
  existing(h, (c) => void (c.connectors.http.credentials.crm = { secretEnv: 'CRM_TOKEN', hosts: ['api.crm.example'], header: 'Authorization', prefix: 'Bearer ' }));
  const token = 'crm-token-0123456789';
  await menu(h, 'integrations', { connectors: 'http', skills: 'none', secrets: 'encrypted', check: false }, { 'http-crm-token': token });
  const c = h.config();
  assert.deepEqual(c.connectors.enabled, ['http']);
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8').includes(token), false);
  assert.equal(openSecretStore(h.home, { [KEY_FILE_ENV]: h.deps.defaultKeyFile }, { kdf: h.deps.kdf! }).get('CRM_TOKEN'), token);
});

test('connectors: GitHub repositories are validated; weather keeps the place; turning one off keeps its secret name', async () => {
  const h = harness();
  existing(h);
  await menu(h, 'integrations', { connectors: 'github,weather', skills: 'none', secrets: 'env', 'github-repos': 'acme/api, acme/*', 'github-write': true, 'weather-location': 'Lisbon', 'weather-units': 'imperial' });
  const c = h.config().connectors;
  assert.deepEqual(c.enabled, ['github', 'weather']);
  assert.deepEqual(c.github.repos, ['acme/api', 'acme/*']);
  assert.equal(c.github.write, true);
  assert.deepEqual([c.weather.location, c.weather.units], ['Lisbon', 'imperial']);

  await assert.rejects(menu(h, 'integrations', { connectors: 'github', skills: 'none', secrets: 'env', 'github-repos': 'not a repo' }), /not owner\/name/);
  await menu(h, 'integrations', { connectors: 'weather', skills: 'none', 'weather-location': 'Lisbon', 'weather-units': 'imperial' });
  assert.deepEqual(h.config().connectors.enabled, ['weather']);
  assert.deepEqual(h.config().connectors.github.repos, ['acme/api', 'acme/*']);
});

test('connectors: one that needs the web turns web access back on, and a skill without its connector is flagged', async () => {
  const h = harness();
  existing(h, (c) => (c.permissions['net.fetch'] = 'deny'));
  await menu(h, 'integrations', { connectors: 'weather', skills: 'github-triage,web-research', 'weather-location': '', 'weather-units': 'metric' });
  assert.equal(h.config().permissions['net.fetch'], 'ask');
  assert.match(h.out(), /github-triage needs the GitHub connector/);
  assert.deepEqual(h.config().skills.enabled, ['github-triage', 'web-research']);
});

test('voice notes: a hosted service stores its key; a local server needs none; off and a configured command are kept', async () => {
  const h = harness();
  existing(h);
  await menu(h, 'voice', { voice: 'groq', secrets: 'encrypted', check: false }, { 'voice-key': 'gsk_voice_secret_12345' });
  let t = h.config().media.transcription;
  assert.deepEqual([t.backend, t.baseUrl, t.model, t.apiKeyEnv], ['openai-compatible', 'https://api.groq.com/openai/v1', 'whisper-large-v3-turbo', 'GROQ_API_KEY']);
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8').includes('gsk_voice'), false);

  await menu(h, 'voice', { voice: 'other', 'voice-url': 'http://127.0.0.1:8080/v1', 'voice-model': 'base.en', 'voice-key-env': '' });
  t = h.config().media.transcription;
  assert.deepEqual([t.baseUrl, t.model, t.apiKeyEnv], ['http://127.0.0.1:8080/v1', 'base.en', undefined]);

  await menu(h, 'voice', { voice: 'none' });
  assert.equal(h.config().media.transcription.backend, 'none');

  const cmd = harness();
  existing(cmd, (c) => void (c.media.transcription = { ...c.media.transcription, backend: 'command', command: ['whisper-cli', '{input}'] }));
  await menu(cmd, 'voice', {});
  assert.deepEqual(cmd.config().media.transcription.command, ['whisper-cli', '{input}']);
  assert.equal(cmd.config().media.transcription.backend, 'command');
});

test('voice notes are only offered on a first run when a channel is connected', async () => {
  const none = harness();
  const a = none.run({ ...FAKE }, {}, true);
  assert.equal(await a.done, 0);
  assert.equal(a.p.asked.includes('voice'), false);
  const some = harness();
  const b = some.run({ provider: 'fake', name: 'Juno', channels: 'telegram', 'telegram-token-env': 'TG', secrets: 'env', check: false, service: false }, {}, true);
  assert.equal(await b.done, 0);
  assert.ok(b.p.asked.includes('voice'));
});

test('time zone, daily cap and dashboard', async () => {
  const h = harness();
  h.deps.hostTimeZone = () => 'Europe/Paris';
  const { p, done } = h.run({ ...FAKE, timezone: 'America/New_York', dashboard: true });
  assert.equal(await done, 0);
  assert.equal(h.config().timezone, 'America/New_York');
  assert.equal(h.config().api.enabled, true);
  assert.equal(h.config().dashboard.enabled, true);
  // The demo model costs nothing, so no cap is asked for.
  assert.equal(p.asked.includes('daily-limit'), false);

  const k = harness();
  existing(k, (c) => void (c.model.provider = 'anthropic'));
  await menu(k, 'preferences', { 'daily-limit': '7.5', dashboard: false });
  assert.equal(k.config().budgets.dailyUsd, 7.5);
  assert.equal(k.config().dashboard.enabled, false);
  await menu(k, 'preferences', { 'daily-limit': '', dashboard: false });
  assert.equal(k.config().budgets.dailyUsd, undefined);
  await assert.rejects(menu(k, 'preferences', { 'daily-limit': '-3', dashboard: false }), /positive number/);

  const bad = harness();
  await assert.rejects(bad.run({ ...FAKE, timezone: 'Mars/Olympus' }).done, /not a time zone/);
});

test('time zone question offers the machine zone, and an empty script answer leaves it unset', async () => {
  const h = harness();
  h.deps.hostTimeZone = () => 'Europe/Paris';
  const asks: { id: string; default?: string }[] = [];
  const p = new AnswerPrompter({ ...FAKE }, { interactive: true });
  const text = p.text.bind(p);
  p.text = (q) => (asks.push({ id: q.id, ...(q.default !== undefined ? { default: q.default } : {}) }), text(q));
  assert.equal(await runSetup(p, h.io, h.deps), 0);
  assert.equal(asks.find((a) => a.id === 'timezone')?.default, 'Europe/Paris');
  assert.equal(h.config().timezone, undefined);
});

test('the extras question lets a person skip tools and extras; a script can too', async () => {
  const h = harness();
  const { p, done } = h.run({ ...FAKE, extras: 'defaults' });
  assert.equal(await done, 0);
  for (const id of ['tools', 'connectors', 'skills', 'daily-limit', 'dashboard']) assert.equal(p.asked.includes(id), false, id);
  assert.deepEqual(h.config().permissions, defaultConfig().permissions);
});

test('the re-run menu shows what each part is set to', async () => {
  const h = harness();
  existing(h, (c) => void (c.connectors.enabled = ['weather']));
  const p = new AnswerPrompter({ section: 'quit' }, { interactive: true });
  const select = p.select.bind(p);
  let hints = '';
  p.select = (async (q: Parameters<typeof select>[0]) => {
    if (q.id === 'section') hints = q.choices.map((c) => `${c.label} | ${c.hint ?? ''}`).join('\n');
    return select(q);
  }) as typeof p.select;
  await runSetup(p, h.io, h.deps);
  assert.match(hints, /Tools and permissions \| web \(ask\), files \(ask\), memory \(allow\)/);
  assert.match(hints, /Connectors and skills \| weather · skills: none/);
  assert.match(hints, /Voice notes \| off/);
  assert.match(hints, /Spending cap and dashboard \| no daily cap · dashboard off/);
});

test('`garnet setup --help` lists the tools and extras flags', async () => {
  let out = '';
  assert.equal(await setup(['--help'], { out: (t) => (out += t), err: (t) => (out += t) }), 0);
  for (const f of ['--timezone', '--extras', '--tools', '--web-search', '--connectors', '--skills', '--voice', '--daily-limit', '--dashboard', '--github-repos', '--weather-units']) assert.ok(out.includes(f), f);
});


// ---------- regressions found in review ----------

test('web search: switching backends never carries the old backend key name along', async () => {
  const h = harness();
  existing(h, (c) => void (c.web.search = { ...c.web.search, backend: 'brave', apiKeyEnv: 'BRAVE_API_KEY' }));
  await menu(h, 'tools', { tools: 'web', 'web-search': 'tavily', secrets: 'env' });
  assert.equal(h.config().web.search.apiKeyEnv, 'TAVILY_API_KEY');
});

test('voice notes: a key name used by a provider on another host, or for another address, is not reused', async () => {
  const h = harness();
  existing(h, (c) => void (c.model = { ...c.model, provider: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'OPENAI_API_KEY' }));
  await menu(h, 'voice', { voice: 'openai', secrets: 'env' });
  assert.equal(h.config().media.transcription.apiKeyEnv, 'OPENAI_TRANSCRIBE_API_KEY');

  const o = harness();
  existing(o, (c) => void (c.media.transcription = { ...c.media.transcription, backend: 'openai-compatible', baseUrl: 'https://a.example/v1', apiKeyEnv: 'A_KEY' }));
  await menu(o, 'voice', { voice: 'other', 'voice-url': 'https://b.example/v1', 'voice-model': 'm', 'voice-key-env': '' });
  assert.equal(o.config().media.transcription.apiKeyEnv, undefined);
});

test('the import entry of the re-run menu works', async () => {
  const h = harness({ sources: () => [{ source: 'openclaw', dir: '/nowhere' }] });
  existing(h);
  const p = new AnswerPrompter({ section: ['import', 'done'], import: false }, { interactive: true });
  assert.equal(await runSetup(p, h.io, h.deps), 0);
  assert.ok(p.asked.includes('import'));
});

test('connectors: a script never turns web access back on; a person is asked first', async () => {
  const h = harness();
  existing(h, (c) => ((c.permissions['net.fetch'] = 'deny'), (c.connectors.enabled = ['weather'])));
  assert.equal(await h.run({ ...NO_CHANNELS, extras: 'more' }, {}, false).done, 0);
  assert.equal(h.config().permissions['net.fetch'], 'deny');
  assert.match(h.out(), /Still to do/);

  const q = harness();
  existing(q, (c) => (c.permissions['net.fetch'] = 'deny'));
  await menu(q, 'integrations', { connectors: 'weather', skills: 'none', 'connector-web': false, 'weather-location': '', 'weather-units': 'metric' });
  assert.equal(q.config().permissions['net.fetch'], 'deny');
});

test('wake-up chosen, then memory switched off by the tools step: falls back to the form and asks the time zone', async () => {
  const h = harness();
  h.deps.wake = async () => 0;
  const { p, done } = h.run({ ...FAKE, onboarding: 'wake', extras: 'more', tools: 'web', name: 'Juno', timezone: 'Europe/London' });
  assert.equal(await done, 0);
  assert.ok(p.asked.includes('name'));
  assert.equal(h.config().timezone, 'Europe/London');
});

test('weather: an empty place clears the saved one', async () => {
  const h = harness();
  existing(h, (c) => ((c.connectors.enabled = ['weather']), (c.connectors.weather.location = 'Lisbon')));
  await menu(h, 'integrations', { connectors: 'weather', skills: 'none', 'weather-location': '', 'weather-units': 'metric' });
  assert.equal(h.config().connectors.weather.location, undefined);
});
