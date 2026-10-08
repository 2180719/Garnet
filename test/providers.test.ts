// Named providers: config schema and migration, the CLI, secret names, and swapping in a running chat.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { chat } from '../src/cli/chat/index.ts';
import { main, type Io } from '../src/cli/main.ts';
import { complete, parseSlash } from '../src/cli/chat/commands.ts';
import {
  CONFIG_VERSION,
  activeProvider,
  changedProtectedPaths,
  defaultConfig,
  isProtectedConfigPath,
  loadConfig,
  parseConfig,
  providerNameProblem,
  redact,
  secretNames,
  withoutProvider,
} from '../src/config/index.ts';
import { createGarnet } from '../src/main.ts';

const cfg = (extra: object) => parseConfig({ version: CONFIG_VERSION, ...extra });
const problems = (raw: object): string[] => {
  try {
    cfg(raw);
    return [];
  } catch (e) {
    return (e as { detail?: { problems?: string[] } }).detail?.problems ?? [String(e)];
  }
};

test('migration: a v1 config keeps working as the provider "default"', () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, model: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', name: 'llama3', apiKeyEnv: 'LOCAL_MODEL_API_KEY' } }));
  const { config, migrated } = loadConfig(home);
  assert.equal(migrated, true);
  assert.equal(config.version, CONFIG_VERSION);
  assert.equal(config.activeProvider, 'default');
  assert.deepEqual(config.providers, {});
  assert.equal(activeProvider(config).model.name, 'llama3');
  assert.ok(existsSync(join(home, 'config.json.bak-v1')), 'a backup of the old file is kept');
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).version, CONFIG_VERSION);
});

test('migration: a v2 config (skills and connectors, no providers) becomes v3 with the same settings', () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 2, skills: { enabled: [] }, model: { name: 'claude-sonnet-5-5' } }));
  const { config, migrated } = loadConfig(home);
  assert.equal(migrated, true);
  assert.equal(config.version, 3);
  assert.equal(CONFIG_VERSION, 3);
  assert.equal(config.activeProvider, 'default');
  assert.equal(config.model.name, 'claude-sonnet-5-5');
  assert.ok(existsSync(join(home, 'config.json.bak-v2')));
});

