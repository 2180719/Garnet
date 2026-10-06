import { existsSync } from 'node:fs';
import { loadConfig, loadEnvFile, redact, garnetHome, writeConfig, configSchema, changeConfig, getConfigValue, parseConfigValue, showConfigValue } from '../config/index.ts';
import { errorMessage, isGarnetError } from '../contracts/index.ts';
import { createGarnet, VERSION } from '../main.ts';
import { sparkle } from './sparkle.ts';
import { Achievements } from '../achievements/index.ts';
import { api, dashboard, jobs, pair, service, start } from './admin.ts';
import { memory, skills } from './knowledge.ts';
import { extensionsCommand } from './extensions.ts';
import { backup, restore } from './backup.ts';
import { runImport } from '../migrate/index.ts';
import { importDeps } from './import.ts';
import { unlockWarnings } from '../secrets/index.ts';
import { secrets } from './secrets.ts';
import { doctor } from './doctor.ts';
import { init, setup } from './setup/command.ts';
import { chat } from './chat/index.ts';
import { sandboxCommand } from './sandbox.ts';

const HELP = `garnet — a persistent personal agent you can actually read

Usage:
  garnet setup                Guided setup: model, key, persona, channels, service
                            (re-run any time; \`garnet setup --help\` for script flags)
  garnet doctor [--json]      Check the install and setup, with fixes
  garnet init [--defaults]    Create ~/.garnet (offers \`garnet setup\` on a terminal)
  garnet chat [--fake] [--session <id>] [--plain] [--onboard]
                            Chat in the terminal (--fake uses an offline model;
                            /help inside lists commands and keys)
  garnet wake [--fake]        Wake-up chat: Garnet introduces itself and sets up its name and
                            your preferences by talking (same as chat --onboard)
  garnet config check         Validate the config file
  garnet config show          Print the effective config (secrets redacted)
  garnet config explain       Describe every setting
  garnet config get <path>    Print one setting (for example model.name)
  garnet config set <path> <value>
                            Change one setting, validated, saved atomically
                            (values are JSON when they parse: true, 42, ["a"])
  garnet config unset <path>  Reset a setting to its default
  garnet sandbox check        Probe the command sandbox (docker or ssh), read-only
  garnet sessions             List recent sessions
  garnet start                Run the service (channels, gateway, API) in the foreground
  garnet pair list|approve <code>|revoke <channel> <id>
  garnet pair add <telegram|discord|signal> <id> [--name <name>]
                            Manage who may talk to Garnet (add: without a code)
  garnet api status|enable|disable
  garnet api key create --name <n> [--scopes chat,read,admin] [--expires-days N]
  garnet api key list|revoke <id>
                            Opt-in HTTP API and its keys
  garnet dashboard            Enable the dashboard and print a login link
  garnet jobs list|show|history|run|pause|resume|delete|edit|add
                            Scheduled jobs, reminders and script jobs (config.json,
                            created in chat, or added here; \`garnet jobs help\`)
  garnet memory show|edit|history|rollback
                            Inspect and correct what Garnet remembers
  garnet skills list|show|proposal|accept|reject|archive|stale
                            Review skills Garnet has learned
  garnet skills builtin|enable|disable|reset|effective <name> [--channel <scope>]
  garnet connectors list|enable|disable|reset|effective <name> [--channel <scope>]
                            Optional built-in skills and connectors (all off by
                            default), globally or per channel, chat or route
  garnet import <openclaw|hermes> [--from <dir>] [--apply] [--raise-caps] [--pairings]
              [--persona keep|merge|replace] [--no-jobs]
                            Bring memory, persona, skills, jobs (disabled) and
                            allowlists over (dry run unless --apply)
  garnet secrets list|set <NAME>|rm <NAME>|import-env [NAME...] [--keep]|keygen <path>
                            Encrypted secret store (values from stdin, never argv)
  garnet backup [dir]         Copy the database, config, memory, skills, artifacts
                            and workspace
  garnet restore <dir>        Restore a backup (stop Garnet first)
  garnet service install|uninstall|status|restart|show|list [--name <name>]
                            Run Garnet as a background service (systemd/launchd);
                            --name lets several GARNET_HOMEs run side by side
  garnet help                 Show this help

Environment:
  GARNET_HOME                 Data directory (default ~/.garnet)
  ANTHROPIC_API_KEY         Provider key (name configurable via model.apiKeyEnv)
  TELEGRAM_BOT_TOKEN        Telegram bot token (when channels.telegram.enabled)
  GARNET_SECRETS_KEY_FILE     Key file (mode 0600, outside GARNET_HOME) that unlocks the secret store
  GARNET_SECRETS_PASSPHRASE   Or a passphrase that unlocks it
  Secrets are looked up in the environment first, then in the encrypted store
  (<GARNET_HOME>/secrets). Service installs also read <GARNET_HOME>/env (KEY=value
  lines, mode 0600); \`garnet secrets import-env\` moves secrets from it into the store.
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
    const { warning, loaded } = loadEnvFile(garnetHome());
    if (warning) io.err(`Warning: ${warning}\n`);
    for (const w of unlockWarnings(garnetHome(), process.env, loaded)) io.err(`Warning: ${w}\n`);
    switch (command) {
      case 'init':
        return await init(rest, io);
      case 'setup':
        return await setup(rest, io);
      case 'doctor':
        return await doctor(rest, io, { version: VERSION });
      case 'wake':
        // First-run wake-up: the agent introduces itself and asks to set up its name and your preferences.
        return await chat(['--onboard', ...rest], { ...io, stdin: process.stdin, stdout: io === stdio ? process.stdout : null, env: process.env });
      case 'chat':
        // The full terminal UI only when writing to the real terminal; otherwise plain lines through io.
        return await chat(rest, { ...io, stdin: process.stdin, stdout: io === stdio ? process.stdout : null, env: process.env });
      case 'config':
        return configCommand(rest, io);
      case 'sandbox':
        return await sandboxCommand(rest, io);
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
        const garnet = createGarnet({ noModel: true });
        try {
          let config = garnet.config;
          const save = (c: typeof config) => {
            config = c;
            writeConfig(garnet.paths.home, c);
          };
          return await runImport(
            rest,
            io,
            importDeps(garnet, { getConfig: () => config, setConfig: save, getPersona: () => config.persona, setPersona: (persona) => save({ ...config, persona }) }),
          );
        } finally {
          garnet.close();
        }
      }
      case 'secrets':
        return await secrets(rest, io);
      case 'backup':
        return backup(rest, io);
      case 'restore':
        return restore(rest, io);
      case 'skills':
        return await skills(rest, io);
      case 'connectors':
        return await extensionsCommand('connectors', rest, io);
      case '--sparkle': {
        io.out(sparkle());
        const garnet = createGarnet({ noModel: true });
        new Achievements(garnet.db).unlockEasterEgg('sparkle');
        garnet.close();
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
      io.err(`${errorMessage(e)}\nRun \`garnet help\` for usage.\n`);
      return 2;
    }
    io.err(`${isGarnetError(e) ? '' : 'Unexpected error: '}${errorMessage(e)}\n`);
    return 1;
  }
}

