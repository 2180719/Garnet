import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { cacheFile, catalogId, catalogPricing, describePricing, findModel, loadCatalog, parseOpenRouter, priceLine, refreshCatalog, suggestModels } from './index.ts';
import type { Catalog, CatalogModel } from './index.ts';

const raw = (id: string, extra: object = {}) => ({
  id,
  created: 1_790_000_000,
  context_length: 200_000,
  architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
  top_provider: { max_completion_tokens: 64_000 },
  pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001', input_cache_write: '0.0000025' },
  ...extra,
});
const filler = Array.from({ length: 25 }, (_, i) => raw(`vendor/filler-${i}`));
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('parseOpenRouter: per-token strings become USD per million, junk entries are dropped', () => {
  const models = parseOpenRouter({
    data: [
      raw('anthropic/claude-sonnet-5.5'),
      raw('anthropic/claude-sonnet-5.5:batch'),
      raw('vendor/image-only', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
      raw('openrouter/auto', { pricing: { prompt: '-1', completion: '-1' } }),
      raw('vendor/free', { pricing: { prompt: '0', completion: '0' } }),
      raw('vendor/tiered', { pricing: { prompt: '0.000001', completion: '0.000002', overrides: [{ min_prompt_tokens: 100_000, prompt: '0.000002', completion: '0.000004' }] } }),
      { nope: true },
    ],
  });
  assert.deepEqual(models.map((m) => m.id), ['anthropic/claude-sonnet-5.5', 'openrouter/auto', 'vendor/free', 'vendor/tiered']);
  assert.deepEqual(models[0]!.pricing, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.equal(models[0]!.contextWindow, 200_000);
  assert.equal(models[0]!.maxOutputTokens, 64_000);
  assert.deepEqual([models[0]!.vision, models[0]!.pdf], [true, true]);
  assert.equal(models[1]!.pricing, null, 'variable pricing is unknown, not zero');
  assert.deepEqual(models[2]!.pricing, { input: 0, output: 0 });
  assert.equal(models[3]!.tiered, true);
  assert.throws(() => parseOpenRouter({ error: 'x' }));
});

test('catalogId maps Garnet models to catalog ids and returns null where the catalog has no say', () => {
  assert.equal(catalogId({ provider: 'anthropic' }, 'claude-opus-4-5-20251101'), 'anthropic/claude-opus-4.5');
  assert.equal(catalogId({ provider: 'anthropic' }, 'claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(catalogId({ provider: 'anthropic' }, 'claude-3-5-haiku-20241022'), 'anthropic/claude-3.5-haiku');
  assert.equal(catalogId({ provider: 'gemini' }, 'models/gemini-3.8-flash'), 'google/gemini-3.8-flash');
  assert.equal(catalogId({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }, 'gpt-5.5'), 'openai/gpt-5.5');
  assert.equal(catalogId({ provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1' }, 'x/y'), 'x/y');
  assert.equal(catalogId({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }, 'llama3'), null);
  assert.equal(catalogId({ provider: 'fake' }, 'x'), null);
});

test('the bundled snapshot prices the current Anthropic, Gemini and OpenAI models', () => {
  const c = loadCatalog();
  assert.equal(c.source, 'snapshot');
  for (const [ref, name] of [
    [{ provider: 'anthropic' }, 'claude-opus-5-5'],
    [{ provider: 'anthropic' }, 'claude-sonnet-5-5-20261001'],
    [{ provider: 'anthropic' }, 'claude-haiku-5-5'],
    [{ provider: 'gemini' }, 'gemini-3.8-flash'],
    [{ provider: 'gemini' }, 'gemini-2.5-pro'],
    [{ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }, 'gpt-5.5'],
  ] as const) {
    const p = catalogPricing(c, ref, name);
    assert.ok(p && p.input > 0 && p.output > p.input / 10, `${name} has a price`);
  }
  // Anthropic's published rates (platform.claude.com pricing page, 2026-10-08): Sonnet 5.5 reads its cache at $0.10.
  assert.deepEqual(catalogPricing(c, { provider: 'anthropic' }, 'claude-sonnet-5-5'), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.equal(findModel(c, { provider: 'gemini' }, 'gemini-3.8-flash')?.contextWindow, 1_048_576);
  assert.equal(catalogPricing(c, { provider: 'anthropic' }, 'claude-unknown-9'), undefined);
});

test('catalog prices keep cache-write rates only where the adapter reports cache writes', async () => {
  const { costOf } = await import('../contracts/index.ts');
  const gemini = catalogPricing(loadCatalog(), { provider: 'gemini' }, 'gemini-3.8-flash');
  assert.ok(gemini && gemini.cacheWrite === undefined, 'no write rate: the OpenAI-compatible adapter reports no cache writes');
  // Usage as that adapter reports it for a call with no cache details: reads known, writes unknown.
  const cost = costOf({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: null }, gemini);
  assert.ok(cost !== null && cost > 0);
  assert.ok(catalogPricing(loadCatalog(), { provider: 'anthropic' }, 'claude-opus-5-5')?.cacheWrite !== undefined);
});

test('long-prompt tiers are parsed and applied to the call that crosses them', async () => {
  const { costOf } = await import('../contracts/index.ts');
  const haiku = catalogPricing(loadCatalog(), { provider: 'anthropic' }, 'claude-haiku-5-5');
  assert.deepEqual(haiku?.tiers?.map((t) => [t.minPromptTokens, t.input, t.output]), [[100_000, 0.5, 2.5]]);
  const call = (inputTokens: number) => costOf({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, haiku);
  assert.equal(call(100_000), 0.01, 'at the threshold the base rate applies ($0.10 per million)');
  assert.equal(call(100_001), 0.0500005, 'over it the whole call is billed at the higher rate ($0.50 per million)');
});

test('a cache whose entries are damaged is ignored rather than crashing suggestions', () => {
  const home = tempDir();
  mkdirSync(join(home, 'cache'), { recursive: true });
  writeFileSync(cacheFile(home), JSON.stringify({ fetchedAt: '2999-01-01T00:00:00Z', models: [{ nope: 1 }, ...filler] }));
  const c = loadCatalog(home);
  assert.equal(c.source, 'cache');
  assert.equal(c.models.length, filler.length, 'entries without an id are dropped');
  assert.doesNotThrow(() => suggestModels(c, { provider: 'gemini' }, 5));
});

test('refreshCatalog caches a good response and the cache wins only while it is newer than the snapshot', async () => {
  const home = tempDir();
  const ok = await refreshCatalog(home, reply({ data: [raw('google/gemini-9-new'), ...filler] }), () => new Date('2999-01-01T00:00:00Z'));
  assert.equal(ok.ok, true);
  assert.equal(ok.catalog.source, 'live');
  assert.equal(existsSync(cacheFile(home)), true);
  const loaded = loadCatalog(home);
  assert.equal(loaded.source, 'cache');
  assert.ok(findModel(loaded, { provider: 'gemini' }, 'gemini-9-new'));
  // A cache older than the snapshot is ignored, so an upgrade is never stuck on stale prices.
  writeFileSync(cacheFile(home), JSON.stringify({ fetchedAt: '2000-01-01T00:00:00Z', models: loaded.models }));
  assert.equal(loadCatalog(home).source, 'snapshot');
});

test('refreshCatalog failures keep what is on disk and say why', async () => {
  const home = tempDir();
  for (const [fetchFn, why] of [
    [reply({}, 503), /HTTP 503/],
    [reply({ data: [raw('a/b')] }), /only 1 models/],
    [reply({ nope: 1 }), /not an OpenRouter model list/],
    [(async () => { throw new TypeError('fetch failed'); }) as typeof fetch, /fetch failed/],
  ] as const) {
    const r = await refreshCatalog(home, fetchFn);
    assert.equal(r.ok, false);
    assert.match(r.detail, why);
    assert.equal(r.catalog.source, 'snapshot');
  }
  assert.equal(existsSync(cacheFile(home)), false, 'nothing was cached');
  mkdirSync(join(home, 'cache'), { recursive: true });
  writeFileSync(cacheFile(home), '{ not json');
  assert.equal(loadCatalog(home).source, 'snapshot', 'a corrupt cache is ignored');
});

test('unknown prices are said in words: not in the catalog, not covered, or no fixed price', () => {
  const m = (pricing: CatalogModel['pricing'], tiered = false): CatalogModel => ({ id: 'a/b', created: 1, contextWindow: 1, maxOutputTokens: 1, pricing, tiered, vision: false, pdf: false });
  assert.match(describePricing(undefined, true), /not in the model catalog/);
  assert.match(describePricing(undefined, false), /does not cover this provider/);
  assert.match(describePricing(m(null), true), /no fixed price/);
  assert.equal(describePricing(m({ input: 0, output: 0 }), true), 'free');
  assert.equal(describePricing(m({ input: 0.1, output: 0.5 }, true), true), '$0.1 in / $0.5 out per million tokens (higher for long prompts)');
  const c: Catalog = { source: 'snapshot', fetchedAt: '2026-10-08T00:00:00Z', models: [] };
  assert.match(priceLine(c, { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }, 'llama3'), /llama3: price unknown \(the catalog does not cover this provider\) \(snapshot of 2026-10-08\); cost will show "\?"/);
});

test('suggestModels lists a provider\'s newest chat models without aliases, images or batch variants', () => {
  const mk = (id: string, created: number): CatalogModel => ({ id, created, contextWindow: 1, maxOutputTokens: 1, pricing: null, tiered: false, vision: false, pdf: false });
  const c: Catalog = { source: 'snapshot', fetchedAt: 'x', models: [mk('google/gemini-a', 1), mk('google/gemini-c', 3), mk('google/gemini-b-image', 9), mk('google/gemini-x:free', 8), mk('openai/gpt-1', 5), mk('google/gemini-pro-latest', 7)] };
  assert.deepEqual(suggestModels(c, { provider: 'gemini' }, 5).map((s) => s.name), ['gemini-c', 'gemini-a']);
  assert.deepEqual(suggestModels(c, { provider: 'openai-compatible', baseUrl: 'http://localhost:1/v1' }, 5), []);
  const a: Catalog = { ...c, models: [mk('anthropic/claude-opus-4.5', 2)] };
  assert.deepEqual(suggestModels(a, { provider: 'anthropic' }, 5).map((s) => s.name), ['claude-opus-4-5'], 'Anthropic ids use dashes');
});
