// Wires `garnet import` (and the setup wizard's import step) to a Garnet instance: memory with
// raisable caps, skills, jobs and pairings in config/the gateway store. The importer itself
// (src/migrate) never touches config or the database directly.
import { join } from 'node:path';
import { configSchema, type JobConfig, type GarnetConfig } from '../config/index.ts';
import { GarnetError } from '../contracts/index.ts';
import type { Garnet } from '../main.ts';
import { MemoryStore } from '../memory/index.ts';
import type { ImportDeps } from '../migrate/index.ts';

export type ImportWiring = {
  /** The config the import reads and changes (caps, jobs). */
  getConfig: () => GarnetConfig;
  /** Stores a changed config (written now by `garnet import`; with the rest of setup in the wizard). */
  setConfig: (config: GarnetConfig) => void;
  getPersona: () => string | undefined;
  setPersona: (persona: string) => void;
  ask?: ImportDeps['ask'];
};

export function importDeps(garnet: Garnet, w: ImportWiring): ImportDeps {
  let memory = garnet.memory;
  let secretNames: string[] | null = null;
  const hasSecret = (name: string): boolean => {
    if (garnet.env[name] !== undefined) return true;
    try {
      secretNames ??= garnet.secrets.exists() ? garnet.secrets.names() : [];
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
        memory = new MemoryStore({ root: join(garnet.paths.home, 'memory'), limits: { memory: limits.memoryChars, user: limits.userChars } });
      },
    },
    skills: garnet.skills,
    workspace: garnet.paths.workspace,
    getPersona: w.getPersona,
    setPersona: w.setPersona,
    jobs: {
      ids: () => w.getConfig().jobs.map((j) => j.id),
      add: (jobs: JobConfig[]) => {
        const c = w.getConfig();
        const next = configSchema.safeParse({ ...c, jobs: [...c.jobs, ...jobs] });
        if (!next.success) throw new GarnetError('invalid_input', `Imported jobs did not validate: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        w.setConfig(next.data);
      },
    },
    pairings: {
      has: (channel, senderId) => garnet.gatewayStore.identity(channel, senderId) !== undefined,
      add: (channel, senderId, displayName) => garnet.gatewayStore.addIdentity(channel, senderId, displayName),
    },
    ...(w.ask ? { ask: w.ask } : {}),
    planOptions: { tools: garnet.registry.schemas().map((t) => t.name), hasSecret },
  };
}
