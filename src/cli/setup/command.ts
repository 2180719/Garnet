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
import { chat } from '../chat/index.ts';
import { importDeps } from '../import.ts';
import type { Io } from '../main.ts';
import { themeFor } from '../chat/theme.ts';
import { TuiPrompter, wantsFullscreen } from '../tui/index.ts';
import { AnswerPrompter, TerminalPrompter, makeStyle, wantsColor, type Answer, type Prompter } from './prompt.ts';
import { runSetup, type SetupDeps } from './wizard.ts';

export const SETUP_USAGE = `Usage: garnet setup [options]

Interactive on a terminal. With --non-interactive (or -y), every answer comes
from the options below, the current config, or safe defaults; nothing optional
(live checks, the service, importing) happens unless you ask for it.

  --provider <p>            anthropic | gemini | openrouter | local | openai-compatible | fake
  --model <id>              Model ID
  --base-url <url>          API base URL (local and openai-compatible)
  --provider-name <slug>    Name for a local/openrouter/openai-compatible provider (default: the
                            current one; a new name is added to providers and made active)
  --key-env <NAME>          Variable or secret name that holds the model key
  --key-stdin               Read the model key from stdin (never pass it as an argument)
  --secrets <where>         encrypted (default) | env-file | env
  --key-file <path>         Key file for the encrypted store (created if missing)
  --name <name>             What the assistant is called (default Garnet)
  --owner <name>            What it calls you
  --notes <text>            One line about how you like answers
  --timezone <zone>         Your IANA time zone, e.g. Europe/London (empty keeps the host's)
  --channels <list>         Channels to connect, comma separated: telegram,discord,signal (none for none).
                            On a re-run the enabled ones are kept unless you leave them out.
  --telegram / --no-telegram, --telegram-token-env <NAME>   (adds or removes one channel)
  --discord / --no-discord, --discord-token-env <NAME>
  --signal / --no-signal, --signal-number <+E164>, --signal-url <url>
  --extras <more|defaults>  Run the tools and extras questions (default: more); defaults skips them
  --tools <list>            What Garnet may do, comma separated: web,files,memory,reminders,messages,commands
                            (none for nothing). Ticked ones keep their setting or start at ask; the rest are denied.
  --web-search <backend>    duckduckgo | brave | tavily | searxng | none (needs --tools web)
  --searxng-url <url>       SearXNG address (--web-search searxng)
  --connectors <list>       Connectors to turn on: calendar,github,weather (none for none)
  --github-repos <list>     Repositories the GitHub connector may use (owner/name or owner/*)
  --github-write / --no-github-write    Let the GitHub connector comment (each comment still asks)
  --weather-location <place>, --weather-units <metric|imperial>
  --skills <list>           Built-in skills to turn on: daily-briefing,github-triage,web-research (none for none)
  --voice <service>         none | openai | groq | other: speech to text for voice notes (a command backend in config is kept)
  --voice-url <url>, --voice-model <id>, --voice-key-env <NAME>   (--voice other)
  --daily-limit <usd>       Daily spending cap in US dollars (empty for none)
  --dashboard / --no-dashboard   Serve the web dashboard (turns on the API, loopback only)
  --sandbox <where>         docker | ssh | local: where commands run (default: keep the current one)
  --ssh-host <host>         ssh: remote host name or IP address
  --ssh-user <user>         ssh: remote account (use a dedicated, unprivileged one)
  --ssh-workdir <dir>       ssh: absolute directory on the remote host
  --ssh-auth <how>          ssh: agent | key
  --ssh-key <path>          ssh: absolute path of the private key file (--ssh-auth key)
  --ssh-passphrase-env <NAME>  ssh: name of the secret holding the key passphrase (store it with garnet secrets set)
  --ssh-host-keys <policy>  ssh: strict (default) | accept-new
  --check                   Check keys and connections with live requests
  --service                 Install (or restart) the background service
  --import                  Import from OpenClaw/Hermes when found (applies it)
  --import-raise-caps       Raise memory caps so all imported memory fits
  --import-pairings         Pair the senders on the old assistant's allowlists
  --import-persona <mode>   keep | merge | replace, when you already have a persona
  --reset                   Replace an invalid config.json (a backup is kept)
  --plain, --inline         Line-based questions instead of the fullscreen screens
  -y, --non-interactive     Do not prompt
`;

