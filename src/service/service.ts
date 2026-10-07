import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ServicePlan = {
  platform: 'systemd' | 'launchd';
  /** Garnet's data directory (GARNET_HOME); logs and the env file live here. */
  home: string;
  /** Where the unit / plist file is written. */
  path: string;
  contents: string;
  /**
   * `prepare` runs before `install` and may fail (e.g. unloading a service that is not loaded);
   * install (re)starts the service, so reinstalling picks up a changed unit or plist.
   */
  commands: { prepare: string[][]; install: string[][]; uninstall: string[][]; status: string[][]; restart: string[][] };
  notes: string[];
  /** The service file this instance had before the rename to Garnet, and the commands that stop it. */
  legacy: { path: string; stop: string[][]; /** Other homes a legacy unit may run for this instance (the pre-rename `~/.ruby`, when home is `~/.garnet`). */ homes: string[] };
};

export type PlanOptions = {
  platform: NodeJS.Platform;
  /** Garnet's data directory (GARNET_HOME). */
  home: string;
  /** The user's home directory (where unit files live). */
  userHome: string;
  /** Absolute path of the node binary. */
  nodePath: string;
  /** Absolute path of src/cli/bin.ts. */
  entry: string;
  /** launchd only: numeric user id for the gui/<uid> domain. Defaults to process.getuid(). */
  uid?: number;
  /**
   * Instance name, so several Garnet homes can run side by side: `garnet-<name>.service` /
   * `dev.garnet.agent.<name>`. Omitted (or "garnet"): the default `garnet.service` / `dev.garnet.agent`.
   */
  name?: string | undefined;
};

export type CommandResult = { code: number; stdout: string; stderr: string };

export type ServiceDeps = {
  writeFile: (path: string, contents: string, mode: number) => void | Promise<void>;
  mkdir: (path: string) => void | Promise<void>;
  exists: (path: string) => boolean;
  remove: (path: string) => void | Promise<void>;
  run: (cmd: string[]) => Promise<CommandResult>;
  /** File names in a directory ([] when it does not exist). */
  list: (dir: string) => string[];
  read: (path: string) => string;
};

export type ServiceResult = {
  ok: boolean;
  /** Files written or removed. */
  files: string[];
  /** Every command run, in order, with its outcome. */
  commands: { cmd: string[]; code: number; stdout: string; stderr: string }[];
  notes: string[];
};

const SYSTEMD_UNIT = 'garnet.service';
const LAUNCHD_LABEL = 'dev.garnet.agent';
/** Instance names: short, lowercase, safe in unit names, labels and file names. */
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Throws on an invalid instance name; returns the normalized one (undefined = default). */
export function checkServiceName(name: string | undefined): string | undefined {
  if (name === undefined || name === '' || name === 'garnet') return undefined;
  if (!SERVICE_NAME_RE.test(name)) throw new Error(`Invalid service name "${name}": use 1-32 lowercase letters, digits and hyphens.`);
  return name;
}

/** The systemd unit file name for an instance. */
export const systemdUnit = (name?: string): string => (checkServiceName(name) ? `garnet-${name}.service` : SYSTEMD_UNIT);
/** The launchd label for an instance. */
/** Pre-rename names: `ruby[-name].service` and `dev.ruby.agent[.name]`. */
/** The user ran `mv ~/.ruby ~/.garnet`: a legacy unit still pointing at ~/.ruby is the same instance. */
const legacyHomes = (o: { home: string; userHome: string }): string[] => (o.home === join(o.userHome, '.garnet') ? [join(o.userHome, '.ruby')] : []);
const legacyServiceHomeMatches = (found: string | null, o: { home: string; userHome: string }): boolean =>
  found !== null && (found === o.home || legacyHomes(o).includes(found));
