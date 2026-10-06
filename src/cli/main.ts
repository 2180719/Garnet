import { existsSync } from 'node:fs';
import { loadConfig, loadEnvFile, redact, rubyHome, writeConfig, configSchema } from '../config/index.ts';
import { errorMessage, isRubyError } from '../contracts/index.ts';
import { createRuby, VERSION } from '../main.ts';
import { sparkle } from './sparkle.ts';
import { Achievements } from '../achievements/index.ts';
import { api, dashboard, jobs, pair, service, start } from './admin.ts';
import { memory, skills } from './knowledge.ts';
import { backup, restore } from './backup.ts';
import { runImport } from '../migrate/index.ts';
import { importDeps } from './import.ts';
import { unlockWarnings } from '../secrets/index.ts';
import { secrets } from './secrets.ts';
import { doctor } from './doctor.ts';
import { init, setup } from './setup/command.ts';
import { chat } from './chat/index.ts';

const HELP = `ruby — a persistent personal agent you can actually read

Usage:
  ruby setup                Guided setup: model, key, persona, channels, service
                            (re-run any time; \`ruby setup --help\` for script flags)
  ruby doctor [--json]      Check the install and setup, with fixes
  ruby init [--defaults]    Create ~/.ruby (offers \`ruby setup\` on a terminal)
  ruby chat [--fake] [--session <id>] [--plain]
                            Chat in the terminal (--fake uses an offline model;
                            /help inside lists commands and keys)
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
  ruby backup [dir]         Copy the database, config, memory, skills, artifacts
                            and workspace
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
        return await init(rest, io);
      case 'setup':
        return await setup(rest, io);
      case 'doctor':
        return await doctor(rest, io, { version: VERSION });
      case 'chat':
        // The full terminal UI only when writing to the real terminal; otherwise plain lines through io.
        return await chat(rest, { ...io, stdin: process.stdin, stdout: io === stdio ? process.stdout : null, env: process.env });
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
          let config = ruby.config;
          const save = (c: typeof config) => {
            config = c;
            writeConfig(ruby.paths.home, c);
          };
          return await runImport(
            rest,
            io,
            importDeps(ruby, { getConfig: () => config, setConfig: save, getPersona: () => config.persona, setPersona: (persona) => save({ ...config, persona }) }),
          );
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
    // node:util parseArgs rejects unknown or malformed flags: that is a usage error, not a crash.
    if (String((e as NodeJS.ErrnoException).code).startsWith('ERR_PARSE_ARGS')) {
      io.err(`${errorMessage(e)}\nRun \`ruby help\` for usage.\n`);
      return 2;
    }
    io.err(`${isRubyError(e) ? '' : 'Unexpected error: '}${errorMessage(e)}\n`);
    return 1;
  }
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
