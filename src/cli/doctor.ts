// `ruby doctor`: diagnoses the install and the setup, offline, and says how to
// fix each problem. It never prints secret values and never changes anything.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { CONFIG_VERSION, parseConfig, parseEnv, rubyHome, type RubyConfig } from '../config/index.ts';
import { errorMessage } from '../contracts/index.ts';
import { createSandbox } from '../sandbox/index.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, isInside, openSecretStore, unlockWarnings } from '../secrets/index.ts';
import { defaultEntry, planService, serviceStatus, type CommandResult } from '../service/index.ts';
import type { Io } from './main.ts';
import { makeStyle, wantsColor, type Style } from './setup/prompt.ts';

export type Status = 'ok' | 'warn' | 'fail' | 'info';
export type Finding = { area: string; status: Status; message: string; fix?: string };

export type DoctorDeps = {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  userHome: string;
  /** This install's src/cli/bin.ts. */
  entry: string;
  version: string;
  run: (cmd: string[]) => Promise<CommandResult>;
  sqlite: () => { ok: boolean; detail: string };
  /** Docker sandbox readiness (only called when commands are allowed). */
  sandboxCheck: (config: RubyConfig, workspace: string) => Promise<{ ok: boolean; detail: string }>;
};

export const MIN_NODE = [22, 18] as const;

export function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

