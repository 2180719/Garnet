// Owner commands for inspecting and correcting what Garnet remembers.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMemoryFile, type MemoryFile } from '../memory/index.ts';
import { createGarnet } from '../main.ts';
import { BUILTIN_SKILL_SUBCOMMANDS, builtinSkillsReport, extensionsCommand } from './extensions.ts';
import type { Io } from './main.ts';

const MEMORY_USAGE = 'Usage: garnet memory show [memory|user] | edit <memory|user> | history <memory|user> | rollback <memory|user> <id>  [--ns <namespace>]\n';

export function memory(args: string[], io: Io): number {
  const nsIndex = args.indexOf('--ns');
  const ns = nsIndex >= 0 ? (args[nsIndex + 1] ?? 'default') : 'default';
  const [sub = 'show', file, id] = nsIndex >= 0 ? args.filter((_, i) => i !== nsIndex && i !== nsIndex + 1) : args;
  const garnet = createGarnet({ noModel: true });
  try {
    const store = garnet.memory;
    const target = (f: string | undefined): MemoryFile | null => (f && isMemoryFile(f) ? f : null);
    if (sub === 'show') {
      const f = target(file);
      io.out(f ? `${store.read(ns, f) || '(empty)'}\n` : `${store.snapshot(ns)}\n`);
      return 0;
    }
    const f = target(file);
    if (!f) {
      io.err(MEMORY_USAGE);
      return 2;
    }
    if (sub === 'history') {
      const versions = store.history(ns, f);
      if (!versions.length) io.out('No earlier versions.\n');
      for (const v of versions) io.out(`${v.id}  ${v.at}  ${v.chars} chars\n`);
      return 0;
    }
    if (sub === 'rollback' && id) {
      const r = store.rollback(ns, f, id);
      io.out(`Restored ${store.fileName(f)} (${r.used}/${r.limit} chars). The previous version was kept in history.\n`);
      return 0;
    }
    if (sub === 'edit') {
      const dir = mkdtempSync(join(tmpdir(), 'garnet-memory-'));
      const tmp = join(dir, store.fileName(f));
      try {
        writeFileSync(tmp, store.read(ns, f), { mode: 0o600 });
        // $VISUAL/$EDITOR may carry arguments ("code --wait"), so the shell splits it; the file is passed as "$1".
        const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
        const result = spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', tmp], { stdio: 'inherit' });
        if (result.status !== 0) {
          io.err(`Editor ${result.error ? `could not start (${result.error.message})` : `exited with ${result.status ?? result.signal}`}; nothing saved.\n`);
          return 1;
        }
        const r = store.write(ns, f, readFileSync(tmp, 'utf8'));
        io.out(`Saved ${store.fileName(f)} (${r.used}/${r.limit} chars). Garnet sees it from the next session.\n`);
        return 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    io.err(MEMORY_USAGE);
    return 2;
  } finally {
    garnet.close();
  }
}

export async function skills(args: string[], io: Io): Promise<number> {
  const [sub = 'list', name] = args;
  // Built-in optional skills (enable/disable per channel) live in extensions.ts.
  if (BUILTIN_SKILL_SUBCOMMANDS.has(sub) || args.includes('--channel') || args.some((a) => a.startsWith('--channel='))) return extensionsCommand('skills', args, io);
  const garnet = createGarnet({ noModel: true });
  try {
    const store = garnet.skills;
    switch (sub) {
      case 'list': {
        const all = store.list();
        if (!all.length) io.out('No skills yet. Garnet creates them after tasks worth repeating, or drop a SKILL.md folder into ~/.garnet/skills.\n');
        for (const s of all) {
          const flags = [s.provenance, s.locked ? 'locked' : '', s.hasProposal ? 'PROPOSAL' : ''].filter(Boolean).join(', ');
          io.out(`${s.name.padEnd(28)} ${String(s.uses).padStart(4)} uses  (${flags})  ${s.description}\n`);
        }
        for (const p of store.problems()) io.out(`! ${p.name}: ${p.problem}\n`);
        io.out(`\n${builtinSkillsReport(garnet.config, undefined, (n) => store.has(n))}`);
        return 0;
      }
      case 'show': {
        if (!name) break;
        const shipped = store.has(name) ? undefined : garnet.builtinSkills.get(name);
        io.out(`${shipped ? `(built-in skill)\n${shipped.body}` : store.read(name).body}\n`);
        return 0;
      }
      case 'proposal':
        if (!name) break;
        io.out(`${store.proposal(name) ?? 'No proposal for this skill.'}\n`);
        return 0;
      case 'accept':
        if (!name) break;
        store.acceptProposal(name);
        io.out(`Applied the proposed change to ${name}.\n`);
        return 0;
      case 'reject':
        if (!name) break;
        store.rejectProposal(name);
        io.out(`Discarded the proposed change to ${name}.\n`);
        return 0;
      case 'archive':
      case 'unarchive':
        if (!name) break;
        store[sub](name);
        io.out(`${sub === 'archive' ? 'Archived' : 'Restored'} ${name}.\n`);
        return 0;
      case 'stale': {
        const days = Number(name ?? 60);
        if (!Number.isFinite(days) || days < 0) break;
        const stale = store.stale(days);
        if (!stale.length) io.out(`No skills of Garnet's own unused for ${days} days.\n`);
        for (const s of stale) io.out(`${s.name}  last used ${s.lastUsedAt ?? 'never'}\n`);
        return 0;
      }
    }
    io.err('Usage: garnet skills list | show <name> | proposal <name> | accept <name> | reject <name> | archive <name> | unarchive <name> | stale [days]\n       garnet skills builtin | enable <name> | disable <name> | reset <name> | effective  [--channel <scope>]\n');
    return 2;
  } finally {
    garnet.close();
  }
}
