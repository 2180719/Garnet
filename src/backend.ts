// Part of the composition root: implements the dashboard/admin API on top of
// every module. Keeps the gateway free of memory, skills and scheduler imports.
import { Achievements, type Stats } from './achievements/index.ts';
import { configSchema, parseConfig, writeConfig } from './config/index.ts';
import { RubyError } from './contracts/index.ts';
import { approvePairing, type AdminBackend, type Gateway, type Scope } from './gateway/index.ts';
import { isMemoryFile } from './memory/index.ts';
import type { Scheduler } from './scheduler/index.ts';
import { StatsStore } from './store/index.ts';
import type { Ruby } from './main.ts';

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
    getConfig: () => ({ config: ruby.config, schema: configSchema.toJSONSchema({ io: 'input', unrepresentable: 'any' }) }),
    putConfig: (raw) => {
      const parsed = parseConfig(raw); // throws a config error listing every problem
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
    usage: (days) => ({ days: stats.usageByDay(days) }),
    achievements: () => ({ achievements: achievements.evaluate(collect()) }),
    unlockEasterEgg: (id) => achievements.unlockEasterEgg(id),
  };
}
