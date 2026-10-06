// Admin commands: start, pair, api, service.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { writeConfig } from '../config/index.ts';
import { RubyError } from '../contracts/index.ts';
import { approvePairing, ChatDirectory, SCOPES, type Scope } from '../gateway/index.ts';
import { describeNext, describeSchedule, describeTime, parseWhen, WHEN_HELP } from '../scheduler/index.ts';
import { buildService, createRuby, startService, VERSION } from '../main.ts';
import { validSenderId } from '../migrate/index.ts';
import { defaultEntry, installedServices, installService, resolveService, restartService, serviceStatus, uninstallService, type ServiceResult } from '../service/index.ts';
import type { Io } from './main.ts';

export async function start(io: Io): Promise<number> {
  const log = (level: string, message: string) => io.err(`${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`);
  const ruby = createRuby();
  try {
    const service = await startService(ruby, log);
    log('info', `Ruby ${VERSION} running (model ${ruby.model.id}). Ctrl+C or SIGTERM to stop.`);
    await new Promise<void>((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    log('info', 'Shutting down: finishing running tasks…');
    await service.stop();
    log('info', 'Stopped.');
    return 0;
  } finally {
    ruby.close();
  }
}

export function pair(args: string[], io: Io): number {
  const [sub = 'list', ...rest] = args;
  const ruby = createRuby({ noModel: true });
  try {
    const store = ruby.gatewayStore;
    if (sub === 'list') {
      const pending = store.pairings(new Date().toISOString());
      const owners = store.identities();
      io.out(pending.length ? 'Pending requests:\n' : 'No pending pairing requests.\n');
      for (const p of pending) io.out(`  ${p.code}  ${p.channel} ${p.senderName ?? ''} (${p.senderId}), expires ${p.expiresAt}\n`);
      io.out(owners.length ? 'Paired:\n' : 'No paired identities yet. Message your bot to get a code.\n');
      for (const o of owners) io.out(`  ${o.channel} ${o.displayName ?? ''} (${o.senderId}) since ${o.createdAt}\n`);
      return 0;
    }
    if (sub === 'approve' && rest[0]) {
      const p = approvePairing(store, rest[0]);
      if (!p) {
        io.err('No pending request with that code (it may have expired). Run `ruby pair list`.\n');
        return 1;
      }
      io.out(`Paired ${p.channel} ${p.senderName ?? ''} (${p.senderId}). They'll get a greeting from the running service.\n`);
      return 0;
    }
    if (sub === 'revoke' && rest[0] && rest[1]) {
      const ok = store.removeIdentity(rest[0], rest[1]);
      io.out(ok ? `Revoked ${rest[0]} ${rest[1]}.\n` : 'No such identity.\n');
      return ok ? 0 : 1;
    }
    if (sub === 'add') return pairAdd(rest, ruby, io);
    io.err(PAIR_USAGE);
    return 2;
  } finally {
    ruby.close();
  }
}

const PAIR_USAGE = 'Usage: ruby pair list | approve <code> | add <channel> <senderId> [--name <name>] | revoke <channel> <senderId>\n';
const PAIR_CHANNELS = ['telegram', 'discord', 'signal'] as const;
const ID_HELP: Record<(typeof PAIR_CHANNELS)[number], string> = {
  telegram: 'a numeric Telegram user ID (message @userinfobot to find it; @usernames are not stable IDs)',
  discord: 'a Discord user ID (a 17-20 digit number: Developer Mode, then "Copy User ID")',
  signal: 'a phone number in +E164 form or the Signal account UUID',
};

/**
 * `ruby pair add <channel> <senderId>`: pairs someone without the code round trip (for people you
 * already know, e.g. from your old assistant's allowlist). A paired identity is an owner: it can
 * talk to Ruby and approve actions.
 */
function pairAdd(args: string[], ruby: ReturnType<typeof createRuby>, io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } });
  } catch (e) {
    io.err(`${(e as Error).message}\n${PAIR_USAGE}`);
    return 2;
  }
  const [channel, raw, extra] = parsed.positionals;
  if (!channel || !raw || extra !== undefined) {
    io.err(PAIR_USAGE);
    return 2;
  }
  if (!(PAIR_CHANNELS as readonly string[]).includes(channel)) {
    io.err(`Unknown channel "${channel}": use ${PAIR_CHANNELS.join(', ')}.\n`);
    return 2;
  }
  const c = channel as (typeof PAIR_CHANNELS)[number];
  const senderId = validSenderId(c, raw);
  if (!senderId) {
    io.err(`"${raw}" is not ${ID_HELP[c]}.\n`);
    return 2;
  }
  const name = parsed.values.name?.trim() || null;
  if (name && (name.length > 80 || /[\u0000-\u001f]/.test(name))) {
    io.err('--name must be one line of at most 80 characters.\n');
    return 2;
  }
  const store = ruby.gatewayStore;
  if (store.identity(c, senderId)) {
    io.out(`${c} ${senderId} is already paired.\n`);
    return 0;
  }
  store.addIdentity(c, senderId, name);
  io.out(`Paired ${c} ${name ? `${name} ` : ''}(${senderId}). They are an owner now: they can message Ruby and approve its actions.\n`);
  if (!ruby.config.channels[c].enabled) io.out(`Note: the ${c} channel is not enabled yet (\`ruby setup\`).\n`);
  if (c === 'signal' && senderId.startsWith('+')) io.out('Note: signal-cli usually reports senders by UUID; if messages from this number are not recognized, pair the UUID instead (it shows in `ruby pair list` after they message the bot).\n');
  return 0;
}

