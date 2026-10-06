import { z } from 'zod';
import { validTimeZone, type JobConfig } from '../config/index.ts';
import { GarnetError, type Capability, type ToolContext, type ToolDefinition } from '../contracts/index.ts';
import type { JobBook, JobEntry, JobOrigin } from './book.ts';
import { describeDistance, describeNext, describeSchedule, describeTime, parseWhen } from './when.ts';

/** A chat a job can deliver to (resolved by the gateway's chat directory). */
export type DeliveryTarget = { channel: string; account: string; chatId: string; label: string };

export type ScheduleToolDeps = {
  book: JobBook;
  /** The session's conversation (for provenance) and whether it is a job's own session. */
  originOf: (sessionId: string) => { conversation: string | null; isJob: boolean; chat: DeliveryTarget | null };
  /** Resolves `to` like send_message: omitted means this chat, else the owner's latest chat. Throws when there is none. */
  resolveTarget: (to: string | undefined, sessionId: string) => DeliveryTarget;
  /** Label for a stored notify target, e.g. "telegram (Ada)". */
  labelOf: (notify: { channel: string; account: string; chatId: string }) => string;
  now?: () => Date;
};

const GRANTABLE = ['fs.write', 'net.fetch', 'exec', 'message.send', 'memory.write'] as const;

const input = z.object({
  action: z.enum(['create', 'list', 'update', 'pause', 'resume', 'delete']).describe('What to do.'),
  id: z.string().max(40).optional().describe('Job id (update, pause, resume, delete).'),
  when: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Schedule in the owner\'s time zone: "in 20 minutes", "at 17:30", "tomorrow at 9am", "friday 18:00", "2026-12-24 09:00", "every 30 minutes", "every day at 8am", "every weekday at 9:15", "every mon,thu at 19:00", or cron "0 9 * * 1-5".',
    ),
  name: z.string().max(60).optional().describe('Short name for a new job; becomes its id.'),
  reminder: z.string().max(4000).optional().describe('Fixed text sent at the scheduled time, without running you. Best for plain reminders.'),
  instructions: z.string().max(4000).optional().describe('What you should do at each run (you run with read-only tools unless `allow` grants more). Your reply is sent to the chat.'),
  command: z.string().max(10_000).optional().describe('Script-only job: a shell command run in the sandbox; its output is sent when non-empty (and, with only_changes, when it changed). Never runs you.'),
  only_changes: z.boolean().optional().describe('Send only when there is something new (instructions: reply NOTHING_TO_REPORT otherwise; command: output changed). Default false.'),
  to: z.string().max(200).optional().describe('Where results go: omit for this chat; "owner", a channel, or "channel:id" as for send_message.'),
  allow: z.array(z.enum(GRANTABLE)).max(5).optional().describe('Extra permissions for instruction runs (still limited by the owner\'s settings).'),
  timezone: z.string().max(64).optional().describe('IANA zone if not the owner\'s, e.g. America/New_York.'),
});
type Input = z.infer<typeof input>;

const kindOf = (j: JobConfig): string => (j.message !== undefined ? 'reminder' : j.script ? 'script' : 'task');

/** One job, in plain language, for the model and for chat confirmations. */
export function describeEntry(e: JobEntry, now: Date, labelOf: ScheduleToolDeps['labelOf'], sessionConversation?: string | null): string {
  const j = e.job;
  const by =
    e.origin.by === 'config' ? "owner's, in config.json" : e.origin.by === 'agent' ? (e.origin.conversation && e.origin.conversation === sessionConversation ? 'made by you in this chat' : 'made by you') : 'made by the owner';
  const status = !j.enabled ? 'disabled' : e.state.paused ? 'PAUSED' : e.done ? 'done' : null;
  const next = e.next ? `next ${describeNext(e.next, e.zone, now)}` : e.done && e.lastRun ? `ran ${describeTime(new Date(e.lastRun.startedAt), e.zone, now)}` : 'no upcoming run';
  const what = j.message !== undefined ? `sends "${j.message}"` : j.script ? `runs \`${j.script.command}\`` : `does: ${j.instructions}`;
  const to = j.notify ? `→ ${labelOf(j.notify)}` : '→ run history only';
  return `- ${j.id} [${kindOf(j)}, ${by}${status ? `, ${status}` : ''}]: ${describeSchedule(j, e.zone, now)}; ${next}; ${what} ${to}`;
}

