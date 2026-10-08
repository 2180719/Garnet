import { DEFAULT_PROVIDER, PROVIDER_NAME_RE, type GarnetConfig, type ModelConfig } from './schema.ts';

export type NamedProvider = { name: string; model: ModelConfig; active: boolean };

/** The environment variable (or stored secret) a provider reads its key from unless `apiKeyEnv` says otherwise. */
const DEFAULT_KEY_ENV: Record<ModelConfig['provider'], string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'openai-compatible': 'ANTHROPIC_API_KEY', // the pre-named-providers default; doctor warns when it would be sent away from Anthropic
  fake: 'ANTHROPIC_API_KEY',
};

/** Name of the key a provider reads: `apiKeyEnv`, else the provider's default. */
export function keyEnvOf(m: ModelConfig): string {
  return m.apiKeyEnv ?? DEFAULT_KEY_ENV[m.provider];
}

/** Key names with a well-known owner, including the defaults other subsystems read when they name none. */
const WELL_KNOWN_KEY_ENV = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'LOCAL_MODEL_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY'];

/** Every credential name the config refers to outside provider `except`, whether or not its feature is on. A provider must never read one of them. */
function reservedKeyNames(config: GarnetConfig, except: string): Set<string> {
  const names = [
    ...WELL_KNOWN_KEY_ENV,
    ...listProviders(config).filter((p) => p.name !== except).map((p) => keyEnvOf(p.model)),
    config.channels.telegram.tokenEnv,
    config.channels.discord.tokenEnv,
    config.web.search.apiKeyEnv,
    config.media.transcription.apiKeyEnv,
    config.sandbox.ssh.passphraseEnv,
    config.connectors.github.tokenEnv,
    config.connectors.calendar.urlEnv,
    ...Object.values(config.connectors.http.credentials).map((c) => c.secretEnv),
  ];
  return new Set(names.filter((n): n is string => typeof n === 'string'));
}

/**
 * The key name a new provider called `name` gets (`my-laptop` -> `MY_LAPTOP_API_KEY`), so providers never share one by accident.
 * The result is always a valid secret name and never one another provider, channel, tool or connector reads;
 * in those cases it is prefixed with `GARNET_` until it is free.
 */
export function providerKeyEnv(config: GarnetConfig, name: string): string {
  let key = `${name.toUpperCase().replaceAll('-', '_')}_API_KEY`;
  const taken = reservedKeyNames(config, name);
  while (/^[0-9]/.test(key) || taken.has(key)) key = `GARNET_${key}`;
  return key;
}

/** Every provider: `default` (the `model` block) first, then `providers` in file order. */
export function listProviders(config: GarnetConfig): NamedProvider[] {
  const active = config.activeProvider;
  return [
    { name: DEFAULT_PROVIDER, model: config.model, active: active === DEFAULT_PROVIDER },
    ...Object.entries(config.providers).map(([name, model]) => ({ name, model, active: active === name })),
  ];
}

export function findProvider(config: GarnetConfig, name: string): NamedProvider | undefined {
  return listProviders(config).find((p) => p.name === name);
}

/** The provider in use. Validation guarantees `activeProvider` exists. */
export function activeProvider(config: GarnetConfig): NamedProvider {
  return findProvider(config, config.activeProvider) ?? listProviders(config)[0]!;
}

/** Null when `name` can be used for a new provider, else why not. */
export function providerNameProblem(config: GarnetConfig, name: string): string | null {
  if (name === DEFAULT_PROVIDER) return '"default" is reserved for the top-level model block';
  if (!PROVIDER_NAME_RE.test(name)) return 'use lowercase letters, digits and dashes (at most 32, starting with a letter or digit)';
  if (Object.hasOwn(config.providers, name)) return `a provider named "${name}" already exists`;
  return null;
}

/** A copy of the config with `name` active, optionally on another model id. */
export function withActiveProvider(config: GarnetConfig, name: string, modelName?: string): GarnetConfig {
  const p = findProvider(config, name);
  if (!p) throw new Error(`No provider named "${name}" (known: ${listProviders(config).map((x) => x.name).join(', ')})`);
  if (name === DEFAULT_PROVIDER) return { ...config, activeProvider: name, ...(modelName ? { model: { ...config.model, name: modelName } } : {}) };
  return { ...config, activeProvider: name, ...(modelName ? { providers: { ...config.providers, [name]: { ...p.model, name: modelName } } } : {}) };
}

/** A copy with a provider added (`name` must pass `providerNameProblem`). */
export function withProvider(config: GarnetConfig, name: string, model: ModelConfig): GarnetConfig {
  return { ...config, providers: { ...config.providers, [name]: model } };
}

/** A copy without provider `name`. The default block and the active provider cannot be removed. */
export function withoutProvider(config: GarnetConfig, name: string): GarnetConfig {
  if (name === DEFAULT_PROVIDER) throw new Error('"default" is the top-level model block and cannot be removed');
  if (!Object.hasOwn(config.providers, name)) throw new Error(`No provider named "${name}"`);
  if (config.activeProvider === name) throw new Error(`"${name}" is the active provider; switch to another first (garnet providers use <name>)`);
  const rest = { ...config.providers };
  delete rest[name];
  return { ...config, providers: rest };
}