export function api(args: string[], io: Io): number {
  const [sub = 'status', ...rest] = args;
  const ruby = createRuby({ noModel: true });
  try {
    const { config, paths, keys } = ruby;
    if (sub === 'status') {
      io.out(`API ${config.api.enabled ? 'enabled' : 'disabled'} on ${config.api.host}:${config.api.port}; ${keys.activeCount()} active key(s).\n`);
      return 0;
    }
    if (sub === 'enable' || sub === 'disable') {
      writeConfig(paths.home, { ...config, api: { ...config.api, enabled: sub === 'enable' } });
      io.out(`API ${sub}d. Restart Ruby to apply.${sub === 'enable' && keys.activeCount() === 0 ? ' Create a key with `ruby api key create --name <name>`.' : ''}\n`);
      return 0;
    }
    if (sub === 'key') return apiKey(rest, ruby.keys, io);
    io.err('Usage: ruby api status | enable | disable | key create|list|revoke\n');
    return 2;
  } finally {
    ruby.close();
  }
}

function apiKey(args: string[], keys: ReturnType<typeof createRuby>['keys'], io: Io): number {
  const [sub = 'list', ...rest] = args;
  if (sub === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: 'string' }, scopes: { type: 'string', default: 'chat' }, 'expires-days': { type: 'string' } },
    });
    if (!values.name) throw new RubyError('invalid_input', 'Usage: ruby api key create --name <name> [--scopes chat,read,admin] [--expires-days N]');
    const scopes = values.scopes.split(',').map((s) => s.trim()) as Scope[];
    const days = values['expires-days'] ? Number(values['expires-days']) : undefined;
    if (days !== undefined && !(days > 0)) throw new RubyError('invalid_input', '--expires-days must be a positive number.');
    const created = keys.create(values.name, scopes, days);
    io.out(`Created key "${created.name}" (${created.id}) with scopes ${created.scopes.join(', ')}${created.expiresAt ? `, expires ${created.expiresAt}` : ''}.\n\n  ${created.key}\n\nStore it now: it will not be shown again.\n`);
    return 0;
  }
  if (sub === 'list') {
    const rows = keys.list();
    if (!rows.length) io.out(`No keys. Scopes available: ${SCOPES.join(', ')}.\n`);
    for (const k of rows) {
      const state = k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= new Date().toISOString() ? 'expired' : 'active';
      io.out(`${k.id}  ${state.padEnd(7)}  ${k.scopes.join(',').padEnd(15)}  ${k.name}  last used ${k.lastUsedAt ?? 'never'}\n`);
    }
    return 0;
  }
  if (sub === 'revoke' && rest[0]) {
    const ok = keys.revoke(rest[0]);
    io.out(ok ? `Revoked ${rest[0]}.\n` : 'No active key with that ID.\n');
    return ok ? 0 : 1;
  }
  io.err('Usage: ruby api key create --name <name> [--scopes chat,read,admin] [--expires-days N] | list | revoke <id>\n');
  return 2;
}

