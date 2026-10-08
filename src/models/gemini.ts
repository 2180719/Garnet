import { OpenAICompatibleModel, type OpenAICompatibleOptions } from './openai-compatible.ts';

/** Google's OpenAI-compatible Chat Completions endpoint for the Gemini API. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
/** Secret name holding the Gemini API key (sent as `Authorization: Bearer`, which the compatibility endpoint accepts). */
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/** Used when neither config nor the model catalog gives a window (all current Gemini models have 1M). */
const DEFAULT_CONTEXT_WINDOW = 1_048_576;

/** Default for new Gemini providers. Model ids and prices come from the model catalog (`src/catalog`), not a table here. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export type GeminiOptions = Omit<OpenAICompatibleOptions, 'baseUrl' | 'label' | 'tokenParam'> & { baseUrl?: string | undefined };

/**
 * Gemini through its OpenAI-compatible endpoint: tools, SSE streaming (usage in the last chunk) and
 * `image_url`/`file` parts all work there, so this is a preset over `OpenAICompatibleModel`, not a native adapter.
 * Preset: base URL, `max_tokens` for the output cap and media on for every model (override with `vision`/`pdf`).
 * The composition root passes the context window from the catalog; without one it assumes 1M.
 */
export class GeminiModel extends OpenAICompatibleModel {
  constructor(options: GeminiOptions) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
      label: 'gemini',
      tokenParam: 'max_tokens',
      contextWindow: options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      vision: options.vision ?? true,
      pdf: options.pdf ?? true,
    });
  }
}
