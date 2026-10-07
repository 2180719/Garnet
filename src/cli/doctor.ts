// `garnet doctor`: diagnoses the install and the setup, offline, and says how to
// fix each problem. It never prints secret values and never changes anything.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { CONFIG_VERSION, enabledAnywhere, parseConfig, parseEnv, garnetHome, envVar, deprecatedEnvVars, secretNames, unknownGarnetEnv, type ConnectorName, type GarnetConfig } from '../config/index.ts';
import { CONNECTOR_INFO } from '../connectors/index.ts';
import { errorMessage } from '../contracts/index.ts';
import { createSandbox } from '../sandbox/index.ts';
import { sandboxOptions } from '../main.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, isInside, openSecretStore, unlockWarnings, type SecretLookup } from '../secrets/index.ts';
import { defaultEntry, installedServices, legacyServices, resolveService, serviceStatus, type CommandResult } from '../service/index.ts';
import type { Io } from './main.ts';
import { makeStyle, wantsColor, type Style } from './setup/prompt.ts';

const isPathLike = (program: string): boolean => isAbsolute(program) || program.includes('/');

/** Whether `program` can be run: a path (absolute or containing '/') is checked directly, a bare name is searched for on PATH. */
export function programRunnable(program: string, pathEnv: string | undefined): boolean {
  const can = (file: string): boolean => {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isPathLike(program)) return can(program);
  return (pathEnv ?? '').split(delimiter).filter(Boolean).some((dir) => can(join(dir, program)));
}

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
  /**
   * Sandbox readiness (only called when commands are allowed and the backend is configured). Read-only; `secret`
   * resolves a secret name for the backend (an ssh key passphrase) and is never printed.
   */
  sandboxCheck: (config: GarnetConfig, workspace: string, secret: SecretLookup) => Promise<{ ok: boolean; detail: string }>;
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
  else add('node', 'fail', `Node.js ${d.nodeVersion} is too old; Garnet needs ${MIN_NODE.join('.')} or newer`, 'Install a current Node.js: https://nodejs.org (or `fnm install 22` / `nvm install 22`).');
  const sqlite = d.sqlite();
  add('sqlite', sqlite.ok ? 'ok' : 'fail', sqlite.detail, sqlite.ok ? undefined : 'Use the official Node.js build (22.18+), which includes node:sqlite with FTS5.');

  // Install and PATH
  add('install', 'info', `Garnet ${d.version} at ${installDir}`);
  out.push(pathFinding(d, installDir));

  // Deprecated names: RUBY_* variables and a ~/.ruby home from before the rename
  for (const v of deprecatedEnvVars(d.env)) add('env', 'warn', `${v.old} is deprecated, rename to ${v.name}`, `Set ${v.name} instead (a line in ${join(d.home, 'env')}, your shell profile or the service environment).`);
  if (d.home === join(d.userHome, '.ruby') && !envVar(d.env, 'GARNET_HOME')) add('home', 'warn', `${d.home} is a legacy data directory from before the rename`, `Stop Garnet, then run: mv ${d.home} ${join(d.userHome, '.garnet')}`);

  for (const s of legacyServices({ platform: d.platform, userHome: d.userHome })) add('service', 'warn', `A legacy service from before the rename is still installed (${s.path})`, `Run \`garnet service install\` to replace it, or remove ${s.path} by hand.`);

  // Settings live in config.json: a GARNET_* variable nothing reads is ignored, so say so rather than let it look effective.
  // A secret name the config points at (a connector or ssh passphrase may be called GARNET_*) is read, so it is not flagged.
  const unread = (named: readonly string[]) => {
    for (const name of unknownGarnetEnv(d.env, named)) add('env', 'warn', `${name} is set but Garnet does not read it (settings live in config.json, not the environment)`, `Remove it, and use \`garnet config set <path> <value>\` for the setting (\`garnet config explain\` lists them).`);
  };

  // GARNET_HOME
  if (!existsSync(d.home)) {
    unread([]);
    add('home', 'fail', `${d.home} does not exist yet`, 'Run `garnet setup`.');
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
  let config: GarnetConfig | null = null;
  if (!existsSync(file)) {
    add('config', 'fail', `No config at ${file}`, 'Run `garnet setup`.');
  } else {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      config = parseConfig(raw);
      add('config', 'ok', `${file} is valid${raw.version !== CONFIG_VERSION ? ' (an older version; it is migrated, with a backup, the next time Garnet loads it)' : ''}`);
    } catch (e) {
      add('config', 'fail', `${file}: ${errorMessage(e)}`, 'Run `garnet setup` to fix it interactively, or edit the file (`garnet config explain` lists every setting).');
    }
  }
  unread(config ? [...secretNames(config), ...(config.web.search.apiKeyEnv ? [config.web.search.apiKeyEnv] : [])] : []);

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
  const missingFix = (name: string) => (storeError ? `Unlock the store (see above), or set ${name}.` : `Run \`garnet setup\`, or \`garnet secrets set ${name}\`.`);

  if (config) {
    // Model and key
    const m = config.model;
    if (m.provider === 'fake') add('model', 'warn', 'Using the offline demo model; replies are scripted', 'Run `garnet setup` to pick a real model.');
    else {
      const loc = where(m.apiKeyEnv);
      if (m.provider === 'anthropic') {
        if (loc) add('model', 'ok', `anthropic · ${m.name} · key ${m.apiKeyEnv} (${loc})`);
        else add('model', 'fail', `anthropic · ${m.name} · ${m.apiKeyEnv} is not set`, missingFix(m.apiKeyEnv));
      } else {
        const host = m.baseUrl ? new URL(m.baseUrl).hostname : '';
        const local = LOOPBACK.includes(host);
        if (loc && m.apiKeyEnv === 'ANTHROPIC_API_KEY' && !host.endsWith('anthropic.com')) {
          add('model', 'warn', `openai-compatible · ${m.name} · would send ANTHROPIC_API_KEY to ${host}`, 'Set model.apiKeyEnv to the key for this server (`garnet setup`).');
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
      add('workspace', 'fail', `${workspace} contains Garnet's home, so file tools could change config.json and secrets; Garnet refuses to start`, 'Point "workspace" in config.json at a directory of its own (or remove it for the default).');
    }
    if (config.api.enabled && !LOOPBACK.includes(config.api.host)) {
      add('api', 'warn', `The API listens on ${config.api.host}:${config.api.port}, reachable from other machines (it needs a key, and has no TLS)`, 'Bind to 127.0.0.1 and use Tailscale or a reverse proxy with TLS.');
    }

    // Channels
    const ch = config.channels;
    const enabled = (['telegram', 'discord', 'signal'] as const).filter((n) => ch[n].enabled);
    if (!enabled.length) add('channels', 'info', 'No messaging channels enabled', 'Run `garnet setup` to add Telegram, Discord or Signal.');
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
      add('web', 'warn', 'Untrusted-content containment is off: a web page could steer Garnet into actions you set to allow', 'Set containment.enabled = true in config.json.');
    }

    // Optional built-ins: skills and connectors (all off by default)
    const onIn = (kind: 'skills' | 'connectors', name: string): string => {
      const t = config[kind];
      const scopes = Object.entries(t.channels).filter(([, o]) => o.enable.includes(name)).map(([s]) => s);
      return [...(t.enabled.includes(name) ? ['global'] : []), ...scopes].join(', ');
    };
    const skillsOn = enabledAnywhere(config.skills);
    const connectorsOn = enabledAnywhere(config.connectors) as ConnectorName[];
    if (!skillsOn.length && !connectorsOn.length) add('builtins', 'info', 'No built-in skills or connectors enabled (all optional)', 'See `garnet skills builtin` and `garnet connectors list`.');
    for (const name of skillsOn) {
      const local = existsSync(join(d.home, 'skills', name, 'SKILL.md'));
      if (local) add('skills', 'warn', `built-in skill ${name} is on (${onIn('skills', name)}) but a skill of the same name in ${join(d.home, 'skills')} takes precedence`, `Rename your own skill folder ${join(d.home, 'skills', name)} to use the built-in, or disable the built-in (\`garnet skills disable ${name}\`).`);
      else add('skills', 'ok', `built-in skill ${name} · on (${onIn('skills', name)})`);
    }
    for (const name of connectorsOn) {
      const info = CONNECTOR_INFO[name];
      const label = `${name} · on (${onIn('connectors', name)})`;
      if (config.permissions['net.fetch'] === 'deny') {
        add('connector', 'warn', `${label}, but permissions.net.fetch is deny, so it is not offered`, 'Set permissions.net.fetch to ask (or allow) in config.json, or disable the connector.');
        continue;
      }
      const secrets = info.secrets(config.connectors).map((s) => ({ ...s, loc: where(s.name) }));
      const missing = secrets.filter((s) => !s.loc);
      const required = missing.find((s) => s.required);
      if (required) add('connector', 'fail', `${label}, but ${required.name} (${required.why}) is not set`, missingFix(required.name));
      else if (missing.length) add('connector', 'info', `${label} · ${missing.map((s) => `${s.name} not set (${s.why})`).join('; ')}`, missingFix(missing[0]!.name));
      else add('connector', 'ok', `${label}${secrets.length ? ` · ${secrets.map((s) => `${s.name} (${s.loc})`).join(', ')}` : ''}`);
      if (info.needs(config.connectors).includes('message.send') && config.permissions['message.send'] === 'deny') {
        add('connector', 'warn', `connectors.${name}.write is on but permissions.message.send is deny, so posting is always refused`, 'Set permissions.message.send to ask, or turn write off.');
      }
    }
    const channelOn = (scope: string): boolean => {
      const head = scope.split(':')[0]!;
      if (head === 'telegram' || head === 'discord' || head === 'signal') return config.channels[head].enabled;
      if (head === 'api') return config.api.enabled;
      if (head === 'route') return config.routes.some((r) => `route:${r.conversation}` === scope);
      return true;
    };
    for (const scope of [...new Set([...Object.keys(config.skills.channels), ...Object.keys(config.connectors.channels)])].sort()) {
      if (!channelOn(scope)) add('builtins', 'info', `The override for ${scope} has no effect: ${scope.startsWith('route:') ? 'no route uses that conversation' : `${scope.split(':')[0]} is not enabled`}`);
    }

    // Sandbox
    const sb = config.sandbox;
    if (config.permissions.exec === 'deny') add('sandbox', 'info', 'Shell commands are off (permissions.exec = deny), so no sandbox is needed');
    else if (sb.backend === 'local') add('sandbox', 'warn', 'Commands run on the host (sandbox.backend = local), which is not a security boundary', 'Use sandbox.backend = docker (or ssh to a dedicated machine).');
    else if (sb.backend === 'ssh' && (!sb.ssh.host || !sb.ssh.user || !sb.ssh.workdir)) {
      add('sandbox', 'fail', 'sandbox.backend is ssh but sandbox.ssh.host, user or workdir is not set', 'Set them in config.json (`garnet config explain` lists sandbox.ssh.*), or use sandbox.backend = docker.');
    } else if (sb.backend === 'ssh' && sb.ssh.passphraseEnv && !where(sb.ssh.passphraseEnv)) {
      add('sandbox', 'fail', `ssh sandbox: the key passphrase ${sb.ssh.passphraseEnv} is not set`, missingFix(sb.ssh.passphraseEnv));
    } else {
      if (sb.backend === 'ssh' && sb.ssh.hostKeyChecking === 'off') {
        add('sandbox', 'warn', 'ssh host key checking is off (sandbox.ssh.hostKeyChecking = off): anyone on the network path can impersonate the remote host', 'Set hostKeyChecking to strict (and add the host to known_hosts) or accept-new.');
      }
      const lookup: SecretLookup = (name) => d.env[name] || (storeNames?.has(name) ? store.get(name) : undefined);
      const r = await d.sandboxCheck(config, workspace, lookup).catch((e: unknown) => ({ ok: false, detail: errorMessage(e) }));
      // The sandbox's own detail already says how to fix it.
      add('sandbox', r.ok ? 'ok' : 'fail', `${sb.backend === 'ssh' ? 'SSH' : 'Docker'} sandbox: ${r.detail}`);
    }

    // Media
    const med = config.media;
    if (!med.enabled) {
      add('media', 'info', 'Media (photos, files, voice notes) is off (media.enabled = false)');
    } else {
      // Transcription checks
      if (med.transcription.backend === 'command' && med.transcription.command && med.transcription.command.length > 0) {
        const program = med.transcription.command[0]!;
        const found = programRunnable(program, d.env.PATH);
        if (found) add('media', 'ok', `Transcription: local command ${program}`);
        else add('media', 'fail', `Transcription command ${program} is not ${isPathLike(program) ? 'an executable file' : 'on PATH'}`, `Install ${program}${isPathLike(program) ? '' : ' or add its directory to PATH'}.`);
      } else if (med.transcription.backend === 'openai-compatible') {
        const keyName = med.transcription.apiKeyEnv ?? 'OPENAI_API_KEY';
        const loc = where(keyName);
        if (med.transcription.baseUrl) {
          if (loc) add('media', 'ok', `Transcription: openai-compatible at ${med.transcription.baseUrl} with key ${keyName} (${loc})`);
          else add('media', 'warn', `Transcription: openai-compatible at ${med.transcription.baseUrl} but ${keyName} is not set`, missingFix(keyName));
        }
      }

      // PDF text extraction check
      if (med.pdfText.command && med.pdfText.command.length > 0) {
        const program = med.pdfText.command[0]!;
        const found = programRunnable(program, d.env.PATH);
        if (found) add('media', 'ok', `PDF text extraction: ${program}`);
        else add('media', 'fail', `PDF text extraction command ${program} is not ${isPathLike(program) ? 'an executable file' : 'on PATH'}`, `Install ${program}${isPathLike(program) ? '' : ' or add its directory to PATH'}.`);
      }
    }
  }

  // Service
  // The service for THIS GARNET_HOME: an instance installed with --name is found by the home it runs.
  const svc = { platform: d.platform, userHome: d.userHome };
  const resolved = resolveService({ ...svc, home: d.home, nodePath: process.execPath, entry: d.entry });
  if ('unsupported' in resolved) add('service', 'info', resolved.unsupported);
  else {
    const { plan, conflict } = resolved;
    const name = /(?:garnet-|agent\.)([a-z0-9-]+)\.(?:service|plist)$/.exec(plan.path)?.[1];
    const flag = name ? ` --name ${name}` : '';
    const others = installedServices(svc).filter((s) => s.home !== d.home).length;
    const alongside = others ? ` (${others} other Garnet instance${others > 1 ? 's' : ''} installed; \`garnet service list\`)` : '';
    if (conflict || !existsSync(plan.path)) {
      add('service', 'info', `Background service not installed for this GARNET_HOME${alongside}`, conflict ? 'Another GARNET_HOME uses the default service name: run `garnet service install --name <name>`.' : 'Run `garnet service install` (or `garnet setup`) to keep Garnet running.');
    } else {
      const status = await serviceStatus(plan, { run: d.run });
      const stale = readFileSync(plan.path, 'utf8') !== plan.contents;
      const unit = plan.path.split('/').pop()!;
      if (status.ok) add('service', stale ? 'warn' : 'ok', `Service running (${plan.path})${stale ? ', but its file is out of date (Garnet or Node moved?)' : ''}${alongside}`, stale ? `Run \`garnet service install${flag}\` to rewrite it.` : undefined);
      else add('service', 'warn', `Service installed but not running (${plan.path})`, plan.platform === 'systemd' ? `See \`journalctl --user -u ${unit} -e\`, then \`garnet service restart${flag}\`.` : `See ${join(d.home, 'logs')}, then \`garnet service install${flag}\`.`);
    }
  }
  return out;
}