test('providers: named entries, names are safe slugs, the active one must exist', () => {
  const c = cfg({
    providers: { work: { provider: 'gemini', name: 'gemini-2.5-pro' }, 'local-1': { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', name: 'qwen' } },
    activeProvider: 'work',
  });
  assert.equal(activeProvider(c).name, 'work');
  assert.equal(c.providers.work!.provider, 'gemini');
  for (const bad of ['Work', 'has space', '../x', '-lead', 'a'.repeat(33), 'default', '']) {
    assert.ok(problems({ providers: { [bad]: { provider: 'fake' } } }).length > 0, `rejects "${bad}"`);
  }
  assert.ok(problems({ activeProvider: 'nope' }).some((p) => /activeProvider "nope" is not defined/.test(p)));
  assert.ok(problems({ providers: { x: { provider: 'openai-compatible' } } }).some((p) => p.startsWith('providers.x.baseUrl')));
  assert.equal(providerNameProblem(c, 'work'), 'a provider named "work" already exists');
  assert.equal(providerNameProblem(c, 'default'), '"default" is reserved for the top-level model block');
  assert.equal(providerNameProblem(c, 'fresh'), null);
  assert.throws(() => withoutProvider(c, 'work'), /active provider/);
  assert.deepEqual(Object.keys(withoutProvider(c, 'local-1').providers), ['work']);
});

test('key names: gemini defaults to GEMINI_API_KEY; every provider\'s name is listed; redaction and protection cover providers', () => {
  const c = cfg({ providers: { g: { provider: 'gemini' }, o: { provider: 'openai-compatible', baseUrl: 'http://x/v1', apiKeyEnv: 'OTHER_KEY' } } });
  const names = secretNames(c);
  for (const n of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OTHER_KEY']) assert.ok(names.includes(n), n);
  assert.ok(!secretNames(defaultConfig()).includes('GEMINI_API_KEY'));
  for (const p of ['activeProvider', 'providers.work.provider', 'providers.work.baseUrl', 'providers.work.apiKeyEnv']) assert.ok(isProtectedConfigPath(p), p);
  assert.ok(!isProtectedConfigPath('providers.work.name'));
  assert.deepEqual(changedProtectedPaths(cfg({}), cfg({ providers: { a: { provider: 'gemini' } }, activeProvider: 'a' })), ['activeProvider', 'providers.a.provider']);
  const shown = JSON.stringify(redact({ providers: { work: { apiKeyEnv: 'GEMINI_API_KEY', name: 'sk-abcdefghijklmnopqrstuvwxyz' } } }));
  assert.ok(shown.includes('GEMINI_API_KEY') && !shown.includes('sk-abcdef'));
});

function harness(home: string) {
  let out = '';
  let err = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const run = async (...args: string[]) => {
    const prev = process.env.GARNET_HOME;
    process.env.GARNET_HOME = home;
    try {
      return await main(args, io);
    } finally {
      if (prev === undefined) delete process.env.GARNET_HOME;
      else process.env.GARNET_HOME = prev;
    }
  };
  return { run, out: () => out, err: () => err, reset: () => ((out = ''), (err = '')) };
}

test('garnet providers list|add|use|rm and config get|set|unset edit config.json with validation', async () => {
  const home = tempDir();
  const h = harness(home);
  assert.equal(await h.run('providers', 'list'), 0);
  assert.match(h.out(), /^\* default\s+anthropic · claude-opus-5-5/);
  h.reset();

  assert.equal(await h.run('providers', 'add', 'work', '--provider', 'gemini', '--use', '--offline'), 0);
  assert.match(h.out(), /Added provider "work": gemini · gemini-3\.8-flash .* key GEMINI_API_KEY.*\(now in use\)/);
  assert.match(h.out(), /garnet secrets set GEMINI_API_KEY/);
  assert.equal(loadConfig(home).config.activeProvider, 'work');
  h.reset();

  // Duplicate, bad name, missing base URL, missing model: refused, file unchanged.
  assert.equal(await h.run('providers', 'add', 'work', '--provider', 'gemini', '--offline'), 2);
  assert.match(h.err(), /already exists/);
  assert.equal(await h.run('providers', 'add', 'Bad Name', '--provider', 'fake', '--offline'), 2);
  assert.equal(await h.run('providers', 'add', 'loc', '--provider', 'openai-compatible', '--model', 'llama3', '--offline'), 1);
  assert.match(h.err(), /providers\.loc\.baseUrl/);
  assert.equal(await h.run('providers', 'add', 'loc', '--provider', 'anthropic', '--offline'), 2);
  assert.deepEqual(Object.keys(loadConfig(home).config.providers), ['work']);
  h.reset();

  assert.equal(await h.run('providers', 'add', 'loc', '--provider', 'openai-compatible', '--model', 'llama3', '--base-url', 'http://127.0.0.1:11434/v1', '--key-env', 'LOCAL_MODEL_API_KEY', '--offline'), 0);
  assert.equal(await h.run('providers', 'use', 'loc', 'qwen3'), 0);
  assert.equal(activeProvider(loadConfig(home).config).model.name, 'qwen3');
  assert.equal(await h.run('providers', 'use', 'ghost'), 1);
  assert.equal(await h.run('providers', 'rm', 'loc'), 1, 'the active provider cannot be removed');
  assert.equal(await h.run('providers', 'use', 'work'), 0);
  assert.equal(await h.run('providers', 'rm', 'loc'), 0);
  assert.equal(await h.run('providers', 'rm', 'default'), 1);
  h.reset();
  assert.equal(await h.run('providers', 'list'), 0);
  assert.match(h.out(), /\* work\s+gemini/);
  assert.doesNotMatch(h.out(), /loc/);

  h.reset();
  assert.equal(await h.run('config', 'get', 'providers.work.name'), 0);
  assert.equal(h.out(), '"gemini-3.8-flash"\n');
  assert.equal(await h.run('config', 'set', 'providers.work.name', 'gemini-2.5-pro'), 0);
  assert.equal(await h.run('config', 'set', 'providers.work.maxOutputTokens', '8000'), 0);
  assert.equal(loadConfig(home).config.providers.work!.maxOutputTokens, 8000);
  assert.equal(await h.run('config', 'set', 'providers.work.maxOutputTokens', '"lots"'), 1, 'invalid values are refused');
  assert.notEqual(await h.run('config', 'set', '__proto__.x', '1'), 0);
  assert.equal(await h.run('config', 'set', 'activeProvider', 'ghost'), 1);
  assert.equal(await h.run('config', 'unset', 'providers.work.maxOutputTokens'), 0);
  assert.equal(loadConfig(home).config.providers.work!.maxOutputTokens, 32_000);
  h.reset();
  assert.equal(await h.run('config', 'get', 'providers.work.nothing'), 1);
  assert.equal(await h.run('config', 'explain'), 0);
  assert.match(h.out(), /providers\.<key>\.provider/);
  assert.match(h.out(), /activeProvider/);
});

test('/provider: parsed, completed, lists, swaps from the next message and refuses what cannot work', async () => {
  assert.ok(parseSlash('/provider work') && 'command' in parseSlash('/provider work')!);
  assert.deepEqual(complete('/provider w', () => ['work', 'local']).candidates, ['work']);

  const home = tempDir();
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'AIza-test' };
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: CONFIG_VERSION,
      providers: { work: { provider: 'gemini', name: 'gemini-2.5-pro' }, nokey: { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', name: 'm', apiKeyEnv: 'NOKEY' } },
    }),
  );
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const seen: string[] = [];
  const done = chat([], { out: (t) => out.push(t), err: (t) => err.push(t), stdin, stdout: null, env: {} }, {
    createGarnet: (o) => {
      const g = createGarnet({ ...o, home, env, memoryDb: true });
      seen.push(g.model.id);
      const use = g.providers.use;
      g.providers.use = (name, model) => {
        const r = use(name, model);
        seen.push(`${g.model.id} window=${g.model.capabilities.contextWindow} images=${g.model.capabilities.media?.images}`);
        return r;
      };
      return g;
    },
  });
  stdin.end('/provider\n/provider work\n/provider nope\n/provider work gemini-2.5-flash\n/provider default\n/provider nokey\n/provider a b c\n/model\n');
  assert.equal(await done, 0);
  const e = err.join('');
  assert.match(e, /Garnet \(anthropic:claude-opus-5-5\)/);
  assert.match(e, /Providers\n\s+\S* default\s+anthropic · claude-opus-5-5\s+\(in use\)\n\s+work\s+gemini · gemini-2\.5-pro/);
  assert.match(e, /Now using work \(gemini:gemini-2\.5-pro\)\. It answers from your next message/);
  assert.match(e, /No provider named "nope" \(known: default, work, nokey\)\. Nothing changed\./);
  assert.match(e, /Now using work \(gemini:gemini-2\.5-flash\)/);
  assert.match(e, /Now using default \(anthropic:claude-opus-5-5\)/);
  assert.match(e, /Usage: \/provider \[name\] \[model\]/);
  assert.deepEqual(seen.slice(0, 3), ['anthropic:claude-opus-5-5', 'gemini:gemini-2.5-pro window=1048576 images=true', 'gemini:gemini-2.5-flash window=1048576 images=true']);
  // The file is untouched: /provider is for this chat only.
  assert.equal(loadConfig(home).config.activeProvider, 'default');
  assert.ok(!(err.join('') + out.join('')).includes('AIza-test'));
});

test('a swap changes pricing with the provider; --fake (an injected model) cannot be swapped', async () => {
  const home = tempDir();
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: CONFIG_VERSION,
      providers: { work: { provider: 'gemini', name: 'gemini-2.5-flash', maxOutputTokens: 4000, pricing: { input: 0.3, output: 2.5 } } },
    }),
  );
  const env = { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'AIza-test' };
  const garnet = createGarnet({ home, env, memoryDb: true });
  try {
    assert.ok(garnet.pricing && garnet.pricing.input > 0, 'built-in Anthropic price');
    const before = garnet.pricing;
    garnet.providers.use('work');
    assert.deepEqual(garnet.pricing, { input: 0.3, output: 2.5 });
    assert.equal(garnet.providers.active().name, 'work');
    assert.deepEqual(garnet.providers.list().map((p) => [p.name, p.active]), [['default', false], ['work', true]]);
    garnet.providers.use('default');
    assert.deepEqual(garnet.pricing, before);
    // A missing key refuses the swap and leaves the current provider in place.
  } finally {
    garnet.close();
  }
  const keyless = createGarnet({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, memoryDb: true });
  try {
    assert.throws(() => keyless.providers.use('work'), /No Gemini API key found/);
    assert.equal(keyless.model.id, 'anthropic:claude-opus-5-5');
    assert.equal(keyless.providers.active().name, 'default');
  } finally {
    keyless.close();
  }
  const fake = createGarnet({ home, env, memoryDb: true, noModel: true });
  try {
    assert.throws(() => fake.providers.use('work'), /cannot be swapped/);
  } finally {
    fake.close();
  }
});

