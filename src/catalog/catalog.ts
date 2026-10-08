import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pricing } from '../contracts/index.ts';
import { OPENROUTER_MODELS_URL, catalogId, nativeName, parseOpenRouter } from './openrouter.ts';
import type { Catalog, CatalogModel, ProviderRef } from './types.ts';

const SNAPSHOT_FILE = join(import.meta.dirname, 'snapshot.json');
/** A response with fewer models than this is not a real list; it never replaces the cache. */
const MIN_MODELS = 20;
const TIMEOUT_MS = 15_000;

export const cacheFile = (home: string): string => join(home, 'cache', 'models.json');

function readCatalog(file: string, source: Catalog['source']): Catalog | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; models?: unknown };
    if (typeof raw.fetchedAt !== 'string' || !Array.isArray(raw.models) || raw.models.length < MIN_MODELS) return null;
    const models = (raw.models as Partial<CatalogModel>[]).filter((m): m is CatalogModel => typeof m?.id === 'string');
    return models.length < MIN_MODELS ? null : { source, fetchedAt: raw.fetchedAt, models };
  } catch {
    return null;
  }
}

/**
 * The model catalog without touching the network: the local cache when it is newer than the snapshot shipped
 * with Garnet, else the snapshot. An unreadable or corrupt cache is ignored.
 */
export function loadCatalog(home?: string): Catalog {
  const snapshot = readCatalog(SNAPSHOT_FILE, 'snapshot');
  if (!snapshot) throw new Error(`The bundled model snapshot ${SNAPSHOT_FILE} is missing or damaged; reinstall Garnet.`);
  const cached = home ? readCatalog(cacheFile(home), 'cache') : null;
  return cached && cached.fetchedAt > snapshot.fetchedAt ? cached : snapshot;
}

export type RefreshResult = { catalog: Catalog; ok: boolean; detail: string };

/**
 * Fetches OpenRouter's current model list and caches it under `<home>/cache`. On any failure (offline, bad
 * response) the catalog already on disk is returned with `ok: false` and the reason; nothing is overwritten.
 */
export async function refreshCatalog(home: string | undefined, fetchFn: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<RefreshResult> {
  try {
    const res = await fetchFn(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = parseOpenRouter(await res.json());
    if (models.length < MIN_MODELS) throw new Error(`only ${models.length} models in the response`);
    const catalog: Catalog = { source: 'live', fetchedAt: now().toISOString(), models };
    if (home) writeCache(cacheFile(home), catalog);
    return { catalog, ok: true, detail: `${models.length} models from openrouter.ai` };
  } catch (e) {
    const why = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message;
    return { catalog: loadCatalog(home), ok: false, detail: `could not refresh model prices from openrouter.ai (${why})` };
  }
}

function writeCache(file: string, catalog: Catalog): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ fetchedAt: catalog.fetchedAt, models: catalog.models }));
    renameSync(tmp, file);
  } catch {
    // A cache that cannot be written only means the next run uses the snapshot again.
  }
}

/** The catalog entry for a model of this provider, or undefined when the catalog does not list it. */
export function findModel(catalog: Catalog, ref: ProviderRef, name: string): CatalogModel | undefined {
  const id = catalogId(ref, name);
  return id === null ? undefined : catalog.models.find((m) => m.id === id);
}

/** Known price for a model, or undefined. Used to cost token usage when `model.pricing` is not configured. */
export function catalogPricing(catalog: Catalog, ref: ProviderRef, name: string): Pricing | undefined {
  return findModel(catalog, ref, name)?.pricing ?? undefined;
}

/** Models a provider offers according to the catalog, newest first, for suggestions. Empty for providers it cannot cover. */
export function suggestModels(catalog: Catalog, ref: ProviderRef, limit: number): { name: string; model: CatalogModel }[] {
  const probe = catalogId(ref, 'x');
  if (probe === null) return [];
  const prefix = probe.slice(0, probe.length - 1);
  return catalog.models
    .filter((m) => m.id.startsWith(prefix) && !/image|tts|embed|live|robotics|customtools|latest|:/.test(m.id.slice(prefix.length)))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .slice(0, limit)
    .map((model) => ({ name: nativeName(ref, model.id.slice(prefix.length)), model }));
}

const usd = (n: number): string => (n < 0.1 ? `$${Number(n.toPrecision(2))}` : `$${n.toFixed(2).replace(/\.?0+$/, '')}`);

/** "$0.75 in / $3.75 out per million tokens", "free", or why the price is unknown. */
export function describePricing(model: CatalogModel | undefined, catalogKnown: boolean): string {
  if (!model) return catalogKnown ? 'price unknown (not in the model catalog)' : 'price unknown (the catalog does not cover this provider)';
  const p = model.pricing;
  if (!p) return 'price unknown (the catalog lists no fixed price)';
  if (p.input === 0 && p.output === 0) return 'free';
  return `${usd(p.input)} in / ${usd(p.output)} out per million tokens${model.tiered ? ' (higher for long prompts)' : ''}`;
}

/** One line for setup and `providers add`: what is known about the model's price, and how fresh that is. */
export function priceLine(catalog: Catalog, ref: ProviderRef, name: string): string {
  const m = findModel(catalog, ref, name);
  const covered = catalogId(ref, name) !== null;
  const age = `${catalog.source === 'live' ? 'fetched just now' : `${catalog.source} of ${catalog.fetchedAt.slice(0, 10)}`}`;
  return `${name}: ${describePricing(m, covered)} (${age})${m?.pricing ? '' : '; cost will show "?" until you set model.pricing'}`;
}
