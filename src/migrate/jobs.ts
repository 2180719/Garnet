// Maps scheduled jobs from Hermes (cron/jobs.json) and OpenClaw (automation rows in its state
// database) to Ruby jobs. Every imported job is DISABLED: the owner reviews and enables it.
// Anything that has no faithful Ruby equivalent is skipped with the reason, never approximated
// silently.
import { parseCron, validTimeZone, type JobConfig } from '../config/index.ts';
import { isRecord } from './json5.ts';
import type { JobAction } from './types.ts';

const INSTRUCTIONS_MAX = 4000;
const RUBY_CHANNELS = new Set(['telegram', 'discord', 'signal']);
const MIN_EVERY = 5;
const MAX_EVERY = 10_080;

export type DeliveryHints = {
  /** Home chat per platform (Hermes `<PLATFORM>_HOME_CHANNEL`), used for a bare `deliver: telegram`. */
  homeChannels: Record<string, string>;
  /** Owner DM per platform (OpenClaw `commands.ownerAllowFrom`), used for heartbeat target "owner". */
  ownerChats: Record<string, string>;
};

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Lowercase-hyphen id within Ruby's job id rules, unique against `taken`. */
export function jobId(prefix: string, name: string, taken: Set<string>): string {
  const slug =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'job';
  const base = `${prefix}-${slug}`.slice(0, 36).replace(/-+$/, '');
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function baseJob(id: string, instructions: string): JobConfig {
  return {
    id,
    enabled: false,
    kind: 'cron',
    instructions,
    permissions: {
      'fs.read': 'allow',
      'fs.write': 'deny',
      'net.fetch': 'deny',
      exec: 'deny',
      'message.send': 'deny',
      'memory.write': 'deny',
      'schedule.edit': 'deny',
    },
    budget: { maxTokensPerRun: 100_000, maxTokensPerDay: 500_000 },
    timeoutMinutes: 10,
    // Both predecessors deliver every run's output; keep that until the owner says otherwise.
    notifyWhen: 'always',
    catchUp: true,
  };
}

function clip(text: string, notes: string[]): string {
  if (text.length <= INSTRUCTIONS_MAX) return text;
  notes.push(`instructions shortened to ${INSTRUCTIONS_MAX} characters (the full text is archived)`);
  return `${text.slice(0, INSTRUCTIONS_MAX - 60).trimEnd()}\n[Shortened on import; the original is archived.]`;
}

/** A cron expression Ruby accepts, or null. `secondsFirst`: croner's 6-field form (OpenClaw); Hermes' croniter puts seconds last. */
function cronExpr(expr: string, secondsFirst: boolean, notes: string[]): string | null {
  const fields = expr.trim().split(/\s+/);
  let five = expr.trim();
  if (fields.length === 6) {
    const sec = secondsFirst ? fields[0] : fields[5];
    if (sec !== '0') return null;
    five = (secondsFirst ? fields.slice(1) : fields.slice(0, 5)).join(' ');
    notes.push('dropped the seconds field (Ruby schedules to the minute)');
  }
  try {
    parseCron(five);
    return five;
  } catch {
    return null;
  }
}

function everyToJob(job: JobConfig, minutes: number, notes: string[]): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'invalid interval';
  const m = Math.round(minutes);
  if (m < MIN_EVERY) return `runs every ${minutes} min; Ruby's shortest interval is ${MIN_EVERY} min`;
  if (m > MAX_EVERY) return `runs every ${minutes} min; Ruby's longest interval is ${MAX_EVERY} min (7 days): use a cron expression instead`;
  if (m !== minutes) notes.push(`interval rounded from ${minutes} to ${m} min`);
  job.kind = 'heartbeat';
  job.everyMinutes = m;
  return null;
}

function notifyFor(channel: string, chatId: string, account?: string): JobConfig['notify'] {
  return { channel, chatId, account: account || 'default' };
}

// ---- Hermes ----

/**
 * Hermes cron/jobs.json (cron/jobs.py): `{ jobs: [...] }` (a bare list or an id-keyed map also load).
 * Each job: name, prompt, skills[], schedule { kind: cron|interval|once, expr, minutes, run_at },
 * deliver ("local" | "origin" | "<platform>" | "<platform>:<chat>" | comma list), origin {platform, chat_id},
 * model, script, no_agent, enabled/state.
 */