const legacySystemdUnit = (name?: string): string => (checkServiceName(name) ? `ruby-${name}.service` : 'ruby.service');
const legacyLaunchdLabel = (name?: string): string => (checkServiceName(name) ? `dev.ruby.agent.${name}` : 'dev.ruby.agent');
export const launchdLabel = (name?: string): string => (checkServiceName(name) ? `${LAUNCHD_LABEL}.${name}` : LAUNCHD_LABEL);
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
/**
 * Seconds the service manager waits after SIGTERM before killing Garnet. Shutdown closes the API
 * (up to 20 s for in-flight requests), then drains running tasks (up to 20 s, then 5 s after
 * cancelling them) and flushes deliveries, so 30 s could kill it mid-drain.
 */
const STOP_TIMEOUT_SEC = 60;

/** Absolute path of src/cli/bin.ts, resolved relative to this module. */
export function defaultEntry(): string {
  return join(import.meta.dirname, '..', 'cli', 'bin.ts');
}

/** Quotes a string for POSIX sh. Safe words pass through; everything else is single-quoted. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Quotes one word for a systemd unit line: double quotes, with \, ", $ and % escaped. */
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
}

/** Escapes specifiers in an unquoted systemd path value. */
const systemdPath = (s: string): string => s.replace(/%/g, '%%');

/** The repo root, given src/cli/bin.ts. */
const repoRoot = (entry: string): string => dirname(dirname(dirname(entry)));

function planSystemd(o: PlanOptions): ServicePlan {
  const unit = systemdUnit(o.name);
  const exec = [o.nodePath, ...NODE_FLAGS, o.entry, 'start'].map(systemdQuote).join(' ');
  const contents = `[Unit]
Description=Garnet personal agent${checkServiceName(o.name) ? ` (${o.name})` : ''}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${systemdPath(repoRoot(o.entry))}
Environment=${systemdQuote(`GARNET_HOME=${o.home}`)}
EnvironmentFile=-${systemdPath(join(o.home, 'env'))}
Restart=on-failure
RestartSec=5
TimeoutStopSec=${STOP_TIMEOUT_SEC}
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
  return {
    platform: 'systemd',
    home: o.home,
    path: join(o.userHome, '.config', 'systemd', 'user', unit),
    contents,
    commands: {
      prepare: [],
      install: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', unit],
        // restart, not start: an already running service must pick up the new unit and code.
        ['systemctl', '--user', 'restart', unit],
      ],
      uninstall: [['systemctl', '--user', 'disable', '--now', unit]],
      status: [['systemctl', '--user', 'status', unit, '--no-pager']],
      restart: [['systemctl', '--user', 'restart', unit]],
    },
    legacy: { path: join(o.userHome, '.config', 'systemd', 'user', legacySystemdUnit(o.name)), stop: [['systemctl', '--user', 'disable', '--now', legacySystemdUnit(o.name)]], homes: legacyHomes(o) },
    notes: [
      `Put secrets such as ANTHROPIC_API_KEY in ${join(o.home, 'env')} (KEY=value lines, mode 0600), or encrypt them with \`garnet secrets set\` and put only GARNET_SECRETS_KEY_FILE=<path> there.`,
      'To keep Garnet running without an active login, run: loginctl enable-linger $USER',
      `Logs: journalctl --user -u ${unit} -f`,
    ],
  };
}

