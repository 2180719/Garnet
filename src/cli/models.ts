// `garnet models [provider]`: the models a provider offers with their current prices, and the shared
// lookup that `garnet providers add` runs. Live data comes from the provider's own model list (needs its key)
// and OpenRouter's public price list; offline, the cache or the snapshot shipped with Garnet answers.
import { parseArgs } from 'node:util';
import { catalogId, describePricing, findModel, loadCatalog, refreshCatalog, suggestModels, type Catalog } from '../catalog/index.ts';
import { findProvider, keyEnvOf, listProviders, loadConfig, type ModelConfig } from '../config/index.ts';
import { GarnetError, errorMessage } from '../contracts/index.ts';
import { openSecretStore, secretLookup } from '../secrets/index.ts';
import type { Io } from './main.ts';
import { checkModel, type FetchFn } from './setup/checks.ts';

export const MODELS_USAGE = `Usage: garnet models [<provider>] [--offline]

Lists the models a provider offers and what they cost per million tokens. <provider> is a name from
\`garnet providers list\` (default: the one in use). Asks the provider for its current model list (needs its
key) and openrouter.ai for current prices; --offline uses the cache or the list shipped with Garnet.
A price shown as "unknown" means cost will show "?" until you set model.pricing in config.json.
`;

export type LookupOpts = { home: string; env?: NodeJS.ProcessEnv | undefined; fetch?: FetchFn | undefined; offline?: boolean | undefined };

export type ModelLookup = { catalog: Catalog; notes: string[]; live: string[] | null };

/** Refreshes prices and, when the key is available, the provider's own model ids. Never throws; problems become `notes`. */
export async function lookupModels(model: ModelConfig, o: LookupOpts): Promise<ModelLookup> {
  const notes: string[] = [];
  if (o.offline) return { catalog: loadCatalog(o.home), notes, live: null };
  const refreshed = await refreshCatalog(o.home, o.fetch);
  if (!refreshed.ok) notes.push(`${refreshed.detail}; showing the ${refreshed.catalog.source} from ${refreshed.catalog.fetchedAt.slice(0, 10)}`);
  let live: string[] | null = null;
  if (model.provider !== 'fake') {
    let key: string | undefined;
    try {
      key = secretLookup(o.env ?? process.env, openSecretStore(o.home, o.env ?? process.env))(keyEnvOf(model));
    } catch (e) {
      notes.push(`could not read ${keyEnvOf(model)}: ${errorMessage(e)}`);
    }
    if (key || model.provider === 'openai-compatible') {
      const check = await checkModel(model, key, o.fetch);
      if (check.ok && check.models) live = check.models;
      else if (!check.ok) notes.push(`the provider's own model list was not available (${check.detail})`);
    } else {
      notes.push(`no key found (${keyEnvOf(model)}), so the provider's own model list was not fetched`);
    }
  }
  return { catalog: refreshed.catalog, notes, live };
}

const usd = (n: number | undefined): string => (n === undefined ? '?' : `$${Number(n.toPrecision(3))}`);

export function modelRows(model: ModelConfig, lookup: ModelLookup, limit: number): string[] {
  const { catalog, live } = lookup;
  const names = live ? live.slice().sort().slice(0, limit) : suggestModels(catalog, model, limit).map((s) => s.name);
  return names.map((name) => {
    const m = findModel(catalog, model, name);
    const price = m?.pricing ? `${usd(m.pricing.input).padStart(8)} in ${usd(m.pricing.output).padStart(8)} out` : `price unknown`;
    return `  ${name.padEnd(40)} ${price}${m?.tiered ? '  (higher for long prompts)' : ''}`;
  });
}

type Opts = { home?: string; fetch?: FetchFn; env?: NodeJS.ProcessEnv };

export async function modelsCommand(args: string[], io: Io, opts: Opts = {}): Promise<number> {
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    io.out(MODELS_USAGE);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { offline: { type: 'boolean' } } });
    if (positionals.length > 1) throw new GarnetError('invalid_input', MODELS_USAGE);
    const { config, paths } = loadConfig(opts.home);
    const picked = positionals[0] ? findProvider(config, positionals[0]) : listProviders(config).find((p) => p.active);
    if (!picked) throw new GarnetError('invalid_input', `No provider named "${positionals[0]}" (see \`garnet providers list\`).`);
    const lookup = await lookupModels(picked.model, { home: paths.home, env: opts.env, fetch: opts.fetch, offline: values.offline });
    io.out(`${picked.name} (${picked.model.provider}) · ${lookup.live ? 'models from the provider' : 'models from the catalog'}\n`);
    for (const row of modelRows(picked.model, lookup, 15)) io.out(`${row}\n`);
    if (lookup.live && lookup.live.length > 15) io.out(`  … and ${lookup.live.length - 15} more the provider lists\n`);
    const own = findModel(lookup.catalog, picked.model, picked.model.name);
    io.out(`\nIn use: ${picked.model.name}: ${picked.model.pricing ? 'price set in config (model.pricing)' : describePricing(own, catalogId(picked.model, picked.model.name) !== null)}\n`);
    io.out(`Prices: ${lookup.catalog.source} of ${lookup.catalog.fetchedAt.slice(0, 10)}, base rate per million tokens.\n`);
    for (const n of lookup.notes) io.out(`Note: ${n}.\n`);
    return 0;
  } catch (e) {
    if (String((e as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS')) throw e;
    io.err(`${errorMessage(e)}\n`);
    return e instanceof GarnetError && e.category === 'invalid_input' ? 2 : 1;
  }
}