export function hermesJobs(data: unknown, opts: { timezone: string | null; hints: DeliveryHints; taken: Set<string>; skillName: (s: string) => string | null }): JobAction[] {
  let jobs: unknown[] = [];
  if (Array.isArray(data)) jobs = data;
  else if (isRecord(data) && Array.isArray(data.jobs)) jobs = data.jobs;
  else if (isRecord(data) && isRecord(data.jobs)) jobs = Object.entries(data.jobs).map(([k, v]) => (isRecord(v) ? { id: k, ...v } : v));
  const out: JobAction[] = [];
  for (const raw of jobs) {
    if (!isRecord(raw)) continue;
    const label = str(raw.name).trim() || str(raw.id).trim() || 'unnamed job';
    const notes: string[] = [];
    const skip = (why: string) => out.push({ from: label, job: null, notes: [why] });
    if (raw.no_agent === true) {
      skip('script-only job (no_agent): Ruby jobs always run the model; recreate it as a system cron entry');
      continue;
    }
    const schedule = isRecord(raw.schedule) ? raw.schedule : {};
    const kind = str(schedule.kind);
    if (kind === 'once') {
      skip(`one-shot job (${str(schedule.run_at) || str(raw.schedule_display) || 'once'}): Ruby has no one-shot jobs yet`);
      continue;
    }
    const skills = (Array.isArray(raw.skills) ? raw.skills : raw.skill ? [raw.skill] : []).map(str).filter(Boolean);
    const prompt = str(raw.prompt).trim();
    const lines: string[] = [];
    if (skills.length) {
      const names = skills.map((s) => opts.skillName(s) ?? s);
      lines.push(`Use the skill${names.length > 1 ? 's' : ''} ${names.join(', ')} (call skill_view first).`);
    }
    if (prompt) lines.push(prompt);
    if (str(raw.script).trim()) {
      lines.push(`(Imported from Hermes: this job used to run the script ${str(raw.script).trim()} first and read its output. Ruby cannot do that step; ask the owner how to replace it.)`);
      notes.push('its pre-run script is not supported; the instructions say so');
    }
    if (!lines.length) {
      skip('no prompt or skills');
      continue;
    }
    const job = baseJob(jobId('hermes', label, opts.taken), clip(lines.join('\n\n'), notes));
    if (kind === 'cron') {
      const expr = cronExpr(str(schedule.expr), false, notes);
      if (!expr) {
        opts.taken.delete(job.id);
        skip(`cron expression "${str(schedule.expr)}" is not one Ruby understands`);
        continue;
      }
      job.cron = expr;
      if (opts.timezone) job.timezone = opts.timezone;
    } else if (kind === 'interval') {
      const why = everyToJob(job, Number(schedule.minutes), notes);
      if (why) {
        opts.taken.delete(job.id);
        skip(why);
        continue;
      }
    } else {
      opts.taken.delete(job.id);
      skip(`unknown schedule kind "${kind || '(none)'}"`);
      continue;
    }
    const target = hermesTarget(raw, opts.hints, notes);
    if (target) job.notify = target;
    if (str(raw.model)) notes.push(`per-job model "${str(raw.model)}" is not supported; it will use Ruby's model`);
    const wasOn = raw.enabled !== false && str(raw.state) !== 'paused' && !raw.paused_at;
    notes.push(wasOn ? 'was enabled in Hermes' : 'was paused in Hermes');
    out.push({ from: label, job, notes });
  }
  return out;
}

function hermesTarget(raw: Record<string, unknown>, hints: DeliveryHints, notes: string[]): JobConfig['notify'] | undefined {
  const deliver = str(raw.deliver).trim() || 'local';
  if (deliver === 'local') {
    notes.push('delivered nowhere in Hermes (local): results stay in Ruby run history');
    return undefined;
  }
  const parts = deliver.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part === 'origin') {
      const o = isRecord(raw.origin) ? raw.origin : {};
      const platform = str(o.platform).toLowerCase();
      const chat = str(o.chat_id);
      if (RUBY_CHANNELS.has(platform) && chat) return finish(notifyFor(platform, chat), parts, notes);
      continue;
    }
    const [platform, chat] = part.includes(':') ? [part.slice(0, part.indexOf(':')).toLowerCase(), part.slice(part.indexOf(':') + 1)] : [part.toLowerCase(), hints.homeChannels[part.toLowerCase()] ?? ''];
    if (RUBY_CHANNELS.has(platform!) && chat) return finish(notifyFor(platform!, chat), parts, notes);
  }
  notes.push(`delivery "${deliver}" has no Ruby equivalent (or no known chat ID): add notify to the job to get messages`);
  return undefined;
}

function finish(n: JobConfig['notify'], parts: string[], notes: string[]): JobConfig['notify'] {
  if (parts.length > 1) notes.push(`delivered to several targets in Hermes; Ruby notifies one (${n!.channel} ${n!.chatId})`);
  return n;
}

// ---- OpenClaw ----

export type OpenClawCronRow = { name: string; enabled: boolean; payloadKind: string; job: unknown; scratch: string | null };