function planLaunchd(o: PlanOptions): ServicePlan {
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const label = launchdLabel(o.name);
  const path = join(o.userHome, 'Library', 'LaunchAgents', `${label}.plist`);
  // launchd cannot read an env file, so a small sh wrapper sources it before exec'ing node.
  const script =
    'set -a; [ -f "$GARNET_HOME/env" ] && . "$GARNET_HOME/env"; set +a; exec ' +
    [o.nodePath, ...NODE_FLAGS, o.entry, 'start'].map(shellQuote).join(' ');
  const args = ['/bin/sh', '-c', script].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  // launchd's default PATH is /usr/bin:/bin:/usr/sbin:/sbin, which misses Homebrew and Docker Desktop
  // (the Docker sandbox runs `docker`). Deterministic, so `garnet doctor` can compare the file.
  const searchPath = [...new Set([dirname(o.nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GARNET_HOME</key>
    <string>${xmlEscape(o.home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(searchPath)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot(o.entry))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ExitTimeOut</key>
  <integer>${STOP_TIMEOUT_SEC}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(o.home, 'logs', 'garnet.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(o.home, 'logs', 'garnet.err.log'))}</string>
</dict>
</plist>
`;
  const target = `gui/${uid}/${label}`;
  return {
    platform: 'launchd',
    home: o.home,
    path,
    contents,
    commands: {
      // bootstrap fails if the agent is already loaded, so unload it first (a reinstall then restarts it).
      prepare: [['launchctl', 'bootout', target]],
      install: [['launchctl', 'bootstrap', `gui/${uid}`, path]],
      uninstall: [['launchctl', 'bootout', target]],
      status: [['launchctl', 'print', target]],
      restart: [['launchctl', 'kickstart', '-k', target]],
    },
    legacy: { path: join(o.userHome, 'Library', 'LaunchAgents', `${legacyLaunchdLabel(o.name)}.plist`), stop: [['launchctl', 'bootout', `gui/${uid}/${legacyLaunchdLabel(o.name)}`]], homes: legacyHomes(o) },
    notes: [
      `Put secrets such as ANTHROPIC_API_KEY in ${join(o.home, 'env')} (KEY=value lines, mode 0600), or encrypt them with \`garnet secrets set\` and put only GARNET_SECRETS_KEY_FILE=<path> there.`,
      `Logs: ${join(o.home, 'logs')}`,
    ],
  };
}

/** The GARNET_HOME a unit file or plist runs, or null when it names none. */
export function serviceHomeOf(contents: string): string | null {
  const unit = /^Environment="GARNET_HOME=((?:[^"\\]|\\.)*)"$/m.exec(contents);
  if (unit) return unit[1]!.replace(/\\(.)/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%');
  const plist = /<key>GARNET_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents);
  if (plist) return plist[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return null;
}

/**
 * The RUBY_HOME run by a service file that Garnet (then called Ruby) wrote before the rename, or
 * null when the file is not one of ours. The markers are the description / label and the RUBY_HOME
 * setting that only our templates contain.
 */
export function legacyServiceHomeOf(contents: string): string | null {
  const unit = /^Environment="RUBY_HOME=((?:[^"\\]|\\.)*)"$/m.exec(contents);
  if (unit && /^Description=Ruby personal agent/m.test(contents)) return unit[1]!.replace(/\\(.)/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%');
  const plist = /<key>RUBY_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents);
  if (plist && /<string>dev\.ruby\.agent(?:\.[a-z0-9-]+)?<\/string>/.test(contents)) return plist[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return null;
}

/** Legacy `ruby` services (written by us before the rename) installed for this user; foreign files with the same name are ignored. */
export function legacyServices(opts: { platform: NodeJS.Platform; userHome: string }, deps: Partial<Pick<ServiceDeps, 'list' | 'read'>> = {}): InstalledService[] {
  const list = deps.list ?? defaultDeps.list;
  const read = deps.read ?? defaultDeps.read;
  const where =
    opts.platform === 'linux'
      ? { dir: join(opts.userHome, '.config', 'systemd', 'user'), re: /^ruby(?:-([a-z0-9][a-z0-9-]{0,31}))?\.service$/ }
      : opts.platform === 'darwin'
        ? { dir: join(opts.userHome, 'Library', 'LaunchAgents'), re: /^dev\.ruby\.agent(?:\.([a-z0-9][a-z0-9-]{0,31}))?\.plist$/ }
        : null;
  if (!where) return [];
  const out: InstalledService[] = [];
  for (const file of list(where.dir).sort()) {
    const m = where.re.exec(file);
    if (!m) continue;
    try {
      const home = legacyServiceHomeOf(read(join(where.dir, file)));
      if (home !== null) out.push({ name: m[1], path: join(where.dir, file), home });
    } catch {
      /* unreadable: not ours to touch */
    }
  }
  return out;
}

export type InstalledService = { name: string | undefined; path: string; home: string | null };

