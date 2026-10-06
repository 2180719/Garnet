// Wires `ruby import` (and the setup wizard's import step) to a Ruby instance: memory with
// raisable caps, skills, jobs and pairings in config/the gateway store. The importer itself
// (src/migrate) never touches config or the database directly.
import { join } from 'node:path';
import { configSchema, type JobConfig, type RubyConfig } from '../config/index.ts';
import { RubyError } from '../contracts/index.ts';
import type { Ruby } from '../main.ts';
import { MemoryStore } from '../memory/index.ts';
import type { ImportDeps } from '../migrate/index.ts';

export type ImportWiring = {
  /** The config the import reads and changes (caps, jobs). */
  getConfig: () => RubyConfig;
  /** Stores a changed config (written now by `ruby import`; with the rest of setup in the wizard). */
  setConfig: (config: RubyConfig) => void;
  getPersona: () => string | undefined;
  setPersona: (persona: string) => void;
  ask?: ImportDeps['ask'];
};

export function importDeps(ruby: Ruby, w: ImportWiring): ImportDeps {
  let memory = ruby.memory;
  let secretNames: string[] | null = null;
  const hasSecret = (name: string): boolean => {
    if (ruby.env[name] !== undefined) return true;
    try {
      secretNames ??= ruby.secrets.exists() ? ruby.secrets.names() : [];
    } catch {
      secretNames = []; // a locked store: report the secret as missing rather than prompting
    }
    return secretNames.includes(name);
  };
  return {
    memory: {
      read: (ns, file) => memory.read(ns, file),
      write: (ns, file, content) => memory.write(ns, file, content),
      limit: (file) => memory.limit(file),
      setLimits: (caps) => {
        const c = w.getConfig();
        const limits = { memoryChars: caps.memory ?? c.memory.memoryChars, userChars: caps.user ?? c.memory.userChars };
        w.setConfig({ ...c, memory: { ...c.memory, ...limits } });
        memory = new MemoryStore({ root: join(ruby.paths.home, 'memory'), limits: { memory: limits.memoryChars, user: limits.userChars } });
      },
    },
    skills: ruby.skills,
    workspace: ruby.paths.workspace,
    getPersona: w.getPersona,
    setPersona: w.setPersona,
    jobs: {
      ids: () => w.getConfig().jobs.map((j) => j.id),
      add: (jobs: JobConfig[]) => {
        const c = w.getConfig();
        const next = configSchema.safeParse({ ...c, jobs: [...c.jobs, ...jobs] });
        if (!next.success) throw new RubyError('invalid_input', `Imported jobs did not validate: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        w.setConfig(next.data);
      },
    },
    pairings: {
      has: (channel, senderId) => ruby.gatewayStore.identity(channel, senderId) !== undefined,
      add: (channel, senderId, displayName) => ruby.gatewayStore.addIdentity(channel, senderId, displayName),
    },
    ...(w.ask ? { ask: w.ask } : {}),
    planOptions: { tools: ruby.registry.schemas().map((t) => t.name), hasSecret },
  };
}
