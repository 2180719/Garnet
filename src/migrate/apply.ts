// applyImport: performs a plan idempotently. Never overwrites existing Ruby memory, skills or files.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { makeScanner } from './safefs.ts';
import { selectFit } from './plan.ts';
import type { ApplyResult, ImportDeps, ImportPlan } from './types.ts';

export function applyImport(plan: ImportPlan, deps: ImportDeps): ApplyResult {
  const ns = deps.namespace ?? 'default';
  const result: ApplyResult = { memory: [], persona: 'none', skills: [], copied: [] };

  for (const m of plan.memory) {
    const existing = deps.memory.read(ns, m.file).split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const cap = deps.memory.limit(m.file);
    const fresh = m.entries.filter((e) => !existing.includes(`- ${e}`));
    const picked = selectFit(fresh, existing, cap);
    let used = existing.join('\n').length;
    if (picked.length) {
      const content = [...existing, ...picked.map((e) => `- ${e}`)].join('\n');
      used = deps.memory.write(ns, m.file, content).used;
    }
    result.memory.push({
      file: m.file,
      added: picked.length,
      alreadyPresent: m.entries.length - fresh.length,
      omittedForCap: fresh.length - picked.length,
      used,
      limit: cap,
    });
  }

  if (plan.persona) {
    const current = deps.getPersona?.();
    if (current && current.trim() && current !== plan.persona.text) result.persona = 'kept-existing';
    else if (current === plan.persona.text) result.persona = 'unchanged';
    else {
      deps.setPersona(plan.persona.text);
      result.persona = 'set';
    }
  }

  for (const s of plan.skills) {
    if (s.conflict) {
      result.skills.push({ name: s.name || s.originalName, status: 'skipped', detail: s.conflict });
      continue;
    }
    if (existsSync(join(deps.skills.root, s.name))) {
      result.skills.push({ name: s.name, status: 'exists', detail: 'a Ruby skill with this name already exists; left untouched' });
      continue;
    }
    try {
      deps.skills.create(s.name, s.description, s.body, 'user');
      result.skills.push({ name: s.name, status: 'created' });
    } catch (e) {
      result.skills.push({ name: s.name, status: 'failed', detail: (e as Error).message });
    }
  }

  // Copies are re-read from the source through the same containment checks as planning.
  if (plan.copies.length) {
    const sc = makeScanner(plan.fromDir);
    const base = join(deps.workspace, 'imported', plan.source);
    for (const c of plan.copies) {
      try {
        const rel = normalize(c.src);
        if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('unsafe source path');
        const dest = join(base, rel);
        if (!dest.startsWith(base + sep)) throw new Error('unsafe destination path');
        const label = `imported/${plan.source}/${rel.split(sep).join('/')}`;
        if (existsSync(dest)) {
          result.copied.push({ dest: label, status: 'exists' });
          continue;
        }
        const data = sc.readBuffer(join(sc.root, rel));
        if (!data) throw new Error('source file unreadable, too large (over 1 MB) or outside the source directory');
        guardDest(deps.workspace, dirname(dest));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        writeFileSync(dest, data, { mode: 0o600, flag: 'wx' });
        result.copied.push({ dest: label, status: 'copied' });
      } catch (e) {
        result.copied.push({ dest: c.dest, status: 'failed', detail: (e as Error).message });
      }
    }
  }
  return result;
}

/** Refuse to write through a symlinked `imported/` tree that leaves the workspace. */
function guardDest(workspace: string, dir: string): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const ws = realpathSync(workspace);
  let probe = dir;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== ws && !real.startsWith(ws + sep)) throw new Error('destination resolves outside the workspace');
}