/** Garnet services installed for this user (any instance name), with the GARNET_HOME each runs. */
export function installedServices(opts: { platform: NodeJS.Platform; userHome: string }, deps: Partial<Pick<ServiceDeps, 'list' | 'read'>> = {}): InstalledService[] {
  const list = deps.list ?? defaultDeps.list;
  const read = deps.read ?? defaultDeps.read;
  const where =
    opts.platform === 'linux'
      ? { dir: join(opts.userHome, '.config', 'systemd', 'user'), re: /^garnet(?:-([a-z0-9][a-z0-9-]{0,31}))?\.service$/ }
      : opts.platform === 'darwin'
        ? { dir: join(opts.userHome, 'Library', 'LaunchAgents'), re: /^dev\.garnet\.agent(?:\.([a-z0-9][a-z0-9-]{0,31}))?\.plist$/ }
        : null;
  if (!where) return [];
  const out: InstalledService[] = [];
  for (const file of list(where.dir).sort()) {
    const m = where.re.exec(file);
    if (!m) continue;
    let home: string | null = null;
    try {
      home = serviceHomeOf(read(join(where.dir, file)));
    } catch {
      /* unreadable: home unknown */
    }
    out.push({ name: m[1], path: join(where.dir, file), home });
  }
  return out;
}

/**
 * Picks the service for this GARNET_HOME: the given name, else the instance already installed for
 * this home, else the default. `conflict` is set when that service file already runs another home
 * (installing would take it over).
 */
export function resolveService(
  opts: PlanOptions,
  deps: Partial<Pick<ServiceDeps, 'list' | 'read'>> = {},
): { plan: ServicePlan; conflict: string | null } | { unsupported: string } {
  checkServiceName(opts.name);
  const installed = installedServices(opts, deps);
  const mine = installed.find((s) => s.home === opts.home) ?? legacyServices(opts, deps).find((s) => legacyServiceHomeMatches(s.home, opts));
  const plan = planService({ ...opts, name: opts.name !== undefined ? opts.name : mine?.name });
  if ('unsupported' in plan) return plan;
  const existing = installed.find((s) => s.path === plan.path);
  const conflict =
    existing && existing.home !== null && existing.home !== opts.home
      ? `${plan.path} already runs GARNET_HOME=${existing.home}. Give this instance its own name: \`garnet service install --name <name>\`.`
      : null;
  return { plan, conflict };
}

/** Pure: decides what the service looks like on this platform. No I/O. */
export function planService(opts: PlanOptions): ServicePlan | { unsupported: string } {
  switch (opts.platform) {
    case 'linux':
      return planSystemd(opts);
    case 'darwin':
      return planLaunchd(opts);
    default:
      return {
        unsupported: `Service install is not supported yet on ${opts.platform}; run \`garnet start\` under your own supervisor.`,
      };
  }
}

function execCommand(cmd: string[]): Promise<CommandResult> {
  const [file, ...args] = cmd;
  return new Promise((resolve) => {
    if (!file) return resolve({ code: 1, stdout: '', stderr: 'empty command' });
    execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr: stderr || error.message });
    });
  });
}

const defaultDeps: ServiceDeps = {
  writeFile: (path, contents, mode) => {
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode); // the open() mode is masked by umask and ignored for existing files
  },
  // GARNET_HOME holds the env file with secrets: keep directories private to the user.
  mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path, { force: true }),
  run: execCommand,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (path) => readFileSync(path, 'utf8'),
};

const ENV_TEMPLATE =
  '# Environment for Garnet: one KEY=value per line (for example ANTHROPIC_API_KEY=...). Keep this file private (mode 0600).\n';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function runAll(cmds: string[][], d: ServiceDeps, result: ServiceResult, mayFail = false): Promise<void> {
  for (const cmd of cmds) {
    let r: CommandResult;
    try {
      r = await d.run(cmd);
    } catch (e) {
      r = { code: 1, stdout: '', stderr: errorText(e) };
    }
    result.commands.push({ cmd, ...r });
    if (r.code !== 0 && !mayFail) result.ok = false;
  }
}