export async function diagnose(d: DoctorDeps): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (area: string, status: Status, message: string, fix?: string) => out.push({ area, status, message, ...(fix ? { fix } : {}) });
  const installDir = dirname(dirname(dirname(d.entry)));

  // Runtime
  if (nodeOk(d.nodeVersion)) add('node', 'ok', `Node.js ${d.nodeVersion}`);
  else add('node', 'fail', `Node.js ${d.nodeVersion} is too old; Ruby needs ${MIN_NODE.join('.')} or newer`, 'Install a current Node.js: https://nodejs.org (or `fnm install 22` / `nvm install 22`).');
  const sqlite = d.sqlite();
  add('sqlite', sqlite.ok ? 'ok' : 'fail', sqlite.detail, sqlite.ok ? undefined : 'Use the official Node.js build (22.18+), which includes node:sqlite with FTS5.');

  // Install and PATH
  add('install', 'info', `Ruby ${d.version} at ${installDir}`);
  out.push(pathFinding(d, installDir));

  // RUBY_HOME
  if (!existsSync(d.home)) {
    add('home', 'fail', `${d.home} does not exist yet`, 'Run `ruby setup`.');
    return out;
  }
  const mode = statSync(d.home).mode & 0o777;
  try {
    accessSync(d.home, constants.W_OK);
    add('home', mode & 0o077 ? 'warn' : 'ok', `${d.home}${mode & 0o077 ? ` is readable by other users (mode ${mode.toString(8)})` : ''}`, mode & 0o077 ? `chmod 700 ${d.home}` : undefined);
  } catch {
    add('home', 'fail', `${d.home} is not writable by you`, `Fix the owner: chown -R "$USER" ${d.home}`);
  }

  // Config
  const file = join(d.home, 'config.json');
  let config: RubyConfig | null = null;
  if (!existsSync(file)) {
    add('config', 'fail', `No config at ${file}`, 'Run `ruby setup`.');
  } else {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      config = parseConfig(raw);
      add('config', 'ok', `${file} is valid${raw.version !== CONFIG_VERSION ? ' (an older version; it is migrated, with a backup, the next time Ruby loads it)' : ''}`);
    } catch (e) {
      add('config', 'fail', `${file}: ${errorMessage(e)}`, 'Run `ruby setup` to fix it interactively, or edit the file (`ruby config explain` lists every setting).');
    }
  }

  // Env file and secret store
  const envFile = join(d.home, 'env');
  const fileVars = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : new Map<string, string>();
  if (existsSync(envFile) && statSync(envFile).mode & 0o077) add('env', 'fail', `${envFile} is readable by other users`, `chmod 600 ${envFile}`);
  for (const w of unlockWarnings(d.home, d.env, fileVars.has(PASSPHRASE_ENV) ? [PASSPHRASE_ENV] : [])) add('secrets', 'warn', w);
  const store = openSecretStore(d.home, d.env);
  let storeNames: Set<string> | null = null;
  let storeError: string | null = null;
  if (store.exists()) {
    try {
      storeNames = new Set(store.names());
      add('secrets', 'ok', `Encrypted store unlocked (${storeNames.size} secret${storeNames.size === 1 ? '' : 's'})`);
    } catch (e) {
      storeError = errorMessage(e);
      add('secrets', 'fail', `Encrypted store: ${storeError}`, `Set ${KEY_FILE_ENV} (a line in ${envFile} works) or ${PASSPHRASE_ENV}.`);
    }
  }
  const where = (name: string): string | null => {
    if (d.env[name]) return fileVars.get(name) === d.env[name] ? `${envFile}` : 'environment';
    if (storeNames?.has(name)) return 'encrypted store';
    return null;
  };
  const missingFix = (name: string) => (storeError ? `Unlock the store (see above), or set ${name}.` : `Run \`ruby setup\`, or \`ruby secrets set ${name}\`.`);

  if (config) {
    // Model and key
    const m = config.model;
    if (m.provider === 'fake') add('model', 'warn', 'Using the offline demo model; replies are scripted', 'Run `ruby setup` to pick a real model.');
    else {
      const loc = where(m.apiKeyEnv);
      if (m.provider === 'anthropic') {
        if (loc) add('model', 'ok', `anthropic · ${m.name} · key ${m.apiKeyEnv} (${loc})`);
        else add('model', 'fail', `anthropic · ${m.name} · ${m.apiKeyEnv} is not set`, missingFix(m.apiKeyEnv));
      } else {
        const host = m.baseUrl ? new URL(m.baseUrl).hostname : '';
        const local = LOOPBACK.includes(host);
        if (loc && m.apiKeyEnv === 'ANTHROPIC_API_KEY' && !host.endsWith('anthropic.com')) {
          add('model', 'warn', `openai-compatible · ${m.name} · would send ANTHROPIC_API_KEY to ${host}`, 'Set model.apiKeyEnv to the key for this server (`ruby setup`).');
        } else if (loc || local) {
          add('model', 'ok', `openai-compatible · ${m.name} at ${m.baseUrl}${loc ? ` · key ${m.apiKeyEnv} (${loc})` : ' · no key'}`);
        } else {
          add('model', 'warn', `openai-compatible · ${m.name} at ${m.baseUrl} · no key (${m.apiKeyEnv} is not set)`, missingFix(m.apiKeyEnv));
        }
      }
    }

    // Workspace and API exposure
    const workspace = resolve(d.home, config.workspace ?? 'workspace');
    if (isInside(workspace, d.home)) {
      add('workspace', 'fail', `${workspace} contains Ruby's home, so file tools could change config.json and secrets; Ruby refuses to start`, 'Point "workspace" in config.json at a directory of its own (or remove it for the default).');
    }
    if (config.api.enabled && !LOOPBACK.includes(config.api.host)) {
      add('api', 'warn', `The API listens on ${config.api.host}:${config.api.port}, reachable from other machines (it needs a key, and has no TLS)`, 'Bind to 127.0.0.1 and use Tailscale or a reverse proxy with TLS.');
    }

    // Channels
    const ch = config.channels;
    const enabled = (['telegram', 'discord', 'signal'] as const).filter((n) => ch[n].enabled);
    if (!enabled.length) add('channels', 'info', 'No messaging channels enabled', 'Run `ruby setup` to add Telegram, Discord or Signal.');
    for (const n of ['telegram', 'discord'] as const) {
      if (!ch[n].enabled) continue;
      const loc = where(ch[n].tokenEnv);
      if (loc) add('channels', 'ok', `${n} · token ${ch[n].tokenEnv} (${loc})`);
      else add('channels', 'fail', `${n} is enabled but ${ch[n].tokenEnv} is not set`, missingFix(ch[n].tokenEnv));
    }
    if (ch.signal.enabled) add('channels', 'ok', `signal · ${ch.signal.account} via ${ch.signal.baseUrl} (keep signal-cli daemon running)`);

    // Web
    const web = config.web.search;
    if (config.permissions['net.fetch'] === 'deny') add('web', 'info', 'Web access is off (permissions.net.fetch = deny): no web_fetch or web_search');
    else if (web.backend === 'brave' || web.backend === 'tavily') {
      const keyName = web.apiKeyEnv ?? (web.backend === 'brave' ? 'BRAVE_API_KEY' : 'TAVILY_API_KEY');
      const loc = where(keyName);
      if (loc) add('web', 'ok', `web_search · ${web.backend} · key ${keyName} (${loc})`);
      else add('web', 'fail', `web.search.backend is ${web.backend} but ${keyName} is not set`, missingFix(keyName));
    } else if (web.backend === 'none') add('web', 'info', 'web_fetch only (web.search.backend = none)');
    else add('web', 'ok', `web_search · ${web.backend}${web.backend === 'searxng' ? ` at ${web.searxngUrl}` : ' (keyless, unofficial; may be rate limited)'}`);
    if (config.permissions['net.fetch'] !== 'deny' && !config.containment.enabled) {
      add('web', 'warn', 'Untrusted-content containment is off: a web page could steer Ruby into actions you set to allow', 'Set containment.enabled = true in config.json.');
    }

    // Sandbox
    if (config.permissions.exec === 'deny') add('sandbox', 'info', 'Shell commands are off (permissions.exec = deny), so no sandbox is needed');
    else if (config.sandbox.backend === 'local') add('sandbox', 'warn', 'Commands run on the host (sandbox.backend = local), which is not a security boundary', 'Use sandbox.backend = docker.');
    else {
      const r = await d.sandboxCheck(config, workspace).catch((e: unknown) => ({ ok: false, detail: errorMessage(e) }));
      // The sandbox's own detail already says how to fix it.
      add('sandbox', r.ok ? 'ok' : 'fail', `Docker sandbox: ${r.detail}`);
    }
  }

  // Service
  const plan = planService({ platform: d.platform, home: d.home, userHome: d.userHome, nodePath: process.execPath, entry: d.entry });
  if ('unsupported' in plan) add('service', 'info', plan.unsupported);
  else if (!existsSync(plan.path)) add('service', 'info', 'Background service not installed', 'Run `ruby service install` (or `ruby setup`) to keep Ruby running.');
  else {
    const status = await serviceStatus(plan, { run: d.run });
    const stale = readFileSync(plan.path, 'utf8') !== plan.contents;
    if (status.ok) add('service', stale ? 'warn' : 'ok', `Service running (${plan.path})${stale ? ', but its file is out of date (Ruby or Node moved?)' : ''}`, stale ? 'Run `ruby service install` to rewrite it.' : undefined);
    else add('service', 'warn', `Service installed but not running (${plan.path})`, plan.platform === 'systemd' ? 'See `journalctl --user -u ruby -e`, then `systemctl --user restart ruby`.' : `See ${join(d.home, 'logs')}, then \`ruby service install\`.`);
  }
  return out;
}

