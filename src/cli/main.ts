import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { defaultConfig, loadConfig, loadEnvFile, redact, rubyHome, writeConfig, configSchema } from '../config/index.ts';
import { errorMessage, isRubyError } from '../contracts/index.ts';
import { createRuby } from '../main.ts';
import { FakeModel } from '../models/index.ts';
import type { Approver } from '../policy/index.ts';
import type { RuntimeEvent } from '../runtime/index.ts';
import { sparkle } from './sparkle.ts';
import { Achievements } from '../achievements/index.ts';
import { api, dashboard, jobs, pair, service, start } from './admin.ts';
import { memory, skills } from './knowledge.ts';
import { backup, restore } from './backup.ts';
import { runImport } from '../migrate/index.ts';
import { unlockWarnings } from '../secrets/index.ts';
import { secrets } from './secrets.ts';

const HELP = `ruby — a persistent personal agent you can actually read

Usage:
  ruby init                 Create ~/.ruby with a default config
  ruby chat [--fake] [--session <id>]
                            Chat in the terminal (--fake uses an offline model)
  ruby config check         Validate the config file
  ruby config show          Print the effective config (secrets redacted)
  ruby config explain       Describe every setting
  ruby sessions             List recent sessions
  ruby start                Run the service (channels, gateway, API) in the foreground
  ruby pair list|approve <code>|revoke <channel> <id>
                            Manage who may talk to Ruby
  ruby api status|enable|disable
  ruby api key create --name <n> [--scopes chat,read,admin] [--expires-days N]
  ruby api key list|revoke <id>
                            Opt-in HTTP API and its keys
  ruby dashboard            Enable the dashboard and print a login link
  ruby jobs list|history <id>|run <id>|resume <id>
                            Scheduled jobs and heartbeats (defined in config.json)
  ruby memory show|edit|history|rollback
                            Inspect and correct what Ruby remembers
  ruby skills list|show|proposal|accept|reject|archive|stale
                            Review skills Ruby has learned
  ruby import <openclaw|hermes> [--from <dir>] [--apply]
                            Bring memory, persona and skills over (dry run unless --apply)
  ruby secrets list|set <NAME>|rm <NAME>|import-env [NAME...] [--keep]|keygen <path>
                            Encrypted secret store (values from stdin, never argv)
  ruby backup [dir]         Copy the database, config, memory, skills and workspace
  ruby restore <dir>        Restore a backup (stop Ruby first)
  ruby service install|uninstall|status|show
                            Run Ruby as a background service (systemd/launchd)
  ruby help                 Show this help

Environment:
  RUBY_HOME                 Data directory (default ~/.ruby)
  ANTHROPIC_API_KEY         Provider key (name configurable via model.apiKeyEnv)
  TELEGRAM_BOT_TOKEN        Telegram bot token (when channels.telegram.enabled)
  RUBY_SECRETS_KEY_FILE     Key file (mode 0600, outside RUBY_HOME) that unlocks the secret store
  RUBY_SECRETS_PASSPHRASE   Or a passphrase that unlocks it
  Secrets are looked up in the environment first, then in the encrypted store
  (<RUBY_HOME>/secrets). Service installs also read <RUBY_HOME>/env (KEY=value
  lines, mode 0600); \`ruby secrets import-env\` moves secrets from it into the store.
`;

export type Io = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads one secret value (tests). Defaults to hidden terminal input or piped stdin. */
  readSecret?: (prompt: string, io: Io) => Promise<string>;
};

const stdio: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
};

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const [command = 'help', ...rest] = argv;
  try {
    const { warning, loaded } = loadEnvFile(rubyHome());
    if (warning) io.err(`Warning: ${warning}\n`);
    for (const w of unlockWarnings(rubyHome(), process.env, loaded)) io.err(`Warning: ${w}\n`);
    switch (command) {
      case 'init':
        return init(io);
      case 'chat':
        return await chat(rest, io);
      case 'config':
        return configCommand(rest, io);
      case 'sessions':
        return sessions(io);
      case 'start':
        return await start(io);
      case 'pair':
        return pair(rest, io);
      case 'api':
        return api(rest, io);
      case 'service':
        return await service(rest, io);
      case 'memory':
        return memory(rest, io);
      case 'jobs':
        return await jobs(rest, io);
      case 'dashboard':
        return dashboard(io);
      case 'import': {
        const ruby = createRuby({ noModel: true });
        try {
          const { config, paths } = ruby;
          return runImport(rest, io, {
            memory: ruby.memory,
            skills: ruby.skills,
            workspace: paths.workspace,
            getPersona: () => config.persona,
            setPersona: (persona) => writeConfig(paths.home, { ...config, persona }),
          });
        } finally {
          ruby.close();
        }
      }
      case 'secrets':
        return await secrets(rest, io);
      case 'backup':
        return backup(rest, io);
      case 'restore':
        return restore(rest, io);
      case 'skills':
        return skills(rest, io);
      case '--sparkle': {
        io.out(sparkle());
        const ruby = createRuby({ noModel: true });
        new Achievements(ruby.db).unlockEasterEgg('sparkle');
        ruby.close();
        return 0;
      }
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      default:
        io.err(`Unknown command "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    io.err(`${isRubyError(e) ? '' : 'Unexpected error: '}${errorMessage(e)}\n`);
    return 1;
  }
}

function init(io: Io): number {
  const home = rubyHome();
  if (existsSync(`${home}/config.json`)) {
    io.out(`Ruby is already set up at ${home}. Edit ${home}/config.json or run \`ruby config check\`.\n`);
    return 0;
  }
  const config = defaultConfig();
  writeConfig(home, config);
  mkdirSync(`${home}/workspace`, { recursive: true });
  io.out(`Created ${home}/config.json and ${home}/workspace.\nSet ANTHROPIC_API_KEY, then run \`ruby chat\`.\n`);
  return 0;
}