function pathFinding(d: DoctorDeps, installDir: string): Finding {
  // install.sh --name <other> sets GARNET_COMMAND_NAME in its shim.
  const name = /^[A-Za-z0-9._-]+$/.test(envVar(d.env, 'GARNET_COMMAND_NAME') ?? '') ? envVar(d.env, 'GARNET_COMMAND_NAME')! : 'garnet';
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
  if (!first) return { area: 'path', status: 'warn', message: `\`${name}\` is not on your PATH`, fix: `Run install.sh, or \`npm link\` in ${installDir}; until then use \`npm run garnet --\`.` };
  if (ours(first)) return { area: 'path', status: 'ok', message: `\`${name}\` on PATH is this install (${first})` };
  const later = found.slice(1).find(ours);
  return {
    area: 'path',
    status: 'warn',
    message: `\`${name}\` on your PATH is ${first}, not this install${later ? ` (which is at ${later}, later in PATH)` : ''}; it is a different program`,
    fix: later ? `Put ${dirname(later)} earlier in PATH.` : 'Reinstall with `install.sh --name <other-name>`, or use `npm run garnet --`.',
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
  return `${s.accent('◆ GARNET')} ${s.muted('/ DOCTOR')}\n${lines.join('\n')}\n\n${verdict}\n`;
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
    home: garnetHome(),
    env: process.env,
    platform: process.platform,
    nodeVersion: process.versions.node,
    userHome: homedir(),
    entry: defaultEntry(),
    version: overrides.version ?? 'unknown',
    run,
    sqlite: realSqliteCheck,
    sandboxCheck: async (config, workspace, secret) => createSandbox(config.sandbox.backend, sandboxOptions(config, workspace, secret)).check(),
    ...overrides,
  };
  const findings = await diagnose(deps);
  if (values.json) io.out(JSON.stringify(findings, null, 2) + '\n');
  else io.out(formatFindings(findings, makeStyle(wantsColor(process.stdout))));
  return findings.some((f) => f.status === 'fail') ? 1 : 0;
}