function pathFinding(d: DoctorDeps, installDir: string): Finding {
  // install.sh --name <other> sets RUBY_COMMAND_NAME in its shim.
  const name = /^[A-Za-z0-9._-]+$/.test(d.env.RUBY_COMMAND_NAME ?? '') ? d.env.RUBY_COMMAND_NAME! : 'ruby';
  const dirs = (d.env.PATH ?? '').split(delimiter).filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) found.push(p);
    } catch {
      // not here
    }
  }
  const ours = (p: string) => {
    try {
      if (realpathSync(p).startsWith(installDir)) return true;
      return readFileSync(p, 'utf8').slice(0, 4096).includes(installDir);
    } catch {
      return false;
    }
  };
  const first = found[0];
  if (!first) return { area: 'path', status: 'warn', message: `\`${name}\` is not on your PATH`, fix: `Run install.sh, or \`npm link\` in ${installDir}; until then use \`npm run ruby --\`.` };
  if (ours(first)) return { area: 'path', status: 'ok', message: `\`${name}\` on PATH is this install (${first})` };
  const later = found.slice(1).find(ours);
  return {
    area: 'path',
    status: 'warn',
    message: `\`${name}\` on your PATH is ${first}, not this install${later ? ` (which is at ${later}, later in PATH)` : ''}; it may be the Ruby programming language`,
    fix: later ? `Put ${dirname(later)} earlier in PATH.` : 'Reinstall with `install.sh --name <other-name>`, or use `npm run ruby --`.',
  };
}

const SYMBOL: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };

export function formatFindings(findings: Finding[], s: Style): string {
  const color: Record<Status, (t: string) => string> = { ok: s.ok, warn: s.warn, fail: s.bad, info: s.muted };
  const lines = findings.map((f) => `  ${color[f.status](SYMBOL[f.status])} ${s.muted(f.area.padEnd(9))} ${f.message}${f.fix ? `\n      ${s.muted('→')} ${f.fix}` : ''}`);
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;
  const verdict = fails
    ? s.bad(`${fails} problem${fails === 1 ? '' : 's'}${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`)
    : warns
      ? s.warn(`No problems; ${warns} warning${warns === 1 ? '' : 's'}.`)
      : s.ok('Everything looks good.');
  return `${s.accent('◆ RUBY')} ${s.muted('/ DOCTOR')}\n${lines.join('\n')}\n\n${verdict}\n`;
}

export function realSqliteCheck(): { ok: boolean; detail: string } {
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    db.close();
    return { ok: true, detail: 'node:sqlite with FTS5' };
  } catch (e) {
    return { ok: false, detail: `node:sqlite is not usable: ${errorMessage(e)}` };
  }
}

export async function doctor(args: string[], io: Io, overrides: Partial<DoctorDeps> & { version?: string } = {}): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const run = (cmd: string[]): Promise<CommandResult> =>
    new Promise((res) => {
      const [file, ...rest] = cmd;
      if (!file) return res({ code: 1, stdout: '', stderr: 'empty command' });
      execFile(file, rest, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) =>
        res({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      );
    });
  const deps: DoctorDeps = {
    home: rubyHome(),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    userHome: homedir(),
    entry: defaultEntry(),
    version: overrides.version ?? 'unknown',
    run,
    sqlite: realSqliteCheck,
    sandboxCheck: async (config, workspace) => {
      const sb = config.sandbox;
      const sandbox = createSandbox(sb.backend, { workspace, image: sb.image, network: sb.network, memory: sb.memory, cpus: sb.cpus, pidsLimit: sb.pidsLimit, ...(sb.user ? { user: sb.user } : {}) });
      return sandbox.check();
    },
    ...overrides,
  };
  const findings = await diagnose(deps);
  if (values.json) io.out(JSON.stringify(findings, null, 2) + '\n');
  else io.out(formatFindings(findings, makeStyle(wantsColor(process.stdout))));
  return findings.some((f) => f.status === 'fail') ? 1 : 0;
}