function configCommand(args: string[], io: Io): number {
  const sub = args[0] ?? 'check';
  const { config, paths, migrated } = loadConfig();
  if (sub === 'check') {
    io.out(`Config OK (${existsSync(paths.configFile) ? paths.configFile : 'defaults; no config file yet'}).${migrated ? ' Migrated to the current version; a backup was kept.' : ''}\n`);
    return 0;
  }
  if (sub === 'show') {
    io.out(JSON.stringify(redact(config), null, 2) + '\n');
    return 0;
  }
  if (sub === 'explain') {
    io.out(explain(configSchema.toJSONSchema() as JsonSchema, '').join('\n') + '\n');
    return 0;
  }
  io.err(`Unknown config subcommand "${sub}". Use check, show or explain.\n`);
  return 2;
}

type JsonSchema = { description?: string; properties?: Record<string, JsonSchema>; default?: unknown; enum?: unknown[] };

function explain(schema: JsonSchema, prefix: string): string[] {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const extra = [
      child.enum ? `one of ${child.enum.join('|')}` : '',
      child.default !== undefined && typeof child.default !== 'object' ? `default ${JSON.stringify(child.default)}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`${path}${extra ? ` (${extra})` : ''}${child.description ? ` — ${child.description}` : ''}`);
    if (child.properties) lines.push(...explain(child, path));
  }
  return lines;
}

function sessions(io: Io): number {
  const ruby = createRuby({ noModel: true });
  try {
    const rows = ruby.store.listSessions(20);
    if (rows.length === 0) io.out('No sessions yet. Start one with `ruby chat`.\n');
    for (const s of rows) io.out(`${s.id}  ${s.updatedAt}  ${s.title ?? ''}\n`);
    return 0;
  } finally {
    ruby.close();
  }
}

async function chat(args: string[], io: Io): Promise<number> {
  const color = io === stdio && process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
  const rubyLabel = (text: string) => color ? `\x1b[1;38;2;255;102;128m${text}\x1b[0m` : text;
  const mutedLabel = (text: string) => color ? `\x1b[38;2;163;166;173m${text}\x1b[0m` : text;
  const { values } = parseArgs({ args, options: { fake: { type: 'boolean' }, session: { type: 'string' } } });
  const rl = createInterface({ input: process.stdin, terminal: false });
  // One line iterator shared by the prompt and approvals, so input typed or
  // piped while a task runs is buffered instead of lost.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | null> => {
    io.out(prompt);
    const next = await lines.next();
    return next.done ? null : String(next.value);
  };
  const ruby = createRuby({
    ...(values.fake ? { model: new FakeModel() } : {}),
    approver: terminalApprover(ask, io),
  });
  let current: AbortController | null = null;
  const onSigint = () => {
    if (current) {
      current.abort();
      io.err('\n[cancelling…]\n');
    } else {
      rl.close();
    }
  };
  process.on('SIGINT', onSigint);
  try {
    const session = values.session ? ruby.store.getSession(values.session) : ruby.store.createSession('Terminal chat');
    if (!session) {
      io.err(`No session "${values.session}". Run \`ruby sessions\` to list them.\n`);
      return 1;
    }
    if (color) io.out(`${rubyLabel('◆ RUBY')} ${mutedLabel('/ TERMINAL CHAT')}\n${mutedLabel('────────────────────────────────────────')}\n`);
    io.out(`Ruby (${ruby.model.id}) · session ${session.id}\nType a message. /exit to quit, Ctrl+C to cancel a running task.\n\n`);
    for (;;) {
      const raw = await ask(mutedLabel('you › '));
      if (raw === null) break; // input closed
      const line = raw.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      current = new AbortController();
      io.out(rubyLabel('ruby › '));
      const task = await ruby.agent.run(session.id, line, { signal: current.signal, onEvent: printer(io), source: 'cli' });
      current = null;
      const u = task.usage;
      const fmt = (n: number | null) => (n === null ? '?' : String(n));
      io.out(`\n\n  [${task.status}${task.reason ? `: ${task.reason}` : ''} · in ${fmt(u.inputTokens)} · cached ${fmt(u.cacheReadTokens)} · out ${fmt(u.outputTokens)} tokens]\n\n`);
    }
    return 0;
  } finally {
    process.off('SIGINT', onSigint);
    rl.close();
    ruby.close();
  }
}

function printer(io: Io): (e: RuntimeEvent) => void {
  return (e) => {
    if (e.type === 'text') io.out(e.text);
    else if (e.type === 'tool_start') io.out(`\n  ⚙ ${e.call.name} ${short(JSON.stringify(e.call.input))}\n`);
    else if (e.type === 'tool_end' && e.result.status === 'error') io.out(`  ✗ ${e.result.category}: ${short(e.result.content)}\n`);
    else if (e.type === 'retry') io.out(`\n  [retrying in ${Math.round(e.delayMs / 1000)}s: ${e.message}]\n`);
  };
}

function terminalApprover(ask: (prompt: string) => Promise<string | null>, io: Io): Approver {
  return async (req) => {
    io.out(`\n  ⚠ ${req.tool} wants ${req.capability} on ${req.targets.join(', ') || '(no target)'}\n`);
    const answer = ((await ask('  allow? [y/N] ')) ?? '').trim().toLowerCase();
    return answer === 'y' || answer === 'yes' ? 'approved' : 'denied';
  };
}

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
