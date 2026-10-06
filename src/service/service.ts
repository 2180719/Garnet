import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ServicePlan = {
  platform: 'systemd' | 'launchd';
  /** Ruby's data directory (RUBY_HOME); logs and the env file live here. */
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
};

export type PlanOptions = {
  platform: NodeJS.Platform;
  /** Ruby's data directory (RUBY_HOME). */
  home: string;
  /** The user's home directory (where unit files live). */
  userHome: string;
  /** Absolute path of the node binary. */
  nodePath: string;
  /** Absolute path of src/cli/bin.ts. */
  entry: string;
  /** launchd only: numeric user id for the gui/<uid> domain. Defaults to process.getuid(). */
  uid?: number;
};

export type CommandResult = { code: number; stdout: string; stderr: string };

export type ServiceDeps = {
  writeFile: (path: string, contents: string, mode: number) => void | Promise<void>;
  mkdir: (path: string) => void | Promise<void>;
  exists: (path: string) => boolean;
  remove: (path: string) => void | Promise<void>;
  run: (cmd: string[]) => Promise<CommandResult>;
};

export type ServiceResult = {
  ok: boolean;
  /** Files written or removed. */
  files: string[];
  /** Every command run, in order, with its outcome. */
  commands: { cmd: string[]; code: number; stdout: string; stderr: string }[];
  notes: string[];
};

const SYSTEMD_UNIT = 'ruby.service';
const LAUNCHD_LABEL = 'dev.ruby.agent';
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
/**
 * Seconds the service manager waits after SIGTERM before killing Ruby. Shutdown closes the API
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
  const exec = [o.nodePath, ...NODE_FLAGS, o.entry, 'start'].map(systemdQuote).join(' ');
  const contents = `[Unit]
Description=Ruby personal agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=${systemdPath(repoRoot(o.entry))}
Environment=${systemdQuote(`RUBY_HOME=${o.home}`)}
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
    path: join(o.userHome, '.config', 'systemd', 'user', SYSTEMD_UNIT),
    contents,
    commands: {
      prepare: [],
      install: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', SYSTEMD_UNIT],
        // restart, not start: an already running service must pick up the new unit and code.
        ['systemctl', '--user', 'restart', SYSTEMD_UNIT],
      ],
      uninstall: [['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]],
      status: [['systemctl', '--user', 'status', SYSTEMD_UNIT, '--no-pager']],
      restart: [['systemctl', '--user', 'restart', SYSTEMD_UNIT]],
    },
    notes: [
      `Put secrets such as ANTHROPIC_API_KEY in ${join(o.home, 'env')} (KEY=value lines, mode 0600), or encrypt them with \`ruby secrets set\` and put only RUBY_SECRETS_KEY_FILE=<path> there.`,
      'To keep Ruby running without an active login, run: loginctl enable-linger $USER',
      `Logs: journalctl --user -u ${SYSTEMD_UNIT} -f`,
    ],
  };
}

function planLaunchd(o: PlanOptions): ServicePlan {
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const path = join(o.userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  // launchd cannot read an env file, so a small sh wrapper sources it before exec'ing node.
  const script =
    'set -a; [ -f "$RUBY_HOME/env" ] && . "$RUBY_HOME/env"; set +a; exec ' +
    [o.nodePath, ...NODE_FLAGS, o.entry, 'start'].map(shellQuote).join(' ');
  const args = ['/bin/sh', '-c', script].map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  // launchd's default PATH is /usr/bin:/bin:/usr/sbin:/sbin, which misses Homebrew and Docker Desktop
  // (the Docker sandbox runs `docker`). Deterministic, so `ruby doctor` can compare the file.
  const searchPath = [...new Set([dirname(o.nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RUBY_HOME</key>
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
  <string>${xmlEscape(join(o.home, 'logs', 'ruby.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(o.home, 'logs', 'ruby.err.log'))}</string>
</dict>
</plist>
`;
  const target = `gui/${uid}/${LAUNCHD_LABEL}`;
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
    notes: [
      `Put secrets such as ANTHROPIC_API_KEY in ${join(o.home, 'env')} (KEY=value lines, mode 0600), or encrypt them with \`ruby secrets set\` and put only RUBY_SECRETS_KEY_FILE=<path> there.`,
      `Logs: ${join(o.home, 'logs')}`,
    ],
  };
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
        unsupported: `Service install is not supported yet on ${opts.platform}; run \`ruby start\` under your own supervisor.`,
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
  // RUBY_HOME holds the env file with secrets: keep directories private to the user.
  mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o700 }),
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path, { force: true }),
  run: execCommand,
};

const ENV_TEMPLATE =
  '# Environment for Ruby: one KEY=value per line (for example ANTHROPIC_API_KEY=...). Keep this file private (mode 0600).\n';

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
  await runAll(plan.commands.install, d, result);
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
