// `garnet update`: the in-place updater for an install made by install.sh (a git checkout).
//
// It fast-forwards the checkout, reinstalls dependencies only when they changed, smoke-checks the
// new code and rolls back to the previous commit when anything fails after the checkout moved.
// It never uses `git reset --hard`, `git clean` or force, never touches GARNET_HOME (the data
// directory), and never prints secrets. Every side effect goes through `UpdateDeps`, so tests run
// it against temp repositories with a fake process runner and never touch the network.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { garnetHome } from '../config/index.ts';
import { errorMessage } from '../contracts/index.ts';
import { installedServices, resolveService, restartService, type CommandResult } from '../service/index.ts';
import type { Io } from './main.ts';
import { makeStyle, wantsColor, type Style } from './setup/prompt.ts';

/** Exit code of `garnet update --check` when an update is available (0 means up to date). */
export const UPDATE_AVAILABLE = 10;

const MAX_SUBJECTS = 20;
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

export type RunOptions = { cwd?: string | undefined; timeoutMs?: number | undefined };

export type UpdateDeps = {
  /** The checkout the running code lives in (the repo root above src/cli). */
  installDir: string;
  /** GARNET_HOME, only used to find this home's background service. */
  home: string;
  userHome: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  /** Runs a program with an argument vector (never a shell). Failures are results, not throws. */
  run: (cmd: string[], opts?: RunOptions) => Promise<CommandResult>;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
  /** Names in a directory ([] when missing); used to find installed services. */
  list: (dir: string) => string[];
  /** Asks a yes/no question. Without a terminal it must answer false. */
  confirm: (question: string) => Promise<boolean>;
  /** Takes the single-updater lock, or says who holds it. */
  acquireLock: () => { release: () => void } | { heldBy: number | null };
  color: boolean;
};

/** Runs a program without a shell. Never prompts for git credentials. */
export function execRun(cmd: string[], opts: RunOptions = {}): Promise<CommandResult> {
  const [file, ...args] = cmd;
  return new Promise((done) => {
    execFile(
      file!,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) || (error && !stdout ? error.message : '') });
      },
    );
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock file inside .git (never shows as a change, never in GARNET_HOME), with a pid check for stale locks. */
export function fileLock(path: string): UpdateDeps['acquireLock'] {
  return () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
        return { release: () => rmSync(path, { force: true }) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { heldBy: null };
        let pid: number | null = null;
        try {
          pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
        } catch {
          /* vanished: retry */
        }
        if (pid !== null && Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return { heldBy: pid };
        rmSync(path, { force: true }); // stale
      }
    }
    return { heldBy: null };
  };
}

async function terminalConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export function realUpdateDeps(overrides: Partial<UpdateDeps> = {}): UpdateDeps {
  const installDir = overrides.installDir ?? resolve(import.meta.dirname, '..', '..');
  return {
    installDir,
    home: garnetHome(),
    userHome: homedir(),
    platform: process.platform,
    env: process.env,
    nodePath: process.execPath,
    run: execRun,
    exists: (p) => existsSync(p),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    confirm: terminalConfirm,
    acquireLock: fileLock(join(installDir, '.git', 'garnet-update.lock')),
    color: wantsColor(process.stdout),
    ...overrides,
  };
}

export const UPDATE_USAGE = `Usage: garnet update [--check] [-y|--yes] [--ref <branch|tag>] [--reinstall]

  --check        Read-only: fetch, then show the current and latest commit and what is new.
                 Exit 0 when up to date, ${UPDATE_AVAILABLE} when an update is available.
  -y, --yes      Do not ask for confirmation; also restart the background service.
  --ref <name>   Update to this branch or tag instead of the branch the checkout tracks.
  --reinstall    Run \`npm ci\` even when package.json and package-lock.json did not change.

Updates the install made by install.sh in place (fast-forward only). Your data in GARNET_HOME is never
touched. If anything fails after the code moved, the previous commit is restored.
`;

const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const short = (sha: string): string => sha.slice(0, 7);
const firstLines = (text: string, n = 8): string => text.trim().split('\n').slice(-n).join('\n    ');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

type Failure = { fail: string; hint?: string };
type Target = {
  remote: string;
  ref: string;
  branch: string | null;
  head: string;
  target: string;
  /** Relation of HEAD to the target. */
  relation: 'same' | 'behind' | 'ahead' | 'diverged';
  behind: number;
  ahead: number;
};
type Flags = { yes?: boolean | undefined; ref?: string | undefined; reinstall?: boolean | undefined };