/**
 * OpenClaw automation jobs (`cron_jobs.job_json` in state/openclaw.sqlite, the CronJob protocol shape):
 * schedule { kind: at|every|cron|on-exit|stream, everyMs, expr, tz }, payload { kind: agentTurn (message) |
 * systemEvent (text) | heartbeat | command | script }, delivery { mode: none|announce|webhook, channel, to, accountId }.
 * Heartbeat monitors take their checklist from the job's scratch.
 */
export function openclawJobs(rows: OpenClawCronRow[], opts: { hints: DeliveryHints; taken: Set<string> }): JobAction[] {
  const out: JobAction[] = [];
  for (const row of rows) {
    const j = isRecord(row.job) ? row.job : {};
    const label = row.name || str(j.name) || str(j.id) || 'unnamed job';
    const notes: string[] = [];
    const skip = (why: string) => out.push({ from: label, job: null, notes: [why] });
    const payload = isRecord(j.payload) ? j.payload : {};
    const pk = str(payload.kind) || row.payloadKind;
    let text = '';
    if (pk === 'agentTurn') text = str(payload.message).trim();
    else if (pk === 'systemEvent') text = str(payload.text).trim();
    else if (pk === 'heartbeat') {
      let scratch = (row.scratch ?? '').trim();
      if (scratch.includes('HEARTBEAT_OK')) {
        // OpenClaw's "nothing to say" token; Ruby's is NOTHING_TO_REPORT.
        scratch = scratch.replaceAll('HEARTBEAT_OK', 'NOTHING_TO_REPORT');
        notes.push('HEARTBEAT_OK replaced by NOTHING_TO_REPORT');
      }
      text = scratch
        ? `Heartbeat: go through this checklist (imported from OpenClaw) and report only what needs the owner's attention.\n\n${scratch}`
        : "Heartbeat: check whether anything needs the owner's attention.";
      notes.push(scratch ? 'heartbeat checklist taken from its monitor scratch' : 'heartbeat had no checklist (scratch)');
    } else {
      skip(`${pk || 'unknown'} payload: Ruby jobs run the model, not commands or scripts`);
      continue;
    }
    if (!text) {
      skip('empty payload');
      continue;
    }
    const s = isRecord(j.schedule) ? j.schedule : {};
    const sk = str(s.kind);
    if (sk === 'at') {
      skip(`one-shot job (at ${str(s.at)}): Ruby has no one-shot jobs yet`);
      continue;
    }
    if (sk !== 'cron' && sk !== 'every') {
      skip(`${sk || 'unknown'} schedule: Ruby supports cron times and fixed intervals only`);
      continue;
    }
    const job = baseJob(jobId(pk === 'heartbeat' ? 'openclaw-heartbeat' : 'openclaw', pk === 'heartbeat' ? label.replace(/^heartbeat\s*/i, '') : label, opts.taken), clip(text, notes));
    if (sk === 'cron') {
      const expr = cronExpr(str(s.expr), true, notes);
      if (!expr) {
        opts.taken.delete(job.id);
        skip(`cron expression "${str(s.expr)}" is not one Ruby understands`);
        continue;
      }
      job.cron = expr;
      const tz = str(s.tz);
      if (tz && validTimeZone(tz)) job.timezone = tz;
      else if (tz) notes.push(`unknown time zone "${tz}" dropped (the host zone is used)`);
    } else {
      const why = everyToJob(job, Number(s.everyMs) / 60_000, notes);
      if (why) {
        opts.taken.delete(job.id);
        skip(why);
        continue;
      }
    }
    if (isRecord(j.trigger)) notes.push('its condition script is not supported (Ruby checks are file_changed and url_changed)');
    if (isRecord(payload) && str(payload.model)) notes.push(`per-job model "${str(payload.model)}" is not supported`);
    const d = isRecord(j.delivery) ? j.delivery : null;
    const channel = str(d?.channel).toLowerCase();
    const to = str(d?.to).replace(/^(telegram|discord|signal):/i, '');
    if (d && str(d.mode) === 'announce' && RUBY_CHANNELS.has(channel) && to) job.notify = notifyFor(channel, to);
    else if (pk === 'heartbeat' && (!d || str(d.mode) !== 'none')) {
      const owner = Object.entries(opts.hints.ownerChats).find(([c]) => RUBY_CHANNELS.has(c));
      if (owner) job.notify = notifyFor(owner[0], owner[1]);
    }
    if (!job.notify && d && str(d.mode) !== 'none') notes.push(`delivery ${str(d.mode)}${channel ? ` to ${channel}` : ''} has no Ruby equivalent or no chat ID: add notify to the job`);
    if (pk === 'heartbeat') job.notifyWhen = 'on_change';
    notes.push(row.enabled ? 'was enabled in OpenClaw' : 'was disabled in OpenClaw');
    out.push({ from: label, job, notes });
  }
  return out;
}