const SERVICE_USAGE = `Usage: ruby service install | uninstall | status | restart | show | list [--name <name>] [--force]
  --name <name>   Instance name, so several Ruby homes (RUBY_HOME) can run side by side:
                  ruby-<name>.service / dev.ruby.agent.<name>. Without it, the service already
                  installed for this RUBY_HOME is used, else the default ruby.service.
  --force         install: take over a service file that runs another RUBY_HOME
`;

export async function service(args: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' }, force: { type: 'boolean' } } });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${SERVICE_USAGE}`);
    return 2;
  }
  const [sub = 'status', extra] = parsed.positionals;
  if (extra !== undefined) {
    io.err(SERVICE_USAGE);
    return 2;
  }
  const ruby = createRuby({ noModel: true });
  const home = ruby.paths.home;
  ruby.close();
  const opts = { platform: process.platform, home, userHome: homedir(), nodePath: process.execPath, entry: defaultEntry(), name: parsed.values.name };
  if (sub === 'list') {
    const all = installedServices(opts);
    if (!all.length) io.out('No Ruby services installed.\n');
    for (const s of all) io.out(`${(s.name ?? '(default)').padEnd(16)} ${s.home ?? '?'}${s.home === home ? '  <- this RUBY_HOME' : ''}\n  ${s.path}\n`);
    return 0;
  }
  let resolved;
  try {
    resolved = resolveService(opts);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return 2;
  }
  if ('unsupported' in resolved) {
    io.err(`${resolved.unsupported}\n`);
    return 1;
  }
  const { plan, conflict } = resolved;
  if (sub === 'show') {
    io.out(`# ${plan.path}\n${plan.contents}\n`);
    return 0;
  }
  const run = { install: installService, uninstall: uninstallService, status: serviceStatus, restart: restartService }[sub as 'install' | 'uninstall' | 'status' | 'restart'];
  if (!run) {
    io.err(SERVICE_USAGE);
    return 2;
  }
  if (conflict && sub === 'install' && !parsed.values.force) {
    io.err(`Not installed: ${conflict}\n(Or pass --force to point that service at this RUBY_HOME instead.)\n`);
    return 1;
  }
  if (conflict && sub !== 'install') {
    io.err(`${conflict}\n`);
    return 1;
  }
  const result: ServiceResult = await run(plan);
  for (const f of result.files) io.out(`  file: ${f}\n`);
  for (const c of result.commands) io.out(`  $ ${c.cmd.join(' ')}  → exit ${c.code}${c.stderr.trim() ? `\n    ${c.stderr.trim()}` : ''}${sub === 'status' && c.stdout.trim() ? `\n${c.stdout.trim()}` : ''}\n`);
  for (const n of result.notes) io.out(`  note: ${n}\n`);
  return result.ok ? 0 : 1;
}

const JOBS_USAGE = `Usage:
  ruby jobs [list]                 Every job: config.json, created in chat, or added here
  ruby jobs show <id>              One job in full, with recent runs
  ruby jobs history <id>           Recent runs
  ruby jobs run <id>               Run now (results go to the job's chat via the running service)
  ruby jobs pause|resume <id>      Stop or restart scheduling (any job)
  ruby jobs delete <id>            Delete a job created in chat or here (config.json jobs: edit the file)
  ruby jobs edit <id> [--when "<schedule>"] [--message <text> | --instructions <text>]
  ruby jobs add --when "<schedule>" (--message <text> | --instructions <text> | --command <cmd>)
                [--name <id>] [--to <channel|channel:id>] [--only-changes]
Schedules: ${WHEN_HELP}
`;