/** Stops and removes this instance's pre-rename `ruby` service, but only a file we wrote that runs the same home. */
async function removeLegacy(plan: ServicePlan, d: ServiceDeps, result: ServiceResult): Promise<void> {
  const { path, stop } = plan.legacy;
  try {
    if (!d.exists(path) || !plan.legacy.homes.concat(plan.home).includes(legacyServiceHomeOf(d.read(path)) ?? '\0')) return;
    await runAll(stop, d, result, true);
    await d.remove(path);
    result.files.push(path);
    result.notes.push(`Removed the legacy service from before the rename (${path}); Garnet replaces it.`);
    if (plan.platform === 'systemd') await runAll([['systemctl', '--user', 'daemon-reload']], d, result, true);
  } catch (e) {
    result.notes.push(`Could not remove the legacy service ${path}: ${errorText(e)}`);
  }
}

/** Writes the service file, prepares <home>/logs and <home>/env, then registers and starts the service. */
export async function installService(plan: ServicePlan, deps: Partial<ServiceDeps> = {}): Promise<ServiceResult> {
  const d = { ...defaultDeps, ...deps };
  const result: ServiceResult = { ok: true, files: [], commands: [], notes: [...plan.notes] };
  try {
    await d.mkdir(dirname(plan.path));
    await d.mkdir(join(plan.home, 'logs'));
    await d.writeFile(plan.path, plan.contents, 0o644);
    result.files.push(plan.path);
    const envFile = join(plan.home, 'env');
    if (!d.exists(envFile)) {
      await d.writeFile(envFile, ENV_TEMPLATE, 0o600);
      result.files.push(envFile);
    }
  } catch (e) {
    result.ok = false;
    result.notes.push(`Could not write service files: ${errorText(e)}`);
    return result;
  }
  await runAll(plan.commands.prepare, d, result, true);
  await removeLegacy(plan, d, result);
  await runAll(plan.commands.install, d, result);
  if (plan.platform === 'systemd' && result.commands.some((c) => c.code !== 0 && /Failed to connect to (user )?bus/i.test(c.stderr))) {
    result.notes.push(
      'systemd has no user session for this shell (common after `su`, `sudo -iu` or a console login). ' +
        'The unit file is written. Log in over SSH (or run `loginctl enable-linger $USER`, then log in again), ' +
        'then run `garnet service install`. Until then, `garnet start` runs Garnet in the foreground.',
    );
  }
  return result;
}

/** Stops and unregisters the service, then removes its file. The env file and logs are kept. */
export async function uninstallService(plan: ServicePlan, deps: Partial<ServiceDeps> = {}): Promise<ServiceResult> {
  const d = { ...defaultDeps, ...deps };
  const result: ServiceResult = { ok: true, files: [], commands: [], notes: [] };
  await runAll(plan.commands.uninstall, d, result);
  try {
    if (d.exists(plan.path)) {
      await d.remove(plan.path);
      result.files.push(plan.path);
    }
  } catch (e) {
    result.ok = false;
    result.notes.push(`Could not remove ${plan.path}: ${errorText(e)}`);
  }
  if (plan.platform === 'systemd') await runAll([['systemctl', '--user', 'daemon-reload']], d, result);
  return result;
}

/** Asks the service manager for the service's status. */
export async function serviceStatus(plan: ServicePlan, deps: Partial<ServiceDeps> = {}): Promise<ServiceResult> {
  const d = { ...defaultDeps, ...deps };
  const result: ServiceResult = { ok: true, files: [], commands: [], notes: [] };
  await runAll(plan.commands.status, d, result);
  return result;
}

/** Restarts the service so it picks up config and secret changes. */
export async function restartService(plan: ServicePlan, deps: Partial<ServiceDeps> = {}): Promise<ServiceResult> {
  const d = { ...defaultDeps, ...deps };
  const result: ServiceResult = { ok: true, files: [], commands: [], notes: [] };
  await runAll(plan.commands.restart, d, result);
  return result;
}
