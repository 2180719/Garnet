import { OpenAICompatibleModel, type OpenAICompatibleOptions } from './openai-compatible.ts';

/** Google's OpenAI-compatible Chat Completions endpoint for the Gemini API. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
/** Secret name holding the Gemini API key (sent as `Authorization: Bearer`, which the compatibility endpoint accepts). */
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

export type GeminiModelInfo = {
  id: string;
  /** Input context window in tokens. */
  contextWindow: number;
  /** Largest output Google documents for the model. */
  maxOutputTokens: number;
  /** Reads images and PDFs natively (all current Gemini models do). */
  vision: boolean;
  pdf: boolean;
  note?: string;
};

/**
 * Known explicit Gemini model ids (limits from Google's model documentation). Selectable by name in config
 * and setup; unknown ids still work (a newer or custom model gets the defaults below).
 * Aliases such as `gemini-flash-latest` are deliberately not listed: explicit ids do not change under you.
 */
export const GEMINI_MODELS: readonly GeminiModelInfo[] = [
  { id: 'gemini-2.5-pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true, pdf: true, note: 'strongest stable model; thinking on' },
  { id: 'gemini-2.5-flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true, pdf: true, note: 'fast and inexpensive; thinking on' },
  { id: 'gemini-2.5-flash-lite', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true, pdf: true, note: 'cheapest' },
  { id: 'gemini-2.0-flash', contextWindow: 1_048_576, maxOutputTokens: 8_192, vision: true, pdf: true, note: 'previous generation' },
  { id: 'gemini-3-pro-preview', contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: true, pdf: true, note: 'preview: may change or be retired' },
];

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export function geminiModelInfo(id: string): GeminiModelInfo | undefined {
  return GEMINI_MODELS.find((m) => m.id === id.replace(/^models\//, ''));
}

export type GeminiOptions = Omit<OpenAICompatibleOptions, 'baseUrl' | 'label' | 'tokenParam'> & { baseUrl?: string | undefined };

/**
 * Gemini through its OpenAI-compatible endpoint: tools, SSE streaming (usage in the last chunk) and
 * `image_url`/`file` parts all work there, so this is a preset over `OpenAICompatibleModel`, not a native adapter.
 * Preset: base URL, `max_tokens` for the output cap, media on for every model (override with `vision`/`pdf`),
 * and the context window from the table unless set.
 */
export class GeminiModel extends OpenAICompatibleModel {
  constructor(options: GeminiOptions) {
    const info = geminiModelInfo(options.model);
    super({
      ...options,
      baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
      label: 'gemini',
      tokenParam: 'max_tokens',
      contextWindow: options.contextWindow ?? info?.contextWindow ?? 1_048_576,
      vision: options.vision ?? true,
      pdf: options.pdf ?? true,
    });
  }
}
