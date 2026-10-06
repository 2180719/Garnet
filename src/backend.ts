// Part of the composition root: implements the dashboard/admin API on top of
// every module. Keeps the gateway free of memory, skills and scheduler imports.
import { Achievements, type Stats } from './achievements/index.ts';
import { changedProtectedPaths, configSchema, loadConfig, PROTECTED_CONFIG_PATHS, parseConfig, redact, writeConfig } from './config/index.ts';
import { RubyError, type ContentBlock, type SessionEvent } from './contracts/index.ts';
import { approvePairing, type AdminBackend, type Gateway, type Scope } from './gateway/index.ts';
import { isMemoryFile } from './memory/index.ts';
import type { Scheduler } from './scheduler/index.ts';
import { StatsStore } from './store/index.ts';
import type { Ruby } from './main.ts';

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

export function createBackend(ruby: Ruby, gateway: Gateway, scheduler: Scheduler, version: string): AdminBackend & { unlockEasterEgg(id: string): boolean } {
  const stats = new StatsStore(ruby.db);
  const achievements = new Achievements(ruby.db);
  const startedAt = new Date().toISOString();
  stats.setMetaOnce('first_start', startedAt);
  const memFile = (f: string) => {
    if (!isMemoryFile(f)) throw new RubyError('invalid_input', 'File must be "memory" or "user".');
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
      agentSkills: ruby.skills.list().filter((s) => s.provenance === 'agent').length,
      memoryChars: ruby.memory.read('default', 'memory').length + ruby.memory.read('default', 'user').length,
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
      model: ruby.model.id,
      startedAt,
      firstStart: stats.getMeta('first_start') ?? startedAt,
      counts: stats.counts(),
      pendingApprovals: ruby.approvals.pending().length,
      health: gateway.health(),
      scheduler: { enabled: ruby.config.scheduler.enabled, jobs: ruby.config.jobs.length },
      api: { host: ruby.config.api.host, port: ruby.config.api.port },
    }),
    // The file, not the startup config: after a PUT the page must show what was saved.
    getConfig: () => ({
      config: loadConfig(ruby.paths.home).config,
      schema: configSchema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      protectedPaths: PROTECTED_CONFIG_PATHS,
    }),
    putConfig: (raw) => {
      const parsed = parseConfig(raw); // throws a config error listing every problem
      const changed = changedProtectedPaths(loadConfig(ruby.paths.home).config, parsed);
      if (changed.length > 0) {
        throw new RubyError('denied', `These settings can only be changed with the CLI (ruby config), not over the API: ${changed.join(', ')}.`, { paths: changed });
      }
      writeConfig(ruby.paths.home, parsed);
      return { restartRequired: true };
    },
    approvals: () => ({ pending: ruby.approvals.pending() }),
    decideApproval: (code, decision) => gateway.resolveApproval(code, decision),
    memory: (ns) => ({
      namespace: ns,
      files: (['memory', 'user'] as const).map((f) => ({
        file: f,
        name: ruby.memory.fileName(f),
        content: ruby.memory.read(ns, f),
        limit: ruby.memory.limit(f),
        history: ruby.memory.history(ns, f).slice(0, 20),
      })),
    }),
    writeMemory: (ns, file, content) => ruby.memory.write(ns, memFile(file), content),
    rollbackMemory: (ns, file, id) => ruby.memory.rollback(ns, memFile(file), id),
    skills: () => ({
      skills: ruby.skills.list(),
      archived: ruby.skills.archived(),
      problems: ruby.skills.problems(),
      stale: ruby.skills.stale().map((s) => s.name),
    }),
    skill: (name) => {
      const info = [...ruby.skills.list(), ...ruby.skills.archived()].find((s) => s.name === name);
      if (!info) throw new RubyError('invalid_input', `No skill "${name}".`);
      // Read without counting a use: the owner looking is not the agent using it.
      return { ...info, proposal: ruby.skills.proposal(name), body: ruby.skills.read(name).body };
    },
    skillAction: (name, action) => {
      if (action === 'accept') ruby.skills.acceptProposal(name);
      else if (action === 'reject') ruby.skills.rejectProposal(name);
      else ruby.skills[action](name);
      return { ok: true };
    },
    jobs: () => ({
      enabled: ruby.config.scheduler.enabled,
      jobs: ruby.config.jobs.map((j) => ({ ...j, state: ruby.jobStore.state(j.id), runs: ruby.jobStore.runs(j.id, 10) })),
    }),
    jobAction: async (id, action) => {
      if (!ruby.config.jobs.some((j) => j.id === id)) throw new RubyError('invalid_input', `No job "${id}".`);
      if (action === 'resume') scheduler.resume(id);
      else await scheduler.runNow(id);
      return { state: ruby.jobStore.state(id), last: ruby.jobStore.runs(id, 1)[0] ?? null };
    },
    keys: () => ({ keys: ruby.keys.list() }),
    createKey: (name, scopes: Scope[], days) => ruby.keys.create(name, scopes, days),
    revokeKey: (id) => ruby.keys.revoke(id),
    pairing: () => ({ pending: ruby.gatewayStore.pairings(new Date().toISOString()), identities: ruby.gatewayStore.identities() }),
    approvePairing: (code) => {
      const p = approvePairing(ruby.gatewayStore, code);
      if (!p) throw new RubyError('invalid_input', 'No pending pairing request with that code.');
      void gateway.deliver();
      return p;
    },
    revokeIdentity: (channel, senderId) => ruby.gatewayStore.removeIdentity(channel, senderId),
    sessions: (opts) => stats.sessionPage(opts),
    sessionEvents: (id, after, limit) => {
      const session = ruby.store.getSession(id);
      if (!session) throw new RubyError('invalid_input', `No session "${id}".`);
      const { events, lastSeq } = ruby.store.eventsPage(id, after, limit);
      const next = events.at(-1)?.seq ?? after;
      return {
        session: { id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, conversation: ruby.gatewayStore.keyForSession(id) ?? null },
        events: events.map(eventView),
        lastSeq,
        nextAfter: next < lastSeq ? next : null,
      };
    },
    audit: (opts) => {
      const { entries, total } = ruby.keyStore.auditPage(opts);
      return { total, entries: entries.map((e) => ({ ...e, path: redact(e.path.replace(AUDIT_PATH_SECRETS, '$1…')) })) };
    },
    failures: (opts) => {
      const { items, total } = stats.failurePage(opts);
      return { total, items: items.map((f) => ({ ...f, detail: f.detail === null ? null : (clip(redact(f.detail)) as string) })) };
    },
    routing: ({ limit, offset }) => ({
      routes: ruby.config.routes,
      conversations: ruby.gatewayStore.conversationPage(limit, offset),
      identities: ruby.gatewayStore.identities(),
      pending: ruby.gatewayStore.pairings(new Date().toISOString()),
    }),
    unlinkConversation: (key) => ruby.gatewayStore.removeConversation(key),
    denyPairing: (code) => ruby.gatewayStore.removePairing(code),
    usage: (days) => ({ days: stats.usageByDay(days) }),
    achievements: () => ({ achievements: achievements.evaluate(collect()) }),
    unlockEasterEgg: (id) => achievements.unlockEasterEgg(id),
  };
}
