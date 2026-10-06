import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { parseConfig, parseEnv, writeConfig, defaultConfig } from '../../config/index.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, openSecretStore } from '../../secrets/index.ts';
import type { ServiceResult } from '../../service/index.ts';
import type { Io } from '../main.ts';
import { init, setup } from './command.ts';
import { readPersona, writePersona } from './persona.ts';
import { AnswerPrompter, makeStyle, type Answer } from './prompt.ts';
import { runSetup, type Pairing, type SetupDeps } from './wizard.ts';

const kdf = { N: 2 ** 10, r: 8, p: 1 };
const KEY = 'sk-ant-api03-NEVER-PRINT-THIS-0123456789';
const TG = '123456789:AAThisIsNotARealTelegramToken_xyz';

type Call = { url: string; headers: Record<string, string> };

function harness(opts: { home?: string; env?: NodeJS.ProcessEnv; responses?: ((url: string) => { status: number; body: unknown })[]; installed?: boolean; pending?: Pairing[]; sources?: SetupDeps['importSources'] } = {}) {
  const home = opts.home ?? tempDir();
  const keyDir = tempDir();
  const env: NodeJS.ProcessEnv = opts.env ?? {};
  let out = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (out += t) };
  const calls: Call[] = [];
  const responses = [...(opts.responses ?? [])];
  const svc = { installs: 0, restarts: 0, installed: opts.installed ?? false };
  const ok = (cmd: string[]): ServiceResult => ({ ok: true, files: [], commands: [{ cmd, code: 0, stdout: '', stderr: '' }], notes: [] });
  const imports: string[][] = [];
  const approved: string[] = [];
  const pending = [...(opts.pending ?? [])];
  const deps: SetupDeps = {
    home,
    env,
    style: makeStyle(false),
    defaultKeyFile: join(keyDir, 'ruby', 'secrets.key'),
    kdf,
    now: () => new Date('2026-10-06T12:00:00Z'),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      const r = (responses.shift() ?? (() => ({ status: 200, body: { data: [] } })))(url);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    service: {
      label: 'systemd user service',
      installed: () => svc.installed,
      install: async () => {
        svc.installs++;
        svc.installed = true;
        return ok(['systemctl', '--user', 'enable', '--now', 'ruby.service']);
      },
      restart: async () => {
        svc.restarts++;
        return ok(['systemctl', '--user', 'restart', 'ruby.service']);
      },
    },
    importSources: opts.sources ?? (() => []),
    runImport: (args, persona) => {
      imports.push(args);
      if (args.includes('--apply') && persona.get() === undefined) persona.set('You are a careful assistant imported from elsewhere.');
      return 0;
    },
    pairing: () => ({
      pending: () => pending.filter((p) => !approved.includes(p.code)),
      approve: (code) => {
        approved.push(code);
        return pending.find((p) => p.code === code) ?? null;
      },
      close: () => {},
    }),
  };
  const run = (answers: Record<string, Answer | Answer[]>, secrets: Record<string, string> = {}, interactive = true) => {
    const p = new AnswerPrompter(answers, { interactive, secrets });
    return { p, done: runSetup(p, io, deps) };
  };
  return { home, env, deps, io, run, calls, svc, imports, approved, out: () => out, config: () => parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))) };
}