const FLAGS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  'base-url': { type: 'string' },
  'provider-name': { type: 'string' },
  'key-env': { type: 'string' },
  'key-stdin': { type: 'boolean' },
  secrets: { type: 'string' },
  'key-file': { type: 'string' },
  name: { type: 'string' },
  owner: { type: 'string' },
  notes: { type: 'string' },
  timezone: { type: 'string' },
  channels: { type: 'string' },
  extras: { type: 'string' },
  tools: { type: 'string' },
  'web-search': { type: 'string' },
  'searxng-url': { type: 'string' },
  connectors: { type: 'string' },
  'github-repos': { type: 'string' },
  'github-write': { type: 'boolean' },
  'weather-location': { type: 'string' },
  'weather-units': { type: 'string' },
  skills: { type: 'string' },
  voice: { type: 'string' },
  'voice-url': { type: 'string' },
  'voice-model': { type: 'string' },
  'voice-key-env': { type: 'string' },
  'daily-limit': { type: 'string' },
  dashboard: { type: 'boolean' },
  sandbox: { type: 'string' },
  'ssh-host': { type: 'string' },
  'ssh-user': { type: 'string' },
  'ssh-workdir': { type: 'string' },
  'ssh-auth': { type: 'string' },
  'ssh-key': { type: 'string' },
  'ssh-passphrase-env': { type: 'string' },
  'ssh-host-keys': { type: 'string' },
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
  plain: { type: 'boolean' },
  inline: { type: 'boolean' },
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
  // Fullscreen on a real terminal; --plain/--inline, a dumb TERM, pipes and tests get the line prompts.
  const fullscreen = !opts.prompter && !nonInteractive && wantsFullscreen({ stdin: process.stdin, stdout: process.stdout }, process.env, Boolean(values.plain || values.inline)) && (opts.tty ?? true);
  const tui = fullscreen ? new TuiPrompter({ input: process.stdin, output: process.stdout, theme: themeFor(process.env, true) }) : null;
  // While the alternate screen is up, nothing may write to the real terminal: the wizard's output is captured and replayed afterwards.
  const wio: Io = tui ? { ...io, out: tui.capture('out'), err: tui.capture('err') } : io;
  const deps = { ...defaultDeps(wio), ...opts.deps };
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
      prompter = tui ?? new TerminalPrompter({ style: deps.style });
    }
  }
  if (!tui) return runSetup(prompter, io, deps);
  try {
    return await runSetup(prompter, wio, deps);
  } finally {
    // Always leave the alternate screen first, then print what the wizard said (next steps, results) where it stays in the scrollback.
    for (const line of tui.close()) (line.stream === 'out' ? io.out : io.err)(line.text);
  }
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
    wake: ({ fake }) => chat(['--onboard', ...(fake ? ['--fake'] : [])], { ...io, stdin: process.stdin, stdout: process.stdout, env: process.env }),
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
    // A prompter passed in (tests) keeps asking; otherwise setup picks the fullscreen or line prompter itself.
    if (await p.confirm({ id: 'setup', message: 'Set up Garnet now? (model, key, persona, channels, tools)', default: true })) return setup(args.filter((a) => a === '--plain' || a === '--inline'), io, { ...opts, ...(opts.prompter ? { prompter: p } : {}) });
  }
  writeConfig(home, defaultConfig());
  mkdirSync(join(home, 'workspace'), { recursive: true });
  io.out(`Created ${home}/config.json and ${home}/workspace.\nNext: \`garnet setup\` walks you through the model, keys and channels (\`garnet setup -y --help\` for scripts).\n`);
  return 0;
}