function configCommand(args: string[], io: Io): number {
  const sub = args[0] ?? 'check';
  const home = garnetHome();
  const { config, paths, migrated } = loadConfig(home);
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
  if (sub === 'get') {
    const path = args[1];
    if (!path || args.length > 2) {
      io.err('Usage: garnet config get <path>\n');
      return 2;
    }
    const value = getConfigValue(config, path);
    if (value === undefined) {
      io.err(`${path} is not set (or is not a setting). \`garnet config explain\` lists every setting.\n`);
      return 1;
    }
    const leaf = path.split('.').pop()!;
    io.out(JSON.stringify((redact({ [leaf]: value }) as Record<string, unknown>)[leaf], null, 2) + '\n');
    return 0;
  }
  if (sub === 'set' || sub === 'unset') {
    const path = args[1];
    const text = args[2];
    if (!path || (sub === 'set' ? text === undefined || args.length > 3 : args.length > 2)) {
      io.err(sub === 'set' ? 'Usage: garnet config set <path> <value>   (JSON values such as true, 42, ["a"] are understood; anything else is text)\n' : 'Usage: garnet config unset <path>\n');
      return 2;
    }
    let change;
    if (sub === 'unset') change = changeConfig(config, path, undefined, true);
    else {
      const parsed = parseConfigValue(text!);
      try {
        change = changeConfig(config, path, parsed);
      } catch (e) {
        // `config set persona.name 123` means the text "123" when a number is not accepted.
        if (typeof parsed === 'string') throw e;
        try {
          change = changeConfig(config, path, text!);
        } catch {
          throw e;
        }
      }
    }
    if (JSON.stringify(change.after) === JSON.stringify(change.before)) {
      io.out(`${path} is already ${showConfigValue(path, change.after)}; nothing changed.\n`);
      return 0;
    }
    writeConfig(home, change.config);
    io.out(`${path}: ${showConfigValue(path, change.before)} -> ${showConfigValue(path, change.after)}\nSaved to ${paths.configFile}. Restart Garnet (\`garnet service restart\`) for it to take effect.\n`);
    return 0;
  }
  io.err(`Unknown config subcommand "${sub}". Use check, show, explain, get, set or unset.\n`);
  return 2;
}

type JsonSchema = { description?: string; properties?: Record<string, JsonSchema>; additionalProperties?: JsonSchema | boolean; default?: unknown; enum?: unknown[]; items?: JsonSchema };

function explain(schema: JsonSchema, prefix: string): string[] {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const options = child.enum ?? child.items?.enum;
    const extra = [
      options ? `${child.items?.enum ? 'each ' : ''}one of ${options.join('|')}` : '',
      child.default !== undefined && typeof child.default !== 'object' ? `default ${JSON.stringify(child.default)}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`${path}${extra ? ` (${extra})` : ''}${child.description ? ` — ${child.description}` : ''}`);
    if (child.properties) lines.push(...explain(child, path));
    // A map keyed by name (e.g. skills.channels.<scope>): describe its entries once.
    if (typeof child.additionalProperties === 'object' && child.additionalProperties.properties) lines.push(...explain(child.additionalProperties, `${path}.<key>`));
  }
  return lines;
}

function sessions(io: Io): number {
  const garnet = createGarnet({ noModel: true });
  try {
    const rows = garnet.store.listSessions(20);
    if (rows.length === 0) io.out('No sessions yet. Start one with `garnet chat`.\n');
    for (const s of rows) io.out(`${s.id}  ${s.updatedAt}  ${s.title ?? ''}\n`);
    return 0;
  } finally {
    garnet.close();
  }
}
