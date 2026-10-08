// Reads OpenRouter's public model list (https://openrouter.ai/api/v1/models, no key needed) into catalog entries.
import type { PriceTier, Pricing } from '../contracts/index.ts';
import type { CatalogModel, ProviderRef } from './types.ts';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

type Raw = {
  id?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  pricing?: Record<string, unknown> & { overrides?: unknown };
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** OpenRouter quotes USD per token as a string; the catalog uses USD per million tokens, rounded to hide float noise. */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Number((n * 1e6).toPrecision(6)) : undefined;
}

function ratesOf(raw: Record<string, unknown>): Pricing | null {
  const input = perMillion(raw['prompt']);
  const output = perMillion(raw['completion']);
  if (input === undefined || output === undefined) return null; // missing, or "-1" for variable pricing
  const cacheRead = perMillion(raw['input_cache_read']);
  const cacheWrite = perMillion(raw['input_cache_write']);
  return { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

/** Base rates plus the higher long-prompt tiers OpenRouter lists under `overrides`. */
function pricingOf(raw: Raw['pricing']): Pricing | null {
  if (!raw) return null;
  const base = ratesOf(raw);
  if (!base) return null;
  const tiers: PriceTier[] = [];
  for (const o of Array.isArray(raw.overrides) ? (raw.overrides as Record<string, unknown>[]) : []) {
    const rates = o && typeof o === 'object' ? ratesOf(o) : null;
    const min = num(o?.['min_prompt_tokens']);
    if (rates && min !== null) tiers.push({ minPromptTokens: min, ...rates });
  }
  return tiers.length ? { ...base, tiers } : base;
}

/**
 * Chat models from an OpenRouter `/models` response. Anything that cannot produce text, the `:batch` price
 * variants and entries without an id are left out. Throws when the body is not a model list at all.
 */
export function parseOpenRouter(body: unknown): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('not an OpenRouter model list');
  const out: CatalogModel[] = [];
  for (const raw of data as Raw[]) {
    if (typeof raw?.id !== 'string' || raw.id.endsWith(':batch')) continue;
    if (!strings(raw.architecture?.output_modalities).includes('text')) continue;
    const input = strings(raw.architecture?.input_modalities);
    out.push({
      id: raw.id,
      created: num(raw.created),
      contextWindow: num(raw.context_length),
      maxOutputTokens: num(raw.top_provider?.max_completion_tokens),
      pricing: pricingOf(raw.pricing),
      tiered: (pricingOf(raw.pricing)?.tiers?.length ?? 0) > 0,
      vision: input.includes('image'),
      pdf: input.includes('file'),
    });
  }
  return out;
}

/** The id the provider's own API uses for a catalog id's model part (Anthropic writes `claude-opus-4-5`, the catalog `claude-opus-4.5`). */
export function nativeName(ref: ProviderRef, catalogName: string): string {
  return ref.provider === 'anthropic' ? catalogName.replaceAll('.', '-') : catalogName;
}

/**
 * The catalog id for a model of this provider, or null when the catalog has nothing for it (a local server,
 * a self-hosted gateway). Anthropic's `claude-opus-4-5-20251101` is OpenRouter's `anthropic/claude-opus-4.5`.
 */
export function catalogId(ref: ProviderRef, name: string): string | null {
  const id = name.replace(/^models\//, '');
  switch (ref.provider) {
    case 'anthropic': {
      const bare = id.replace(/-\d{8}$/, '');
      return `anthropic/${bare.replace(/^(claude-[a-z]+)-(\d+)-(\d+)$/, '$1-$2.$3').replace(/^claude-(\d+)-(\d+)-([a-z]+)$/, 'claude-$1.$2-$3')}`;
    }
    case 'gemini': {
      // Only Google's own endpoint: a proxy or gateway behind a custom base URL may charge other rates.
      if (ref.baseUrl) {
        try {
          if (new URL(ref.baseUrl).host !== 'generativelanguage.googleapis.com') return null;
        } catch {
          return null;
        }
      }
      return `google/${id}`;
    }
    case 'openai-compatible': {
      let host = '';
      try {
        host = new URL(ref.baseUrl ?? '').host;
      } catch {
        return null;
      }
      if (host === 'openrouter.ai') return id;
      if (host === 'api.openai.com') return `openai/${id}`;
      return null;
    }
    default:
      return null;
  }
}