test('providers add and models look up the provider\'s models and current prices; offline they fall back and say so', async () => {
  const { providers } = await import('../src/cli/providers.ts');
  const { modelsCommand } = await import('../src/cli/models.ts');
  const orBody = {
    data: Array.from({ length: 25 }, (_, i) => ({
      id: i === 0 ? 'google/gemini-3.8-flash' : `vendor/m-${i}`,
      created: 1_790_000_000,
      context_length: 1_048_576,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000008', completion: '0.000004' },
    })),
  };
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('openrouter.ai')) return new Response(JSON.stringify(orBody));
    assert.equal((init?.headers as Record<string, string>)['authorization'], 'Bearer GKEY');
    return new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.5-flash' }] }));
  }) as typeof fetch;
  const home = tempDir();
  const out: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => out.push(t) };
  const env = { GEMINI_API_KEY: 'GKEY' };

  assert.equal(await providers(['add', 'work', '--provider', 'gemini'], io, { home, fetch: fetchFn, env }), 0);
  assert.match(out.join(''), /gemini-3\.8-flash: \$0\.8 in \/ \$4 out per million tokens \(fetched just now\)/);
  assert.equal(seen.some((u) => u.endsWith('/v1beta/openai/models')), true, 'asked Google for its own model list');
  assert.equal(JSON.stringify(out).includes('GKEY'), false, 'the key is never printed');
  assert.equal(existsSync(join(home, 'cache', 'models.json')), true);

  out.length = 0;
  assert.equal(await providers(['add', 'old', '--provider', 'gemini', '--model', 'gemini-1.0-gone'], io, { home, fetch: fetchFn, env }), 0);
  assert.match(out.join(''), /Warning: the provider does not list "gemini-1\.0-gone"/);
  assert.match(out.join(''), /gemini-3\.5-flash/);

  out.length = 0;
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal(await modelsCommand(['work'], io, { home, fetch: down, env: {} }), 0);
  const text = out.join('');
  assert.match(text, /work \(gemini\) · models from the catalog/);
  assert.match(text, /gemini-3\.8-flash\s+\$0\.8 in\s+\$4 out/);
  assert.match(text, /Note: could not refresh model prices from openrouter\.ai \(fetch failed\)/);
  assert.match(text, /Note: no key found \(GEMINI_API_KEY\)/);

  out.length = 0;
  assert.equal(await modelsCommand(['nope', '--offline'], io, { home }), 2);
});
