// `garnet providers list|add|use|rm`: edits to config.json, validated by the schema.
import { parseArgs } from 'node:util';
import {
  PROVIDER_KINDS,
  keyEnvOf,
  providerKeyEnv,
  listProviders,
  loadConfig,
  parseConfig,
  providerNameProblem,
  redact,
  withActiveProvider,
  withProvider,
  withoutProvider,
  writeConfig,
  type GarnetConfig,
  type ModelConfig,
} from '../config/index.ts';
import { GarnetError, errorMessage } from '../contracts/index.ts';
import { DEFAULT_GEMINI_MODEL, GEMINI_BASE_URL } from '../models/index.ts';
import type { Io } from './main.ts';

export const PROVIDERS_USAGE = `Usage: garnet providers <command>

  list                          Named providers; * marks the one in use
  add <name> --provider <kind> --model <id> [--base-url <url>] [--key-env <NAME>] [--use]
                                kind: anthropic | gemini | openai-compatible (needs --base-url)
  use <name> [<model>]          Make a provider (and optionally another model id) the one in use
  rm <name>                     Remove a provider (not "default", not the one in use)

Names are lowercase letters, digits and dashes. "default" is the top-level \`model\` block.
Keys are never stored here: --key-env names the variable or stored secret (garnet secrets set NAME).
Changes are written to config.json and take effect on the next start (restart the service); in a
running terminal chat, /provider swaps for the rest of that chat without touching the file.
`;

type Opts = { home?: string };

/** Parses the whole config again, so a bad edit is refused before anything is written. */
function save(home: string, next: GarnetConfig): GarnetConfig {
  const valid = parseConfig(JSON.parse(JSON.stringify(next)));
  writeConfig(home, valid);
  return valid;
}

export function describeProvider(m: ModelConfig): string {
  const where = m.provider === 'gemini' ? (m.baseUrl ?? GEMINI_BASE_URL) : m.baseUrl;
  return `${m.provider} · ${m.name}${where && m.provider !== 'anthropic' ? ` · ${where}` : ''}${m.provider === 'fake' ? '' : ` · key ${keyEnvOf(m)}`}`;
}

export function providers(args: string[], io: Io, opts: Opts = {}): number {
  const [sub = 'list', ...rest] = args;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    io.out(PROVIDERS_USAGE);
    return 0;
  }
  const loaded = loadConfig(opts.home);
  const { config, paths } = loaded;
  try {
    switch (sub) {
      case 'list': {
        for (const p of listProviders(config)) io.out(`${p.active ? '*' : ' '} ${p.name.padEnd(16)} ${describeProvider(p.model)}\n`);
        return 0;
      }
      case 'add': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: { provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' }, 'key-env': { type: 'string' }, use: { type: 'boolean' } },
        });
        const name = positionals[0];
        if (!name || positionals.length > 1) throw new GarnetError('invalid_input', 'Usage: garnet providers add <name> --provider <kind> --model <id> [--base-url <url>] [--key-env <NAME>] [--use]');
        const problem = providerNameProblem(config, name);
        if (problem) throw new GarnetError('invalid_input', `Provider name "${name}": ${problem}.`);
        const kind = values.provider as ModelConfig['provider'] | undefined;
        if (!kind || !(PROVIDER_KINDS as readonly string[]).includes(kind)) throw new GarnetError('invalid_input', `--provider must be one of ${PROVIDER_KINDS.join(', ')}.`);
        const model = values.model ?? (kind === 'gemini' ? DEFAULT_GEMINI_MODEL : undefined);
        if (!model && kind !== 'fake') throw new GarnetError('invalid_input', '--model <id> is required.');
        // A custom (openai-compatible) provider gets a key name of its own unless --key-env says otherwise.
        const keyEnv = values['key-env'] ?? (kind === 'openai-compatible' ? providerKeyEnv(config, name) : undefined);
        const entry = { provider: kind, ...(model ? { name: model } : {}), ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}), ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) } as ModelConfig;
        // parseConfig fills the defaults and reports problems (an openai-compatible provider needs a base URL).
        let next = withProvider(config, name, entry);
        if (values.use) next = { ...next, activeProvider: name };
        const saved = save(paths.home, next);
        const added = listProviders(saved).find((p) => p.name === name)!;
        io.out(`Added provider "${name}": ${describeProvider(added.model)}${values.use ? ' (now in use)' : ''}.\n`);
        if (!values['key-env'] && kind !== 'fake') io.out(`Its key is read from ${keyEnvOf(added.model)}; store it with \`garnet secrets set ${keyEnvOf(added.model)}\`.\n`);
        return 0;
      }
      case 'use': {
        const [name, model, extra] = rest;
        if (!name || extra) throw new GarnetError('invalid_input', 'Usage: garnet providers use <name> [<model>]');
        const saved = save(paths.home, withActiveProvider(config, name, model));
        const now = listProviders(saved).find((p) => p.active)!;
        io.out(`Now using "${now.name}": ${describeProvider(now.model)}. Restart the service (or start a new chat) for it to apply.\n`);
        return 0;
      }
      case 'rm': {
        const [name, extra] = rest;
        if (!name || extra) throw new GarnetError('invalid_input', 'Usage: garnet providers rm <name>');
        save(paths.home, withoutProvider(config, name));
        io.out(`Removed provider "${name}".\n`);
        return 0;
      }
      default:
        io.err(`Unknown providers command "${sub}".\n\n${PROVIDERS_USAGE}`);
        return 2;
    }
  } catch (e) {
    if (String((e as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS')) throw e;
    io.err(`${errorMessage(e)}\n`);
    return e instanceof GarnetError && e.category === 'invalid_input' ? 2 : 1;
  }
}