export async function jobs(args: string[], io: Io): Promise<number> {
  const [sub = 'list', ...rest] = args;
  if (sub === 'help' || sub === '--help') {
    io.out(JOBS_USAGE);
    return 0;
  }
  const ruby = createRuby({ noModel: sub !== 'run' });
  const usage = (code = 2) => {
    io.err(JOBS_USAGE);
    return code;
  };
  try {
    const { config, jobStore, jobBook, directory } = ruby;
    const now = new Date();
    const label = (n: { channel: string; account: string; chatId: string }) => {
      const known = directory.chats().find((c) => c.channel === n.channel && c.chatId === n.chatId);
      return ChatDirectory.label(known ?? { ...n, senderId: null, name: null });
    };
    if (sub === 'list') {
      const entries = jobBook.list();
      if (!entries.length) io.out('No jobs. Ask Ruby in chat ("remind me at 5pm to …"), use `ruby jobs add`, or add them under "jobs" in config.json.\n');
      if (!config.scheduler.enabled) io.out('The scheduler is switched off (scheduler.enabled = false).\n');
      for (const e of entries) {
        const status = !e.job.enabled ? 'disabled' : e.state.paused ? 'PAUSED' : e.done ? 'done' : 'enabled';
        const from = e.origin.by === 'config' ? 'config' : e.origin.by === 'agent' ? 'chat' : e.origin.via;
        const next = e.next ? `next ${describeNext(e.next, e.zone, now)}` : '';
        io.out(`${e.job.id.padEnd(22)} ${status.padEnd(8)} ${from.padEnd(9)} ${describeSchedule(e.job, e.zone, now)}${next ? `  · ${next}` : ''}${e.lastRun ? `  · last: ${e.lastRun.status}` : ''}\n`);
      }
      for (const p of jobBook.problems()) io.out(`! ${p.id}: ${p.problem}\n`);
      if (entries.length) io.out(`Times are in ${ruby.timezone}.\n`);
      return 0;
    }
    if (sub === 'add') {
      const { values } = parseArgs({
        args: rest,
        options: {
          when: { type: 'string' },
          message: { type: 'string' },
          instructions: { type: 'string' },
          command: { type: 'string' },
          name: { type: 'string' },
          to: { type: 'string' },
          'only-changes': { type: 'boolean' },
        },
      });
      const actions = [values.message, values.instructions, values.command].filter((v) => v !== undefined);
      if (!values.when || actions.length !== 1) return usage();
      const when = parseWhen(values.when, { now, zone: ruby.timezone });
      let notify: { channel: string; account: string; chatId: string } | undefined;
      try {
        const t = directory.resolve(values.to ?? 'owner', '');
        notify = { channel: t.channel, account: t.account, chatId: t.chatId };
      } catch (e) {
        if (values.to || !values.instructions) throw e;
      }
      const entry = jobBook.create(
        {
          id: jobBook.freeId(values.name ?? actions[0]!.split(/\s+/).slice(0, 4).join(' ')),
          ...(when.kind === 'once' ? { kind: 'once', at: when.at.toISOString() } : when.kind === 'heartbeat' ? { kind: 'heartbeat', everyMinutes: when.everyMinutes } : { kind: 'cron', cron: when.cron }),
          ...(values.message !== undefined ? { message: values.message } : {}),
          ...(values.instructions !== undefined ? { instructions: values.instructions } : {}),
          ...(values.command !== undefined ? { script: { command: values.command } } : {}),
          notifyWhen: values['only-changes'] ? 'on_change' : 'always',
          ...(notify ? { notify } : {}),
        },
        { by: 'owner', via: 'cli', at: now.toISOString() },
      );
      if (values.command !== undefined && config.permissions.exec === 'deny') io.err('Note: exec is deny in config.json, so this script job will fail until you allow it.\n');
      io.out(`Added ${entry.job.id}: ${describeSchedule(entry.job, entry.zone, now)}${entry.next ? `, next ${describeNext(entry.next, entry.zone, now)}` : ''}${entry.job.notify ? ` → ${label(entry.job.notify)}` : ' (results kept in history only)'}.\n`);
      return 0;
    }
    const id = rest[0];
    const found = id ? jobBook.find(id) : undefined;
    if (!found) {
      if (!id) return usage();
      io.err(`No job "${id}". Run \`ruby jobs list\`.\n`);
      return 1;
    }
    const job = found.job;
    if (sub === 'show') {
      const e = jobBook.entry(job, found.origin);
      const origin =
        e.origin.by === 'config' ? 'config.json' : e.origin.by === 'agent' ? `created by Ruby in chat${e.origin.conversation ? ` (${e.origin.conversation})` : ''}, ${describeTime(new Date(e.origin.at), e.zone, now)}` : `added from the ${e.origin.via}, ${describeTime(new Date(e.origin.at), e.zone, now)}`;
      const what = job.message !== undefined ? `message: ${job.message}` : job.script ? `script: ${job.script.command}` : `instructions: ${job.instructions}`;
      io.out(`${job.id}\n  from:      ${origin}\n  schedule:  ${describeSchedule(job, e.zone, now)} (${e.zone})\n  next:      ${e.next ? describeNext(e.next, e.zone, now) : e.done ? 'done' : e.state.paused ? 'paused' : 'none'}\n  ${what}\n  sends to:  ${job.notify ? label(job.notify) : 'nowhere (history only)'}${job.notifyWhen === 'on_change' ? ', only when there is something new' : ''}\n`);
      for (const r of jobStore.runs(job.id, 5)) io.out(`  ${r.startedAt}  ${r.status.padEnd(18)} ${r.note ?? ''}\n`);
      return 0;
    }
    if (sub === 'history') {
      for (const r of jobStore.runs(job.id)) io.out(`${r.startedAt}  ${r.status.padEnd(20)} ${String(r.tokens).padStart(7)} tok  ${r.note ?? ''}\n`);
      return 0;
    }
    if (sub === 'resume' || sub === 'pause') {
      const e = sub === 'pause' ? jobBook.pause(job.id) : jobBook.resume(job.id);
      io.out(`${sub === 'pause' ? 'Paused' : 'Resumed'} ${job.id}.${e.next ? ` Next run ${describeNext(e.next, e.zone, now)}.` : ''}\n`);
      return 0;
    }
    if (sub === 'delete') {
      jobBook.remove(job.id);
      io.out(`Deleted ${job.id} (its run history is kept). A run in progress stops at the service's next check.\n`);
      return 0;
    }
    if (sub === 'edit') {
      const { values } = parseArgs({ args: rest.slice(1), options: { when: { type: 'string' }, message: { type: 'string' }, instructions: { type: 'string' } } });
      const patch: Record<string, unknown> = {};
      if (values.when) {
        const w = parseWhen(values.when, { now, zone: jobBook.zoneOf(job) });
        Object.assign(patch, w.kind === 'once' ? { kind: 'once', at: w.at.toISOString() } : w.kind === 'heartbeat' ? { kind: 'heartbeat', everyMinutes: w.everyMinutes } : { kind: 'cron', cron: w.cron });
      }
      if (values.message !== undefined) patch.message = values.message;
      if (values.instructions !== undefined) patch.instructions = values.instructions;
      if (!Object.keys(patch).length) return usage();
      const e = jobBook.update(job.id, patch, 'owner');
      io.out(`Updated ${job.id}: ${describeSchedule(e.job, e.zone, now)}${e.next ? `, next ${describeNext(e.next, e.zone, now)}` : ''}.\n`);
      return 0;
    }
    if (sub === 'run') {
      // Runs in this process; any notification is queued for the running service to deliver.
      const log = (level: string, message: string) => io.err(`${level}: ${message}\n`);
      const { scheduler } = buildService(ruby, log, [], false);
      await scheduler.runNow(job.id);
      const r = jobStore.runs(job.id, 1)[0];
      io.out(`Ran ${job.id}: ${r?.status ?? 'unknown'}${r?.note ? ` (${r.note})` : ''}, ${r?.tokens ?? 0} tokens.\n`);
      return 0;
    }
    return usage();
  } finally {
    ruby.close();
  }
}

