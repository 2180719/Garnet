// `garnet setup`: parses flags, builds the prompter and the real dependencies.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultConfig, garnetHome, writeConfig } from '../../config/index.ts';
import { GarnetError } from '../../contracts/index.ts';
import { approvePairing } from '../../gateway/index.ts';
import { createGarnet } from '../../main.ts';
import { defaultSourceDir, runImport } from '../../migrate/index.ts';
import { defaultEntry, installService, resolveService, restartService } from '../../service/index.ts';
import { importDeps } from '../import.ts';
import type { Io } from '../main.ts';
import { AnswerPrompter, TerminalPrompter, makeStyle, wantsColor, type Answer, type Prompter } from './prompt.ts';
import { runSetup, type SetupDeps } from './wizard.ts';

export const SETUP_USAGE = `Usage: garnet setup [options]

Interactive on a terminal. With --non-interactive (or -y), every answer comes
from the options below, the current config, or safe defaults; nothing optional
(live checks, the service, importing) happens unless you ask for it.

  --provider <p>            anthropic | openrouter | local | openai-compatible | fake
  --model <id>              Model ID
  --base-url <url>          API base URL (local and openai-compatible)
  --key-env <NAME>          Variable or secret name that holds the model key
  --key-stdin               Read the model key from stdin (never pass it as an argument)
  --secrets <where>         encrypted (default) | env-file | env
  --key-file <path>         Key file for the encrypted store (created if missing)
  --name <name>             What the assistant is called (default Garnet)
  --owner <name>            What it calls you
  --notes <text>            One line about how you like answers
  --telegram / --no-telegram, --telegram-token-env <NAME>
  --discord / --no-discord, --discord-token-env <NAME>
  --signal / --no-signal, --signal-number <+E164>, --signal-url <url>
  --check                   Check keys and connections with live requests
  --service                 Install (or restart) the background service
  --import                  Import from OpenClaw/Hermes when found (applies it)
  --import-raise-caps       Raise memory caps so all imported memory fits
  --import-pairings         Pair the senders on the old assistant's allowlists
  --import-persona <mode>   keep | merge | replace, when you already have a persona
  --reset                   Replace an invalid config.json (a backup is kept)
  -y, --non-interactive     Do not prompt
`;