class Updater {
  readonly d: UpdateDeps;
  readonly io: Io;
  readonly s: Style;
  constructor(d: UpdateDeps, io: Io) {
    this.d = d;
    this.io = io;
    this.s = makeStyle(d.color);
  }

  out = (t: string): void => this.io.out(t);
  err = (t: string): void => this.io.err(t);
  step = (t: string): void => this.out(`${this.s.accent('==>')} ${t}\n`);
  ok = (t: string): void => this.out(`  ${this.s.ok('✓')} ${t}\n`);
  warn = (t: string): void => this.out(`  ${this.s.warn('!')} ${t}\n`);
  bad = (t: string): void => this.err(`  ${this.s.bad('✗')} ${t}\n`);

  git = (args: string[], timeoutMs?: number): Promise<CommandResult> => this.d.run(['git', '-C', this.d.installDir, ...args], { timeoutMs });
  entry = (): string => join(this.d.installDir, 'src', 'cli', 'bin.ts');
  node = (args: string[]): Promise<CommandResult> => this.d.run([this.d.nodePath, ...NODE_FLAGS, this.entry(), ...args], { cwd: this.d.installDir, timeoutMs: 60_000 });

  version(): string {
    try {
      return (JSON.parse(this.d.readText(join(this.d.installDir, 'package.json')) ?? '{}') as { version?: string }).version ?? '?';
    } catch {
      return '?';
    }
  }