/**
 * `schedule`: lets Garnet create, list, change, pause and delete jobs from
 * chat. Changes need `schedule.edit` (ask by default); a script job also
 * needs `exec`, so its exact command is shown to the owner for approval;
 * listing needs no permission. Jobs created here record where they came
 * from and deliver to that chat by default. Scheduled runs cannot use it.
 */
export function scheduleTool(deps: ScheduleToolDeps): ToolDefinition<Input> {
  const now = deps.now ?? (() => new Date());

  const need = (v: string | undefined, what: string): string => {
    if (!v?.trim()) throw new GarnetError('invalid_input', `${what} is required for this action.`);
    return v.trim();
  };

  /** Builds the job a create or update would produce, without saving it. */
  const plan = (i: Input, ctx: Pick<ToolContext, 'sessionId'>): { job: Record<string, unknown>; target: DeliveryTarget | null; existing?: JobEntry; notes: string[] } => {
    const origin = deps.originOf(ctx.sessionId);
    if (origin.isJob) throw new GarnetError('denied', 'Scheduled runs cannot create or change jobs.');
    if (i.timezone && !validTimeZone(i.timezone)) throw new GarnetError('invalid_input', `Unknown time zone "${i.timezone}". Use an IANA name like Europe/London.`);
    const actions = [i.reminder, i.instructions, i.command].filter((a) => a !== undefined && a.trim() !== '');
    if (actions.length > 1) throw new GarnetError('invalid_input', 'Give only one of reminder, instructions or command.');
    const notes: string[] = [];
    const job: Record<string, unknown> = {};
    let existing: JobEntry | undefined;
    if (i.action === 'update') {
      const id = need(i.id, 'id');
      existing = deps.book.list().find((e) => e.job.id === id);
      if (!existing) throw new GarnetError('invalid_input', `No job "${id}". Use action "list" to see the jobs.`);
      if (existing.origin.by === 'config') throw new GarnetError('denied', `"${id}" is the owner's job in config.json; only the owner can change it.`);
    } else if (actions.length === 0) {
      throw new GarnetError('invalid_input', 'Say what the job does: reminder (fixed text), instructions (you run), or command (script-only).');
    }
    const zone = i.timezone ?? existing?.job.timezone ?? deps.book.timezone;
    if (i.timezone) job.timezone = i.timezone;
    if (i.action === 'create' || i.when !== undefined) {
      const when = parseWhen(need(i.when, 'when'), { now: now(), zone });
      if (when.kind === 'once') {
        job.kind = 'once';
        job.at = when.at.toISOString();
        if (when.shifted) notes.push('That local time does not exist on that day (clocks go forward), so it was moved forward by the jump.');
      } else if (when.kind === 'heartbeat') Object.assign(job, { kind: 'heartbeat', everyMinutes: when.everyMinutes });
      else Object.assign(job, { kind: 'cron', cron: when.cron });
    }
    if (i.reminder?.trim()) job.message = i.reminder.trim();
    if (i.instructions?.trim()) job.instructions = i.instructions.trim();
    if (i.command?.trim()) job.script = { command: i.command.trim(), timeoutSeconds: 60 };
    if (i.only_changes !== undefined) job.notifyWhen = i.only_changes ? 'on_change' : 'always';
    else if (i.action === 'create') job.notifyWhen = 'always';
    if (i.allow) {
      const permissions: Record<string, string> = { 'fs.read': 'allow', 'schedule.edit': 'deny' };
      for (const cap of GRANTABLE) permissions[cap] = i.allow.includes(cap) ? 'allow' : 'deny';
      job.permissions = permissions;
    }
    let target: DeliveryTarget | null = null;
    if (i.action === 'create' || i.to !== undefined) {
      try {
        target = deps.resolveTarget(i.to, ctx.sessionId);
      } catch (e) {
        // A task can still run with results kept in history; a reminder or script with nowhere to go is pointless.
        if (i.to !== undefined || job.message !== undefined || job.script !== undefined) throw e;
        notes.push('There is no paired chat to deliver to, so results are kept in run history only (`garnet jobs history`).');
      }
      if (target) job.notify = { channel: target.channel, chatId: target.chatId, account: target.account };
    }
    if (i.action === 'create') {
      const base = i.name?.trim() || i.reminder || i.instructions || i.command || 'job';
      job.id = deps.book.freeId(base.split(/\s+/).slice(0, 4).join(' '));
    }
    return { job, target, ...(existing ? { existing } : {}), notes };
  };

  const capabilities = (i: Input): Capability[] => {
    if (i.action === 'list') return [];
    const caps: Capability[] = ['schedule.edit'];
    // A script job runs a command unattended later: the owner approves that exact command as for run_command.
    if (i.command?.trim()) caps.push('exec');
    return caps;
  };

  const summarize = (i: Input, ctx: ToolContext): string => {
    const t = now();
    if (i.action === 'pause' || i.action === 'resume' || i.action === 'delete') return `schedule: ${i.action} job "${i.id ?? '?'}"`;
    const p = plan(i, ctx);
    const zone = (p.job.timezone as string | undefined) ?? p.existing?.job.timezone ?? deps.book.timezone;
    const merged = { ...(p.existing?.job ?? {}), ...p.job } as JobConfig;
    const parts = [`schedule: ${i.action === 'create' ? 'create' : `update`} job "${merged.id}"`];
    if (merged.kind) parts.push(`when: ${describeSchedule(merged, zone, t)}${merged.kind === 'once' ? ` (${zone}, ${describeDistance(new Date(merged.at!), t)})` : ` (${zone})`}`);
    if (p.job.message !== undefined) parts.push(`sends: ${String(p.job.message)}`);
    if (p.job.instructions !== undefined) parts.push(`Garnet will: ${String(p.job.instructions)}`);
    if (p.job.script !== undefined) parts.push(`runs this command in the sandbox, unattended, each time:\n${(p.job.script as { command: string }).command}`);
    if (p.target) parts.push(`delivers to: ${p.target.label}`);
    if (i.allow?.length) parts.push(`extra permissions: ${i.allow.join(', ')}`);
    return parts.join('\n');
  };

  return {
    name: 'schedule',
    version: 1,
    description:
      'Create and manage scheduled jobs: one-shot reminders, recurring tasks you run, and script-only jobs. Results are sent to this chat unless `to` says otherwise. Use "list" first to find ids. Times are in the owner\'s time zone; confirm the next run time back to the owner.',
    input,
    capability: 'schedule.edit',
    capabilitiesFor: capabilities,
    summarize,
    idempotent: false,
    async run(i, ctx) {
      const t = now();
      const origin = deps.originOf(ctx.sessionId);
      const describe = (e: JobEntry) => describeEntry(e, t, deps.labelOf, origin.conversation);
      if (i.action === 'list') {
        const entries = deps.book.list();
        if (!entries.length) return { content: `No jobs yet. It is now ${describeTime(t, deps.book.timezone, t)} (${deps.book.timezone}).` };
        return { content: [`Jobs (now: ${describeTime(t, deps.book.timezone, t)}, ${deps.book.timezone}):`, ...entries.map(describe)].join('\n') };
      }
      if (origin.isJob) throw new GarnetError('denied', 'Scheduled runs cannot create or change jobs.');
      if (i.action === 'pause' || i.action === 'resume' || i.action === 'delete') {
        const id = need(i.id, 'id');
        if (i.action === 'delete') {
          deps.book.remove(id);
          return { content: `Deleted job "${id}". Its run history is kept.` };
        }
        const e = i.action === 'pause' ? deps.book.pause(id) : deps.book.resume(id);
        return { content: `${i.action === 'pause' ? 'Paused' : 'Resumed'} "${id}".\n${describe(e)}` };
      }
      const p = plan(i, ctx);
      // A job made by a conversation that read untrusted content keeps that taint on every run.
      const taint = [...(ctx.taint?.sources ?? [])];
      const by: JobOrigin = { by: 'agent', sessionId: ctx.sessionId, conversation: origin.conversation, at: t.toISOString(), ...(taint.length ? { taint } : {}) };
      const entry = i.action === 'create' ? deps.book.create(p.job, by as Exclude<JobOrigin, { by: 'config' }>) : deps.book.update(p.existing!.job.id, p.job as Partial<JobConfig>, 'agent', taint);
      const lines = [`${i.action === 'create' ? 'Created' : 'Updated'} job "${entry.job.id}".`, describe(entry), ...p.notes];
      if (taint.length && entry.job.instructions !== undefined) lines.push('This conversation has read untrusted content, so its runs will ask the owner before consequential actions.');
      if (entry.next) lines.push(`Next run: ${describeNext(entry.next, entry.zone, t)}.`);
      return { content: lines.join('\n'), data: { id: entry.job.id, next: entry.next?.toISOString() ?? null } };
    },
  };
}
