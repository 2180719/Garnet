// Part of the composition root: implements the dashboard/admin API on top of
// every module. Keeps the gateway free of memory, skills and scheduler imports.
import { Achievements, type Stats } from './achievements/index.ts';
import { changedProtectedPaths, configSchema, loadConfig, PROTECTED_CONFIG_PATHS, parseConfig, redact, writeConfig } from './config/index.ts';
import { GarnetError, type ContentBlock, type SessionEvent } from './contracts/index.ts';
import { approvePairing, ChatDirectory, type AdminBackend, type Gateway, type Scope } from './gateway/index.ts';
import { isMemoryFile } from './memory/index.ts';
import { describeNext, describeSchedule, parseWhen, type JobEntry, type Scheduler } from './scheduler/index.ts';
import { StatsStore } from './store/index.ts';
import type { Garnet } from './main.ts';

const CLIP = 4000;
/** Shortens long strings anywhere in a value so one huge tool result cannot flood the page. */
function clip(v: unknown): unknown {
  if (typeof v === 'string') return v.length > CLIP ? `${v.slice(0, CLIP)}\n… [${v.length - CLIP} more characters not shown]` : v;
  if (Array.isArray(v)) return v.map(clip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
  return v;
}
const safe = <T>(v: T): T => clip(redact(v)) as T;

const blockView = (b: ContentBlock): unknown =>
  // Provider blocks hold signed thinking and other opaque data: never sent to the dashboard.
  b.type === 'provider' ? { type: 'provider', provider: b.provider, hidden: true } : safe(b);

/** A read-only, secret-redacted view of one event for the dashboard. */
function eventView(e: SessionEvent): unknown {
  switch (e.type) {
    case 'user_message':
      return { ...safe({ seq: e.seq, at: e.at, type: e.type, source: e.source }), content: e.message.content.map(blockView) };
    case 'assistant_message':
      return { ...safe({ seq: e.seq, at: e.at, type: e.type, model: e.model, stopReason: e.stopReason, usage: e.usage }), content: e.message.content.map(blockView) };
    case 'context_frozen':
      return { seq: e.seq, at: e.at, type: e.type, chars: e.system.length }; // the prompt embeds memory; show only its size
    default: {
      const { sessionId: _s, ...rest } = e;
      return safe(rest);
    }
  }
}

const AUDIT_PATH_SECRETS = /(\/api\/pairing\/)[^/]+/;

/** A job for the dashboard: its definition, where it came from, and its schedule and next run in words. */
function jobView(e: JobEntry, now: Date, label: (n: { channel: string; account: string; chatId: string }) => string): Record<string, unknown> {
  return {
    ...e.job,
    origin: e.origin,
    zone: e.zone,
    state: e.state,
    done: e.done,
    schedule: describeSchedule(e.job, e.zone, now),
    next: e.next?.toISOString() ?? null,
    nextText: e.next ? describeNext(e.next, e.zone, now) : null,
    notifyLabel: e.job.notify ? label(e.job.notify) : null,
  };
}

export function createBackend(garnet: Garnet, gateway: Gateway, scheduler: Scheduler, version: string): AdminBackend & { unlockEasterEgg(id: string): boolean } {
  const stats = new StatsStore(garnet.db);
  const achievements = new Achievements(garnet.db);
  const notifyLabel = (n: { channel: string; account: string; chatId: string }): string => {
    const known = garnet.directory.chats().find((c) => c.channel === n.channel && c.chatId === n.chatId);
    return ChatDirectory.label(known ?? { ...n, senderId: null, name: null });
  };
  const startedAt = new Date().toISOString();
  stats.setMetaOnce('first_start', startedAt);
  const memFile = (f: string) => {
    if (!isMemoryFile(f)) throw new GarnetError('invalid_input', 'File must be "memory" or "user".');
    return f;
  };

  const collect = (): Stats => {
    const c = stats.counts();
    const first = stats.getMeta('first_start') ?? startedAt;
    const late = stats.recentTaskEnds().filter((t) => {
      const h = new Date(t).getHours(); // host local time
      return h >= 2 && h < 4;
    }).length;
    return {
      tasksCompleted: c.tasksCompleted,
      toolCalls: c.toolCalls,
      agentSkills: garnet.skills.list().filter((s) => s.provenance === 'agent').length,
      memoryChars: garnet.memory.read('default', 'memory').length + garnet.memory.read('default', 'user').length,
      channelsPaired: c.identities,
      approvalsDecided: c.approvalsDecided,
      jobRuns: c.jobRuns,
      quietHeartbeats: c.quietRuns,
      uptimeDays: Math.floor((Date.now() - new Date(first).getTime()) / 86_400_000),
      lateNightTasks: late,
      compactions: c.compactions,
      apiKeys: c.apiKeys,
    };
  };

  return {
    overview: () => ({
      version,
      model: garnet.model.id,
      startedAt,
      firstStart: stats.getMeta('first_start') ?? startedAt,
      counts: stats.counts(),
      pendingApprovals: garnet.approvals.pending().length,
      health: gateway.health(),
      scheduler: { enabled: garnet.config.scheduler.enabled, jobs: garnet.jobBook.jobs().length },
      api: { host: garnet.config.api.host, port: garnet.config.api.port },
    }),
    // The file, not the startup config: after a PUT the page must show what was saved.
    getConfig: () => ({
      config: loadConfig(garnet.paths.home).config,
      schema: configSchema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      protectedPaths: PROTECTED_CONFIG_PATHS,
    }),
    putConfig: (raw) => {
      const parsed = parseConfig(raw); // throws a config error listing every problem
      const changed = changedProtectedPaths(loadConfig(garnet.paths.home).config, parsed);
      if (changed.length > 0) {
        throw new GarnetError('denied', `These settings can only be changed by editing config.json on the host (then run "garnet config check"), not over the API: ${changed.join(', ')}.`, { paths: changed });
      }
      writeConfig(garnet.paths.home, parsed);
      return { restartRequired: true };
    },
    approvals: () => ({ pending: garnet.approvals.pending() }),
    decideApproval: (code, decision) => gateway.resolveApproval(code, decision),
    memory: (ns) => ({
      namespace: ns,
      files: (['memory', 'user'] as const).map((f) => ({
        file: f,
        name: garnet.memory.fileName(f),
        content: garnet.memory.read(ns, f),
        limit: garnet.memory.limit(f),
        history: garnet.memory.history(ns, f).slice(0, 20),
      })),
    }),
    writeMemory: (ns, file, content) => garnet.memory.write(ns, memFile(file), content),
    rollbackMemory: (ns, file, id) => garnet.memory.rollback(ns, memFile(file), id),
    skills: () => ({
      skills: garnet.skills.list(),
      archived: garnet.skills.archived(),
      problems: garnet.skills.problems(),
      stale: garnet.skills.stale().map((s) => s.name),
    }),
    skill: (name) => {
      const info = [...garnet.skills.list(), ...garnet.skills.archived()].find((s) => s.name === name);
      if (!info) throw new GarnetError('invalid_input', `No skill "${name}".`);
      // Read without counting a use: the owner looking is not the agent using it.
      return { ...info, proposal: garnet.skills.proposal(name), body: garnet.skills.read(name).body };
    },
    skillAction: (name, action) => {
      if (action === 'accept') garnet.skills.acceptProposal(name);
      else if (action === 'reject') garnet.skills.rejectProposal(name);
      else garnet.skills[action](name);
      return { ok: true };
    },
    jobs: () => {
      const now = new Date();
      return {
        enabled: garnet.config.scheduler.enabled,
        timezone: garnet.timezone,
        problems: garnet.jobBook.problems(),
        jobs: garnet.jobBook.list().map((e) => ({ ...jobView(e, now, notifyLabel), runs: garnet.jobStore.runs(e.job.id, 10) })),
      };
    },
    jobAction: async (id, action) => {
      if (!garnet.jobBook.find(id)) throw new GarnetError('invalid_input', `No job "${id}".`);
      if (action === 'resume') garnet.jobBook.resume(id);
      else if (action === 'pause') garnet.jobBook.pause(id);
      else await scheduler.runNow(id);
      return { state: garnet.jobStore.state(id), last: garnet.jobStore.runs(id, 1)[0] ?? null };
    },
    updateJob: (id, body) => {
      const b = (body ?? {}) as { when?: unknown; instructions?: unknown; message?: unknown };
      const patch: Record<string, unknown> = {};
      const found = garnet.jobBook.find(id);
      if (!found) throw new GarnetError('invalid_input', `No job "${id}".`);
      if (typeof b.when === 'string' && b.when.trim()) {
        const w = parseWhen(b.when, { now: new Date(), zone: garnet.jobBook.zoneOf(found.job) });
        Object.assign(patch, w.kind === 'once' ? { kind: 'once', at: w.at.toISOString() } : w.kind === 'heartbeat' ? { kind: 'heartbeat', everyMinutes: w.everyMinutes } : { kind: 'cron', cron: w.cron });
      }
      if (typeof b.instructions === 'string' && b.instructions.trim()) patch.instructions = b.instructions.trim();
      if (typeof b.message === 'string' && b.message.trim()) patch.message = b.message.trim();
      return jobView(garnet.jobBook.update(id, patch, 'owner'), new Date(), notifyLabel);
    },
    deleteJob: (id) => {
      garnet.jobBook.remove(id);
      return { deleted: true };
    },
    keys: () => ({ keys: garnet.keys.list() }),
    createKey: (name, scopes: Scope[], days) => garnet.keys.create(name, scopes, days),
    revokeKey: (id) => garnet.keys.revoke(id),
    pairing: () => ({ pending: garnet.gatewayStore.pairings(new Date().toISOString()), identities: garnet.gatewayStore.identities() }),
    approvePairing: (code) => {
      const p = approvePairing(garnet.gatewayStore, code);
      if (!p) throw new GarnetError('invalid_input', 'No pending pairing request with that code.');
      void gateway.deliver();
      return p;
    },
    revokeIdentity: (channel, senderId) => garnet.gatewayStore.removeIdentity(channel, senderId),
    sessions: (opts) => stats.sessionPage(opts),
    sessionEvents: (id, after, limit) => {
      const session = garnet.store.getSession(id);
      if (!session) throw new GarnetError('invalid_input', `No session "${id}".`);
      const { events, lastSeq } = garnet.store.eventsPage(id, after, limit);
      const next = events.at(-1)?.seq ?? after;
      return {
        session: { id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, conversation: garnet.gatewayStore.keyForSession(id) ?? null },
        events: events.map(eventView),
        lastSeq,
        nextAfter: next < lastSeq ? next : null,
      };
    },
    audit: (opts) => {
      const { entries, total } = garnet.keyStore.auditPage(opts);
      return { total, entries: entries.map((e) => ({ ...e, path: redact(e.path.replace(AUDIT_PATH_SECRETS, '$1…')) })) };
    },
    failures: (opts) => {
      const { items, total } = stats.failurePage(opts);
      return { total, items: items.map((f) => ({ ...f, detail: f.detail === null ? null : (clip(redact(f.detail)) as string) })) };
    },
    routing: ({ limit, offset }) => ({
      routes: garnet.config.routes,
      conversations: garnet.gatewayStore.conversationPage(limit, offset),
      identities: garnet.gatewayStore.identities(),
      pending: garnet.gatewayStore.pairings(new Date().toISOString()),
    }),
    unlinkConversation: (key) => garnet.gatewayStore.removeConversation(key),
    denyPairing: (code) => garnet.gatewayStore.removePairing(code),
    usage: (days) => ({ days: stats.usageByDay(days) }),
    achievements: () => ({ achievements: achievements.evaluate(collect()) }),
    unlockEasterEgg: (id) => achievements.unlockEasterEgg(id),
  };
}