export const LOGIN_LINK_MINUTES = 15;

/** The dashboard's address as a browser should open it (wildcard binds become loopback; IPv6 gets brackets). */
export function dashboardUrl(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  return `http://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${port}/`;
}

export function dashboard(io: Io): number {
  const ruby = createRuby({ noModel: true });
  try {
    const { config, paths, keys } = ruby;
    if (!config.api.enabled || !config.dashboard.enabled) {
      writeConfig(paths.home, { ...config, api: { ...config.api, enabled: true }, dashboard: { enabled: true } });
      io.out('Enabled the API and dashboard in config.json (loopback only). Restart Ruby to apply.\n');
    }
    // A one-time login link: the dashboard trades this short-lived key for a session key on first
    // use and revokes it (dashboard/login.js). It travels in the URL fragment, which browsers never
    // send to the server or in a Referer; the exchange keeps it from staying useful in browser history.
    const created = keys.create(`dashboard login ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, ['admin'], LOGIN_LINK_MINUTES / 1440);
    io.out(`\nOpen this link within ${LOGIN_LINK_MINUTES} minutes. It works once; run \`ruby dashboard\` again for another:\n\n  ${dashboardUrl(config.api.host, config.api.port)}#login=${created.key}\n\n`);
    return 0;
  } finally {
    ruby.close();
  }
}