const FLAGS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  'base-url': { type: 'string' },
  'key-env': { type: 'string' },
  'key-stdin': { type: 'boolean' },
  secrets: { type: 'string' },
  'key-file': { type: 'string' },
  name: { type: 'string' },
  owner: { type: 'string' },
  notes: { type: 'string' },
  telegram: { type: 'boolean' },
  'telegram-token-env': { type: 'string' },
  discord: { type: 'boolean' },
  'discord-token-env': { type: 'string' },
  signal: { type: 'boolean' },
  'signal-number': { type: 'string' },
  'signal-url': { type: 'string' },
  check: { type: 'boolean' },
  service: { type: 'boolean' },
  import: { type: 'boolean' },
  'import-raise-caps': { type: 'boolean' },
  'import-pairings': { type: 'boolean' },
  'import-persona': { type: 'string' },
  reset: { type: 'boolean' },
  'non-interactive': { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type SetupCommandDeps = {
  /** Overrides for the wizard's dependencies (tests). */
  deps?: Partial<SetupDeps>;
  /** A ready-made prompter (tests). */
  prompter?: Prompter;
  /** Whether stdin and stdout are a terminal. */
  tty?: boolean;
  readStdin?: () => Promise<string>;
};

export async function setup(args: string[], io: Io, opts: SetupCommandDeps = {}): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args, options: FLAGS, allowNegative: true, strict: true }).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${SETUP_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(SETUP_USAGE);
    return 0;
  }
  const tty = opts.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const nonInteractive = Boolean(values['non-interactive']);
  if (!nonInteractive && !tty && !opts.prompter) {
    io.err('`garnet setup` asks questions, but this is not a terminal. Re-run with --non-interactive (-y) and options; see `garnet setup --help`.\n');
    return 2;
  }
  if (values['key-stdin'] && values.secrets === 'env') {
    io.err('--key-stdin needs somewhere to store the key: --secrets encrypted or env-file.\n');
    return 2;
  }
  if (values['key-stdin'] && !nonInteractive) {
    io.err('--key-stdin only works with --non-interactive.\n');
    return 2;
  }
  const deps = { ...defaultDeps(io), ...opts.deps };
  let prompter = opts.prompter;
  if (!prompter) {
    if (nonInteractive) {
      const answers: Record<string, Answer> = {};
      for (const [k, v] of Object.entries(values)) if (v !== undefined && k !== 'non-interactive' && k !== 'key-stdin') answers[k] = v;
      const secrets: Record<string, string> = {};
      if (values['key-stdin']) {
        const key = (await (opts.readStdin ?? readAll)()).trim();
        if (!key) throw new GarnetError('invalid_input', '--key-stdin was given but stdin was empty.');
        secrets.key = key;
        // A key passed in means "use this one", not "keep what is there".
        answers['keep-key'] = false;
      }
      prompter = new AnswerPrompter(answers, { secrets });
    } else {
      prompter = new TerminalPrompter({ style: deps.style });
    }
  }
  return runSetup(prompter, io, deps);
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function defaultDeps(io: Io): SetupDeps {
  const home = garnetHome();
  const userHome = homedir();
  // The instance already installed for this GARNET_HOME (garnet service install --name), else the default.
  const resolved = resolveService({ platform: process.platform, home, userHome, nodePath: process.execPath, entry: defaultEntry() });
  const plan = 'unsupported' in resolved ? resolved : resolved.plan;
  const conflict = 'unsupported' in resolved ? null : resolved.conflict;
  // Never take over another instance's service; say how to give this one its own.
  if (conflict) io.err(`Note: setup will not install the background service. ${conflict}\n`);
  const service: SetupDeps['service'] =
    'unsupported' in plan || conflict
      ? null
      : {
          label: plan.platform === 'systemd' ? 'systemd user service' : 'launchd agent',
          installed: () => existsSync(plan.path),
          install: () => installService(plan),
          restart: () => restartService(plan),
        };
  return {
    home,
    env: process.env,
    style: makeStyle(wantsColor(process.stdout)),
    defaultKeyFile: join(process.env.XDG_CONFIG_HOME || join(userHome, '.config'), 'garnet', 'secrets.key'),
    service,
    importSources: () =>
      (['openclaw', 'hermes'] as const).map((source) => ({ source, dir: defaultSourceDir(source) })).filter((s) => existsSync(s.dir)),
    runImport: async (args, draft) => {
      const garnet = createGarnet({ noModel: true, home });
      try {
        return await runImport(args, io, importDeps(garnet, { getConfig: draft.config, setConfig: draft.setConfig, getPersona: draft.get, setPersona: draft.set, ask: draft.ask }));
      } finally {
        garnet.close();
      }
    },
    pairing: () => {
      const garnet = createGarnet({ noModel: true, home });
      return {
        pending: () => garnet.gatewayStore.pairings(new Date().toISOString()),
        approve: (code) => approvePairing(garnet.gatewayStore, code),
        close: () => garnet.close(),
      };
    },
  };
}

/**
 * `garnet init`: on a terminal, offers the setup wizard; otherwise (or when
 * declined) writes the default config as before.
 */
export async function init(args: string[], io: Io, opts: SetupCommandDeps = {}): Promise<number> {
  const home = garnetHome();
  const configured = existsSync(join(home, 'config.json'));
  const tty = opts.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (configured) {
    io.out(`Garnet is already set up at ${home}. Run \`garnet setup\` to change it, or \`garnet doctor\` to check it.\n`);
    return 0;
  }
  if (tty && !args.includes('--defaults')) {
    const style = makeStyle(wantsColor(process.stdout));
    const p = opts.prompter ?? new TerminalPrompter({ style });
    if (await p.confirm({ id: 'setup', message: 'Set up Garnet now? (model, key, persona, channels)', default: true })) return setup([], io, { ...opts, prompter: p });
  }
  writeConfig(home, defaultConfig());
  mkdirSync(join(home, 'workspace'), { recursive: true });
  io.out(`Created ${home}/config.json and ${home}/workspace.\nNext: \`garnet setup\` walks you through the model, keys and channels (\`garnet setup -y --help\` for scripts).\n`);
  return 0;
}
