import type { Pricing } from '../contracts/index.ts';

/** One model as the catalog knows it. Unknown values are `null`, never a guess. */
export type CatalogModel = {
  /** The id the catalog lists it under (OpenRouter's `vendor/model` form). */
  id: string;
  /** Unix seconds the model was added to the source; used to sort newest first. */
  created: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** Base price per million tokens; `null` when the source has no fixed price (routers, variable-priced models). */
  pricing: Pricing | null;
  /** The price has higher long-prompt rates (`pricing.tiers`); costing applies them per call. */
  tiered: boolean;
  /** Accepts images / PDFs as input. */
  vision: boolean;
  pdf: boolean;
};

/** Where the catalog in memory came from: the file shipped with Garnet, the local cache, or a fetch just now. */
export type CatalogSource = 'snapshot' | 'cache' | 'live';

export type Catalog = { source: CatalogSource; fetchedAt: string; models: CatalogModel[] };

/** The slice of a model config that decides which catalog entry applies. */
export type ProviderRef = { provider: string; baseUrl?: string | undefined };