  /** Refuses (returns a Failure) when this is not a clean checkout. */
  async preflight(): Promise<Failure | null> {
    const dir = this.d.installDir;
    if (!this.d.exists(join(dir, '.git'))) {
      return {
        fail: `${dir} is not a git checkout, so it cannot be updated in place.`,
        hint: 'Reinstall with install.sh (it keeps your data in GARNET_HOME): curl -fsSL https://raw.githubusercontent.com/garnet-foundation/Garnet/main/install.sh | sh',
      };
    }
    const status = await this.git(['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0) return { fail: `git could not read ${dir}: ${firstLines(status.stderr, 3)}`, hint: 'Is git installed, and is this a healthy checkout?' };
    if (status.stdout.trim()) {
      return {
        fail: `${dir} has uncommitted changes; leaving it alone.`,
        hint: `Commit or stash them (git -C ${dir} status shows them), or work in a separate checkout and keep this one for daily use.`,
      };
    }
    return null;
  }

  /** Fetches the target and compares it with HEAD. Changes nothing but FETCH_HEAD. */
  async resolveTarget(refOverride: string | undefined): Promise<Target | Failure> {
    const branchRes = await this.git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const branch = branchRes.code === 0 ? branchRes.stdout.trim() || null : null;
    let remote = 'origin';
    let ref = refOverride;
    if (branch) {
      const r = (await this.git(['config', '--get', `branch.${branch}.remote`])).stdout.trim();
      if (r && r !== '.') remote = r;
      if (!ref) {
        const merge = (await this.git(['config', '--get', `branch.${branch}.merge`])).stdout.trim();
        ref = merge.replace(/^refs\/heads\//, '') || branch;
      }
    }
    if (!ref) {
      return { fail: 'This checkout is on a detached HEAD, so there is no branch to follow.', hint: 'Name one: garnet update --ref main (or a tag).' };
    }
    const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
    const fetched = await this.git(['fetch', '--quiet', remote, ref], 180_000);
    if (fetched.code !== 0) {
      return { fail: `git fetch ${remote} ${ref} failed: ${firstLines(fetched.stderr, 3) || 'no output'}`, hint: 'Check the network and that the branch or tag exists. Nothing was changed.' };
    }
    const targetRes = await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    const target = targetRes.stdout.trim();
    if (targetRes.code !== 0 || !target) return { fail: `Could not resolve ${ref} on ${remote}.` };
    const count = async (range: string): Promise<number> => Number.parseInt((await this.git(['rev-list', '--count', range])).stdout.trim(), 10) || 0;
    const behind = await count(`${head}..${target}`);
    const ahead = await count(`${target}..${head}`);
    const relation = behind === 0 && ahead === 0 ? 'same' : ahead === 0 ? 'behind' : behind === 0 ? 'ahead' : 'diverged';
    return { remote, ref, branch, head, target, relation, behind, ahead };
  }

  /** Why an update is refused for a target that is not a plain fast-forward. */
  localCommitsFailure(t: Target): Failure {
    return {
      fail:
        t.relation === 'ahead'
          ? `${this.d.installDir} has ${plural(t.ahead, 'local commit')} that ${t.remote}/${t.ref} does not have; leaving it alone.`
          : `${this.d.installDir} has diverged from ${t.remote}/${t.ref} (${plural(t.ahead, 'local commit')}, ${t.behind} new upstream); leaving it alone.`,
      hint: `This looks like a development checkout. Update it with git yourself (git -C ${this.d.installDir} pull --ff-only, or rebase your commits), or use a separate install for daily use.`,
    };
  }

  async changelogHeadings(rev: string | null): Promise<string[]> {
    const text = rev === null ? this.d.readText(join(this.d.installDir, 'CHANGELOG.md')) : (await this.git(['show', `${rev}:CHANGELOG.md`])).stdout;
    return (text ?? '')
      .split('\n')
      .filter((l) => /^#{2,3} \S/.test(l))
      .map((l) => l.replace(/^#+ /, '').trim());
  }

  async newHeadings(before: string | null, after: string | null): Promise<void> {
    const had = new Set(await this.changelogHeadings(before));
    const added = (await this.changelogHeadings(after)).filter((h) => !had.has(h));
    if (added.length) this.out(`  New in CHANGELOG.md: ${added.slice(0, 12).join('; ')}${added.length > 12 ? '; ...' : ''}\n`);
  }

  async report(t: Target): Promise<void> {
    const shown = await this.git(['show', `${t.target}:package.json`]);
    let latest = '?';
    try {
      latest = (JSON.parse(shown.stdout) as { version?: string }).version ?? '?';
    } catch {
      /* unreadable: show ? */
    }
    this.out(`  Current: ${this.version()} (${short(t.head)})\n  Latest:  ${latest} (${short(t.target)}) on ${t.remote}/${t.ref}\n`);
    if (t.relation !== 'behind') return;
    this.out(`  ${plural(t.behind, 'commit')} behind:\n`);
    const log = await this.git(['log', '--format=%h %s', `-n${MAX_SUBJECTS}`, `${t.head}..${t.target}`]);
    for (const line of log.stdout.split('\n').filter(Boolean)) this.out(`    ${this.s.muted(line.slice(0, 7))}${line.slice(7)}\n`);
    if (t.behind > MAX_SUBJECTS) this.out(`    ... and ${t.behind - MAX_SUBJECTS} more\n`);
    await this.newHeadings(null, t.target);
  }

  npmCi = (): Promise<CommandResult> =>
    this.d.run(['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'], { cwd: this.d.installDir, timeoutMs: 600_000 });

  /** Loads the code without a network, a model or secrets: `garnet --version` imports the whole CLI. */
  smoke = (): Promise<CommandResult> => this.node(['--version']);

  /** Moves the checkout back to `commit` (a checkout, never a hard reset) and restores dependencies when asked. */
  async rollback(commit: string, branch: string | null, restoreDeps: boolean): Promise<{ restored: boolean; lines: string[] }> {
    const lines: string[] = [];
    const back = await this.git(branch ? ['checkout', '--quiet', '-B', branch, commit] : ['checkout', '--quiet', commit]);
    if (back.code !== 0) {
      lines.push(`Could not move the checkout back to ${short(commit)}: ${firstLines(back.stderr, 3)}`);
      lines.push(`Do it by hand: git -C ${this.d.installDir} ${branch ? `checkout -B ${branch} ${commit}` : `checkout ${commit}`}`);
      return { restored: false, lines };
    }
    lines.push(`Restored the checkout to ${short(commit)}.`);
    if (restoreDeps) {
      const npm = await this.npmCi();
      lines.push(npm.code === 0 ? 'Restored the previous dependencies (npm ci).' : `Could not restore dependencies: run \`npm ci --omit=dev\` in ${this.d.installDir}. ${firstLines(npm.stderr, 3)}`);
    }
    const smoke = await this.smoke();
    lines.push(smoke.code === 0 ? 'The previous version loads again.' : `The previous version does not load either: ${firstLines(smoke.stderr, 3)}`);
    return { restored: true, lines };
  }

  async run(args: string[]): Promise<number> {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: false,
        options: { check: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, ref: { type: 'string' }, reinstall: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      });
    } catch (e) {
      this.err(`${errorMessage(e)}\n\n${UPDATE_USAGE}`);
      return 2;
    }
    const v = parsed.values;
    if (v.help) {
      this.out(UPDATE_USAGE);
      return 0;
    }
    if (v.ref !== undefined && !REF_RE.test(v.ref)) {
      this.err(`--ref must be a branch or tag name (letters, digits, . _ - /), got ${JSON.stringify(v.ref)}.\n`);
      return 2;
    }
    if (v.check && (v.yes || v.reinstall)) {
      this.err(`--check only looks; it cannot be combined with --yes or --reinstall.\n`);
      return 2;
    }

    const refuse = (f: Failure): number => {
      this.bad(f.fail);
      if (f.hint) this.err(`    ${f.hint}\n`);
      return 1;
    };

    const pre = await this.preflight();
    if (pre) {
      // A check may still look at a modified checkout; a missing checkout cannot be looked at.
      if (!v.check || !this.d.exists(join(this.d.installDir, '.git'))) return refuse(pre);
      this.warn(`${pre.fail} An update would be refused until that is resolved.`);
    }

    if (v.check) {
      this.step('Checking for updates');
      const t = await this.resolveTarget(v.ref);
      if ('fail' in t) return refuse(t);
      await this.report(t);
      if (t.relation === 'same') {
        this.ok('Up to date.');
        return 0;
      }
      if (t.relation !== 'behind') return refuse(this.localCommitsFailure(t));
      this.out(`\n  An update is available. Run: garnet update\n`);
      return UPDATE_AVAILABLE;
    }

    const lock = this.d.acquireLock();
    if ('heldBy' in lock) {
      return refuse({
        fail: `Another garnet update is already running${lock.heldBy ? ` (pid ${lock.heldBy})` : ''}.`,
        hint: 'Wait for it to finish. If it is gone, delete .git/garnet-update.lock in the install directory.',
      });
    }
    try {
      return await this.update(v, refuse);
    } finally {
      lock.release();
    }
  }

  async update(v: Flags, refuse: (f: Failure) => number): Promise<number> {
    this.step('Looking for updates');
    const t = await this.resolveTarget(v.ref);
    if ('fail' in t) return refuse(t);
    await this.report(t);
    if (t.relation === 'same') {
      this.ok(`Already up to date (${short(t.head)}).`);
      return 0;
    }
    if (t.relation !== 'behind') return refuse(this.localCommitsFailure(t));

    if (!v.yes && !(await this.d.confirm(`\nUpdate ${short(t.head)} -> ${short(t.target)} (${plural(t.behind, 'commit')})?`))) {
      this.out(`Not updated. Nothing was changed.${process.stdin.isTTY ? '' : ' (No terminal to ask on: pass -y to update without asking.)'}\n`);
      return 1;
    }

    const oldVersion = this.version();
    const depFiles = await this.git(['diff', '--name-only', t.head, t.target, '--', 'package.json', 'package-lock.json']);
    const depsChanged = depFiles.code === 0 && depFiles.stdout.trim().length > 0;

    this.step(`Updating ${short(t.head)} -> ${short(t.target)}`);
    let installAttempted = false;
    const failAndRollback = async (what: string, detail: string): Promise<number> => {
      this.bad(`${what}${detail ? `\n    ${detail}` : ''}`);
      this.step('Rolling back');
      const { restored, lines } = await this.rollback(t.head, t.branch, installAttempted);
      for (const l of lines) this.out(`  ${l}\n`);
      this.err(
        `${restored ? `The update failed and was rolled back: version ${oldVersion} (${short(t.head)}) is still in place.` : 'The update failed and could not be rolled back automatically; see above.'} Your data was not touched.\n`,
      );
      return 1;
    };

    const merged = await this.git(['merge', '--ff-only', '--quiet', t.target]);
    if (merged.code !== 0) return await failAndRollback('Could not fast-forward the checkout.', firstLines(merged.stderr, 4));
    this.ok('Code updated');

    if (depsChanged || v.reinstall) {
      installAttempted = true;
      this.out(`  ${depsChanged ? 'Dependencies changed' : 'Reinstalling dependencies'}: npm ci --omit=dev ...\n`);
      const npm = await this.npmCi();
      if (npm.code !== 0) return await failAndRollback('npm ci failed.', firstLines(npm.stderr || npm.stdout, 6));
      this.ok('Dependencies installed');
    } else {
      this.ok('Dependencies unchanged');
    }

    const smoke = await this.smoke();
    if (smoke.code !== 0) return await failAndRollback('The new version does not start.', firstLines(smoke.stderr || smoke.stdout, 6));
    this.ok(`The new version loads (${smoke.stdout.trim().split('\n')[0] ?? ''})`);

    // The update has succeeded. Everything below is advice and never changes the result.
    this.step('Checking your config with the new version');
    const cfg = await this.node(['config', 'check']);
    const configOk = cfg.code === 0;
    if (configOk) this.ok(firstLines(cfg.stdout, 1) || 'Config OK');
    else this.warn(`Your config has problems with the new version (the update itself succeeded):\n    ${firstLines(cfg.stderr || cfg.stdout, 8)}\n    See \`garnet config check\` and \`garnet config explain\`.`);
    await this.service(configOk, v);
    this.shim();

    const count = Number.parseInt((await this.git(['rev-list', '--count', `${t.head}..${t.target}`])).stdout.trim(), 10) || t.behind;
    this.out(`\n${this.s.accent('◆ Garnet updated.')} ${oldVersion} (${short(t.head)}) -> ${this.version()} (${short(t.target)}), ${plural(count, 'commit')}.\n`);
    await this.newHeadings(t.head, null);
    this.out(`  Run \`garnet doctor\` to check the install and your setup.\n`);
    return 0;
  }

  /**
   * Restarts (or reinstalls, when the unit would change) the background service that runs this GARNET_HOME.
   * The service is not stopped while the checkout moves: it keeps running the code it already loaded.
   */
  async service(configOk: boolean, v: Flags): Promise<void> {
    const opts = { platform: this.d.platform, home: this.d.home, userHome: this.d.userHome, nodePath: this.d.nodePath, entry: this.entry() };
    const deps = { list: this.d.list, read: (p: string) => this.d.readText(p) ?? '' };
    if (!installedServices(opts, deps).some((s) => s.home === this.d.home)) return;
    let resolved;
    try {
      resolved = resolveService(opts, deps);
    } catch {
      return;
    }
    if ('unsupported' in resolved || resolved.conflict) return;
    const { plan } = resolved;
    this.step('Background service');
    if (!configOk) {
      this.warn(`The service (${plan.path}) was NOT restarted because the config is invalid; it still runs the old code. Fix the config, then: garnet service restart`);
      return;
    }
    // The unit comes from the NEW code's template: ask the new version what it would write.
    const show = await this.node(['service', 'show']);
    const wanted = show.code === 0 ? show.stdout.split('\n').slice(1).join('\n').trimEnd() : null;
    const reinstall = wanted !== null && wanted !== (this.d.readText(plan.path) ?? '').trimEnd();
    this.out('  The service keeps running the old code until restarted. Restarting takes it down briefly (up to ~45 s while it finishes work).\n');
    const question = reinstall ? 'Reinstall the service (its unit file changes in this version) and restart it?' : 'Restart the service so it runs the new code?';
    if (!v.yes && !(await this.d.confirm(`  ${question}`))) {
      this.out(`  Left running on the old code. When ready: ${reinstall ? 'garnet service install' : 'garnet service restart'}\n`);
      return;
    }
    if (reinstall) {
      const r = await this.node(['service', 'install']);
      if (r.code === 0) this.ok('Service reinstalled and restarted');
      else this.warn(`Reinstalling the service failed: ${firstLines(r.stderr || r.stdout, 4)}\n    Try: garnet service install`);
      return;
    }
    const r = await restartService(plan, { run: (cmd) => this.d.run(cmd) });
    const failed = r.commands.find((c) => c.code !== 0);
    if (r.ok && !failed) this.ok('Service restarted');
    else this.warn(`Restarting the service failed${failed ? ` (${failed.cmd.join(' ')}: ${firstLines(failed.stderr, 2)})` : ''}. Try: garnet service restart`);
  }

  /** Reports (never rewrites) a missing shim or one that points at another install. */
  shim(): void {
    const dir = this.d.env.GARNET_BIN_DIR || join(this.d.userHome, '.local', 'bin');
    const name = this.d.env.GARNET_COMMAND_NAME || 'garnet';
    const path = join(dir, name);
    const text = this.d.readText(path);
    if (text === null) this.warn(`No \`${name}\` command found at ${path}. Fine if you put it elsewhere; otherwise re-run install.sh to recreate it.`);
    else if (!text.includes(this.entry())) this.warn(`${path} does not point at this install (${this.entry()}). Re-run install.sh with the same --dir to fix it.`);
  }
}

/** `garnet update`. Returns the exit code: 0, 1 (refused or failed), 2 (usage) or UPDATE_AVAILABLE with --check. */
export async function update(args: string[], io: Io, deps: UpdateDeps = realUpdateDeps()): Promise<number> {
  try {
    return await new Updater(deps, io).run(args);
  } catch (e) {
    io.err(`garnet update failed unexpectedly: ${errorMessage(e)}\n`);
    return 1;
  }
}
