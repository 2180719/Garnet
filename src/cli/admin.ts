// Admin commands: start, pair, api, service.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { writeConfig } from '../config/index.ts';
import { RubyError } from '../contracts/index.ts';
import { approvePairing, SCOPES, type Scope } from '../gateway/index.ts';
import { buildService, createRuby, startService, VERSION } from '../main.ts';
import { defaultEntry, installService, planService, serviceStatus, uninstallService, type ServiceResult } from '../service/index.ts';
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
    io.err('Usage: ruby pair list | approve <code> | revoke <channel> <senderId>\n');
    return 2;
  } finally {
    ruby.close();
  }
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

export async function service(args: string[], io: Io): Promise<number> {
  const [sub = 'status'] = args;
  const ruby = createRuby({ noModel: true });
  const home = ruby.paths.home;
  ruby.close();
  const plan = planService({ platform: process.platform, home, userHome: homedir(), nodePath: process.execPath, entry: defaultEntry() });
  if ('unsupported' in plan) {
    io.err(`${plan.unsupported}\n`);
    return 1;
  }
  if (sub === 'show') {
    io.out(`# ${plan.path}\n${plan.contents}\n`);
    return 0;
  }
  const run = { install: installService, uninstall: uninstallService, status: serviceStatus }[sub as 'install' | 'uninstall' | 'status'];
  if (!run) {
    io.err('Usage: ruby service install | uninstall | status | show\n');
    return 2;
  }
  const result: ServiceResult = await run(plan);
  for (const f of result.files) io.out(`  file: ${f}\n`);
  for (const c of result.commands) io.out(`  $ ${c.cmd.join(' ')}  → exit ${c.code}${c.stderr.trim() ? `\n    ${c.stderr.trim()}` : ''}${sub === 'status' && c.stdout.trim() ? `\n${c.stdout.trim()}` : ''}\n`);
  for (const n of result.notes) io.out(`  note: ${n}\n`);
  return result.ok ? 0 : 1;
}

export async function jobs(args: string[], io: Io): Promise<number> {
  const [sub = 'list', id] = args;
  const ruby = createRuby({ noModel: sub !== 'run' });
  try {
    const { config, jobStore } = ruby;
    const job = id ? config.jobs.find((j) => j.id === id) : undefined;
    if (sub === 'list') {
      if (!config.jobs.length) io.out('No jobs. Add them under "jobs" in config.json (`ruby config explain` describes each field).\n');
      if (!config.scheduler.enabled) io.out('The scheduler is switched off (scheduler.enabled = false).\n');
      for (const j of config.jobs) {
        const state = jobStore.state(j.id);
        const last = jobStore.runs(j.id, 1)[0];
        const when = j.kind === 'cron' ? `cron "${j.cron}" ${j.timezone ?? ''}`.trim() : `every ${j.everyMinutes} min`;
        const status = !j.enabled ? 'disabled' : state.paused ? 'PAUSED' : 'enabled';
        io.out(`${j.id.padEnd(20)} ${status.padEnd(8)} ${when}${last ? `  · last: ${last.status} ${last.startedAt}` : ''}\n`);
      }
      return 0;
    }
    if (!job) {
      io.err(id ? `No job "${id}".\n` : 'Usage: ruby jobs list | history <id> | run <id> | resume <id>\n');
      return id ? 1 : 2;
    }
    if (sub === 'history') {
      for (const r of jobStore.runs(job.id)) io.out(`${r.startedAt}  ${r.status.padEnd(20)} ${String(r.tokens).padStart(7)} tok  ${r.note ?? ''}\n`);
      return 0;
    }
    if (sub === 'resume') {
      jobStore.saveState({ ...jobStore.state(job.id), paused: false, consecutiveFailures: 0 });
      io.out(`Resumed ${job.id}.\n`);
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
    io.err('Usage: ruby jobs list | history <id> | run <id> | resume <id>\n');
    return 2;
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