test('first run: Anthropic key goes into a new encrypted store, checked live with consent, never printed or put in config', async () => {
  const h = harness();
  const { p, done } = h.run({ provider: 'anthropic', secrets: 'encrypted', check: true, name: 'Juno', owner: 'Sam', notes: 'Be brief.', telegram: false, discord: false, signal: false, service: false }, { key: KEY });
  assert.equal(await done, 0);
  const c = h.config();
  assert.equal(c.model.provider, 'anthropic');
  assert.equal(c.model.apiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.deepEqual(readPersona(c.persona), { name: 'Juno', owner: 'Sam', notes: 'Be brief.' });
  // The key file is outside home, private, and named in <home>/env; the key itself is only in the store.
  const keyFile = h.deps.defaultKeyFile;
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(parseEnv(readFileSync(join(h.home, 'env'), 'utf8')).get(KEY_FILE_ENV), keyFile);
  assert.equal(statSync(join(h.home, 'env')).mode & 0o777, 0o600);
  assert.equal(openSecretStore(h.home, { [KEY_FILE_ENV]: keyFile }, { kdf }).get('ANTHROPIC_API_KEY'), KEY);
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8').includes(KEY), false);
  assert.equal(readFileSync(join(h.home, 'env'), 'utf8').includes(KEY), false);
  assert.equal(h.out().includes(KEY), false);
  // One model-listing request with the key in a header.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(h.calls[0]!.headers['x-api-key'], KEY);
  assert.match(h.out(), /✓ key accepted/);
  assert.match(h.out(), /Ruby is ready\./);
  assert.match(h.out(), /ruby chat +talk to Ruby/);
  assert.ok(existsSync(join(h.home, 'workspace')));
  // Linear flow, no menu on a first run.
  assert.equal(p.asked.includes('section'), false);
});

test('without consent no request is made; a rejected key can be re-entered and only the good one is kept', async () => {
  const quiet = harness();
  assert.equal(await quiet.run({ provider: 'anthropic', secrets: 'env-file', check: false, telegram: false, discord: false, signal: false }, { key: KEY }).done, 0);
  assert.equal(quiet.calls.length, 0);
  assert.equal(parseEnv(readFileSync(join(quiet.home, 'env'), 'utf8')).get('ANTHROPIC_API_KEY'), KEY);

  const h = harness({ responses: [() => ({ status: 401, body: { error: { message: 'invalid x-api-key' } } }), () => ({ status: 200, body: { data: [{ id: 'claude-opus-5-5' }] } })] });
  const p = new AnswerPrompter(
    { provider: 'anthropic', secrets: 'env-file', check: true, 'retry-model': true, telegram: false, discord: false, signal: false },
    { interactive: true, secrets: { key: KEY } },
  );
  // The scripted secret answers the same each time; swap it after the first ask.
  let n = 0;
  const original = p.secret.bind(p);
  p.secret = async (q) => (q.id === 'key' && n++ === 0 ? 'sk-ant-wrong' : original(q));
  assert.equal(await runSetup(p, h.io, h.deps), 0);
  assert.match(h.out(), /✗ Anthropic rejected the key \(HTTP 401\)/);
  assert.equal(h.calls.length, 2);
  assert.equal(parseEnv(readFileSync(join(h.home, 'env'), 'utf8')).get('ANTHROPIC_API_KEY'), KEY);
  assert.equal(h.out().includes('sk-ant-wrong'), false);
});

test('a key already in the environment is kept without asking for it again', async () => {
  const h = harness({ env: { ANTHROPIC_API_KEY: KEY } });
  const { p, done } = h.run({ provider: 'anthropic', telegram: false, discord: false, signal: false });
  assert.equal(await done, 0);
  assert.ok(p.asked.includes('keep-key'));
  assert.equal(p.asked.includes('key'), false);
  assert.equal(p.asked.includes('secrets'), false);
  assert.equal(existsSync(join(h.home, 'secrets')), false);
  assert.match(h.out(), /Key +ANTHROPIC_API_KEY \(your environment\)/);
});

test('a local model gets its own key name (never another provider key) and is checked without auth', async () => {
  const h = harness({ env: { ANTHROPIC_API_KEY: KEY }, responses: [() => ({ status: 200, body: { data: [{ id: 'qwen3:8b' }] } })] });
  assert.equal(await h.run({ provider: 'local', model: 'qwen3:8b', check: true, telegram: false, discord: false, signal: false }).done, 0);
  const c = h.config();
  assert.equal(c.model.provider, 'openai-compatible');
  assert.equal(c.model.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(c.model.apiKeyEnv, 'LOCAL_MODEL_API_KEY');
  assert.equal(h.calls[0]!.url, 'http://127.0.0.1:11434/v1/models');
  assert.equal(h.calls[0]!.headers.authorization, undefined);
  assert.match(h.out(), /✓ server answered/);
});

test('telegram: token stored, getMe shows the bot, service installed, own account paired', async () => {
  const h = harness({
    responses: [() => ({ status: 200, body: { ok: true, result: { username: 'juno_helper_bot' } } })],
    pending: [{ code: 'K7Q2ZX', channel: 'telegram', senderId: '42', senderName: 'Sam' }],
  });
  const { p, done } = h.run(
    { provider: 'fake', secrets: 'env-file', check: true, telegram: true, discord: false, signal: false, service: true, pair: true, 'pair-wait': '', 'pair-approve': true },
    { 'telegram-token': TG },
  );
  assert.equal(await done, 0);
  const c = h.config();
  assert.equal(c.channels.telegram.enabled, true);
  assert.equal(parseEnv(readFileSync(join(h.home, 'env'), 'utf8')).get('TELEGRAM_BOT_TOKEN'), TG);
  assert.equal(h.calls[0]!.url.startsWith('https://api.telegram.org/bot'), true);
  assert.match(h.out(), /✓ connected to @juno_helper_bot/);
  assert.equal(h.svc.installs, 1);
  assert.deepEqual(h.approved, ['K7Q2ZX']);
  assert.match(h.out(), /Paired Sam on telegram/);
  assert.ok(p.messages.some((m) => m.startsWith('Send a message to @juno_helper_bot on Telegram')));
  assert.ok(p.asked.indexOf('service') < p.asked.indexOf('pair'));
  assert.equal(h.out().includes(TG), false);
});

test('a failed check in non-interactive mode fails before anything is written', async () => {
  const h = harness({ responses: [() => ({ status: 401, body: {} })] });
  await assert.rejects(h.run({ provider: 'anthropic', secrets: 'env-file', check: true }, { key: KEY }, false).done, /model check failed: Anthropic rejected the key/);
  assert.equal(existsSync(join(h.home, 'config.json')), false);
  assert.equal(existsSync(join(h.home, 'env')), false);
});

test('re-run: the menu edits one section, keeps hand-written persona text and the rest of the config, and offers a restart', async () => {
  const h = harness({ installed: true });
  const start = defaultConfig();
  start.model = { ...start.model, provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', name: 'some/model', apiKeyEnv: 'OPENROUTER_API_KEY' };
  start.persona = 'Always answer in British English.';
  start.budgets.maxToolCalls = 7;
  writeConfig(h.home, start);
  const { p, done } = h.run({ section: ['persona', 'done'], name: 'Juno', owner: '', notes: '', restart: true });
  assert.equal(await done, 0);
  const c = h.config();
  assert.equal(c.model.name, 'some/model');
  assert.equal(c.budgets.maxToolCalls, 7);
  assert.match(c.persona!, /^<!-- ruby setup -->\nYour name is Juno\.\n<!-- \/ruby setup -->\n\nAlways answer in British English\.$/);
  assert.equal(h.svc.restarts, 1);
  assert.equal(h.svc.installs, 0);
  assert.match(h.out(), /Model +openrouter · some\/model/);
  assert.equal(p.asked.includes('provider'), false);
});

test('re-run: quitting or changing nothing leaves the file untouched', async () => {
  const h = harness();
  writeConfig(h.home, defaultConfig());
  const before = readFileSync(join(h.home, 'config.json'), 'utf8');
  assert.equal(await h.run({ section: 'quit' }).done, 0);
  assert.match(h.out(), /Nothing was changed/);
  assert.equal(await h.run({ section: 'done' }).done, 0);
  assert.match(h.out(), /No changes\./);
  assert.equal(readFileSync(join(h.home, 'config.json'), 'utf8'), before);
});

test('an invalid config is only replaced with consent, and is kept as a backup', async () => {
  const h = harness();
  writeFileSync(join(h.home, 'config.json'), '{"version": 1, "model": {"provider": "nope"}}');
  assert.equal(await h.run({}, {}, false).done, 1);
  assert.match(h.out(), /has problems/);
  assert.match(h.out(), /pass --reset/);
  assert.equal(await h.run({ reset: true, provider: 'fake' }, {}, false).done, 0);
  assert.ok(existsSync(join(h.home, 'config.json.bak-2026-10-06T12-00-00-000Z')));
  assert.equal(h.config().model.provider, 'fake');
});

test('a locked store is not offered; storing encrypted removes a plain-text copy from the env file', async () => {
  const locked = harness();
  writeFileSync(join(locked.home, 'secrets'), '{}');
  await assert.rejects(locked.run({ provider: 'anthropic', secrets: 'encrypted' }, { key: KEY }, false).done, /--secrets must be one of env-file, env/);
  assert.match(locked.out(), /is locked/);

  const h = harness({ env: { [PASSPHRASE_ENV]: 'a long enough passphrase' } });
  writeFileSync(join(h.home, 'env'), `# mine\nANTHROPIC_API_KEY=old-value\nOTHER=1\n`, { mode: 0o600 });
  assert.equal(await h.run({ provider: 'anthropic', 'keep-key': false, secrets: 'encrypted', telegram: false, discord: false, signal: false }, { key: KEY }).done, 0);
  assert.equal(readFileSync(join(h.home, 'env'), 'utf8'), '# mine\nOTHER=1\n');
  assert.equal(openSecretStore(h.home, h.env, { kdf }).get('ANTHROPIC_API_KEY'), KEY);
  assert.match(h.out(), /Removed the plain-text copy of ANTHROPIC_API_KEY/);
});

test('import: preview first, apply on consent; the imported persona survives the setup block', async () => {
  const h = harness({ sources: () => [{ source: 'hermes', dir: '/home/x/.hermes' }] });
  assert.equal(await h.run({ import: true, 'import-apply': true, provider: 'fake', name: 'Juno', telegram: false, discord: false, signal: false }).done, 0);
  assert.deepEqual(h.imports, [
    ['hermes', '--from', '/home/x/.hermes'],
    ['hermes', '--from', '/home/x/.hermes', '--apply'],
  ]);
  assert.match(h.config().persona!, /Your name is Juno\.\n<!-- \/ruby setup -->\n\nYou are a careful assistant imported from elsewhere\.$/);
});

test('`ruby setup` command: refuses a non-terminal without -y; -y with flags and --key-stdin works', async () => {
  const home = tempDir();
  const keyDir = tempDir();
  let out = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (out += t) };
  const prevHome = process.env.RUBY_HOME;
  process.env.RUBY_HOME = home;
  try {
    assert.equal(await setup([], io, { tty: false }), 2);
    assert.match(out, /not a terminal/);
    assert.equal(await setup(['--key-stdin'], io, { tty: true }), 2);
    assert.equal(await setup(['--bogus'], io, { tty: true }), 2);
    const env: NodeJS.ProcessEnv = {};
    const code = await setup(
      ['-y', '--provider', 'openrouter', '--model', 'vendor/model-x', '--key-stdin', '--secrets', 'encrypted', '--key-file', join(keyDir, 'k'), '--name', 'Juno', '--no-telegram'],
      io,
      { tty: false, readStdin: async () => `${KEY}\n`, deps: { home, env, kdf, service: null, importSources: () => [], style: makeStyle(false) } },
    );
    assert.equal(code, 0, out);
    const c = parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
    assert.equal(c.model.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(c.model.apiKeyEnv, 'OPENROUTER_API_KEY');
    assert.equal(openSecretStore(home, { [KEY_FILE_ENV]: join(keyDir, 'k') }, { kdf }).get('OPENROUTER_API_KEY'), KEY);
    assert.equal(out.includes(KEY), false);
    // A missing required answer names the flag.
    const bare = tempDir();
    await assert.rejects(setup(['-y', '--provider', 'openrouter'], io, { tty: false, deps: { home: bare, env: {}, service: null, importSources: () => [], style: makeStyle(false) } }), /pass --model/);
  } finally {
    if (prevHome === undefined) delete process.env.RUBY_HOME;
    else process.env.RUBY_HOME = prevHome;
  }
});

test('`ruby init`: without a terminal it writes defaults and points at setup; on a terminal it offers setup', async () => {
  const prevHome = process.env.RUBY_HOME;
  let out = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (out += t) };
  try {
    const plain = tempDir();
    process.env.RUBY_HOME = plain;
    assert.equal(await init([], io, { tty: false }), 0);
    assert.ok(existsSync(join(plain, 'config.json')));
    assert.match(out, /Next: `ruby setup`/);
    assert.equal(await init([], io, { tty: false }), 0);
    assert.match(out, /already set up/);

    const guided = tempDir();
    process.env.RUBY_HOME = guided;
    const p = new AnswerPrompter({ setup: true, provider: 'fake', telegram: false, discord: false, signal: false }, { interactive: true });
    assert.equal(await init([], io, { tty: true, prompter: p, deps: { home: guided, env: {}, service: null, importSources: () => [], style: makeStyle(false) } }), 0);
    assert.equal(p.asked[0], 'setup');
    assert.equal(parseConfig(JSON.parse(readFileSync(join(guided, 'config.json'), 'utf8'))).model.provider, 'fake');
  } finally {
    if (prevHome === undefined) delete process.env.RUBY_HOME;
    else process.env.RUBY_HOME = prevHome;
  }
});

test('persona block round-trips, keeps other text, and disappears when everything is default', () => {
  const hand = 'Speak like a pirate.';
  const p1 = writePersona(hand, { name: 'Juno', owner: 'Dr. Sam Lee', notes: 'Short answers.' });
  assert.deepEqual(readPersona(p1), { name: 'Juno', owner: 'Dr. Sam Lee', notes: 'Short answers.' });
  assert.ok(p1!.endsWith(`\n\n${hand}`));
  const p2 = writePersona(p1, { name: 'Ruby', owner: '', notes: '' });
  assert.equal(p2, hand);
  assert.equal(writePersona(undefined, { name: 'Ruby', owner: '', notes: '' }), undefined);
  assert.deepEqual(readPersona(undefined), { name: 'Ruby', owner: '', notes: '' });
});

test('AnswerPrompter: flags answer by id; bad choices and missing answers are clear errors', async () => {
  const p = new AnswerPrompter({ provider: 'nope', yes: 'true', seq: ['a', 'b'] });
  await assert.rejects(p.select({ id: 'provider', message: 'Provider?', choices: [{ value: 'anthropic', label: 'A' }] }), /--provider must be one of anthropic \(got "nope"\)/);
  await assert.rejects(p.text({ id: 'model', message: 'Model ID' }), /Missing an answer for "Model ID": pass --model/);
  assert.equal(await p.confirm({ id: 'yes', message: 'ok?', default: false }), true);
  assert.equal(await p.confirm({ id: 'other', message: 'ok?', default: true, auto: false }), false);
  assert.equal(await p.text({ id: 'seq', message: 's' }), 'a');
  assert.equal(await p.text({ id: 'seq', message: 's' }), 'b');
  assert.equal(await p.text({ id: 'seq', message: 's' }), 'b');
  await assert.rejects(p.text({ id: 'v', message: 'v', default: 'x', validate: () => 'nope' }), /--v: nope/);
});
