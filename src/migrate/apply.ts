// applyImport: performs a plan idempotently. Never overwrites existing Ruby memory, skills, jobs or files;
// the persona is only combined with an existing one as the owner chose.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { makeScanner, type Scanner } from './safefs.ts';
import { MEMORY_CAP_MAX, PERSONA_HEADER, PERSONA_MAX, selectFit } from './plan.ts';
import type { ApplyOptions, ApplyResult, ImportDeps, ImportPlan, MemoryFile } from './types.ts';

const SETUP_BLOCK = /<!-- ruby setup -->[\s\S]*?<!-- \/ruby setup -->/;
const NAME_LINE = /^Your name is (.+)\.$/m;

/** The `ruby setup` block of a persona and the text around it. */
export function splitPersona(persona: string | undefined): { setup: string | null; rest: string } {
  const text = (persona ?? '').trim();
  const m = SETUP_BLOCK.exec(text);
  if (!m) return { setup: null, rest: text };
  return { setup: m[0], rest: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

/** Whether a persona holds text beyond what `ruby setup` manages (so merging needs the owner's say). */
export function personaHasOwnText(persona: string | undefined): boolean {
  return splitPersona(persona).rest.length > 0;
}

/** Memory needed for an import: existing lines plus every new entry, rounded up to 100 and capped at the schema maximum. */
function capFor(existing: string[], fresh: string[]): number {
  const lines = [...existing, ...fresh.map((e) => `- ${e}`)];
  return Math.min(MEMORY_CAP_MAX, Math.ceil(lines.join('\n').length / 100) * 100);
}

export function applyImport(plan: ImportPlan, deps: ImportDeps, opts: ApplyOptions = {}): ApplyResult {
  const ns = deps.namespace ?? 'default';
  const result: ApplyResult = { memory: [], persona: 'none', skills: [], copied: [], jobs: [], pairings: [] };
  const existingLines = (file: MemoryFile) => deps.memory.read(ns, file).split('\n').map((l) => l.trimEnd()).filter(Boolean);

  const raised: Partial<Record<MemoryFile, number>> = {};
  if (opts.raiseCaps && deps.memory.setLimits) {
    const caps: Partial<Record<MemoryFile, number>> = {};
    for (const m of plan.memory) {
      const existing = existingLines(m.file);
      const target = capFor(existing, m.entries.filter((e) => !existing.includes(`- ${e}`)));
      const current = deps.memory.limit(m.file);
      if (target > current) {
        caps[m.file] = target;
        raised[m.file] = current;
      }
    }
    if (Object.keys(caps).length) deps.memory.setLimits(caps);
  }

  for (const m of plan.memory) {
    const existing = existingLines(m.file);
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
      ...(raised[m.file] !== undefined ? { raisedFrom: raised[m.file]! } : {}),
    });
  }

  if (plan.persona) applyPersona(plan, deps, opts, result);

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
      deps.skills.create(s.name, s.description, s.body, 'user', s.frontmatter);
      result.skills.push({ name: s.name, status: 'created', ...(s.missing.length ? { detail: `needs ${s.missing.join('; ')}` } : {}) });
    } catch (e) {
      result.skills.push({ name: s.name, status: 'failed', detail: (e as Error).message });
    }
  }

  if (deps.jobs && opts.jobs !== false) {
    const have = new Set(deps.jobs.ids());
    const add = [];
    for (const j of plan.jobs) {
      if (!j.job) {
        result.jobs.push({ id: j.from, status: 'skipped', detail: j.notes.join('; ') });
      } else if (have.has(j.job.id)) {
        result.jobs.push({ id: j.job.id, status: 'exists', detail: 'a Ruby job with this id already exists; left untouched' });
      } else {
        have.add(j.job.id);
        add.push(j.job);
        result.jobs.push({ id: j.job.id, status: 'added' });
      }
    }
    if (add.length) {
      try {
        deps.jobs.add(add);
      } catch (e) {
        for (const r of result.jobs) if (r.status === 'added') Object.assign(r, { status: 'failed', detail: (e as Error).message });
      }
    }
  }

  if (opts.pairings && deps.pairings) {
    for (const p of plan.pairings) {
      if (deps.pairings.has(p.channel, p.senderId)) result.pairings.push({ channel: p.channel, senderId: p.senderId, status: 'exists' });
      else {
        deps.pairings.add(p.channel, p.senderId, p.displayName);
        result.pairings.push({ channel: p.channel, senderId: p.senderId, status: 'added' });
      }
    }
  } else {
    for (const p of plan.pairings) result.pairings.push({ channel: p.channel, senderId: p.senderId, status: 'not-requested' });
  }

  // Copies are re-read from the source through the same containment checks as planning.
  if (plan.copies.length) {
    const scanners = new Map<string, Scanner>();
    const scannerFor = (root: string): Scanner => {
      let s = scanners.get(root);
      if (!s) scanners.set(root, (s = makeScanner(root)));
      return s;
    };
    const base = join(deps.workspace, 'imported', plan.source);
    for (const c of plan.copies) {
      try {
        const rel = normalize(c.src);
        if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('unsafe source path');
        const destRel = normalize(c.dest);
        if (!destRel.startsWith(join('imported', plan.source) + sep)) throw new Error('unsafe destination path');
        const dest = join(deps.workspace, destRel);
        if (!dest.startsWith(base + sep)) throw new Error('unsafe destination path');
        const label = destRel.split(sep).join('/');
        if (existsSync(dest)) {
          result.copied.push({ dest: label, status: 'exists' });
          continue;
        }
        const sc = scannerFor(c.root ?? plan.fromDir);
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

function applyPersona(plan: ImportPlan, deps: ImportDeps, opts: ApplyOptions, result: ApplyResult): void {
  const imported = plan.persona!.text;
  const current = deps.getPersona?.()?.trim() ?? '';
  const mode = opts.persona ?? 'auto';
  const { setup, rest } = splitPersona(current);
  if (!current) {
    deps.setPersona(imported);
    result.persona = 'set';
    return;
  }
  if (current === imported || rest === imported) {
    result.persona = 'unchanged';
    return;
  }
  if (mode === 'keep') {
    result.persona = 'kept-existing';
    return;
  }
  const already = rest.includes(PERSONA_HEADER(plan.source));
  if (already && mode !== 'replace') {
    result.persona = 'unchanged';
    result.personaNote = `a persona imported from ${plan.source} is already there; use --persona replace to import it again`;
    return;
  }
  if (mode === 'auto' && rest) {
    result.persona = 'kept-existing';
    result.personaNote = 'your persona has its own text; re-run with --persona merge to add the imported one after it, or --persona replace to use it instead';
    return;
  }
  // The setup block keeps its name: drop the imported name line when setup already set one.
  let text = imported;
  const setupName = setup ? NAME_LINE.exec(setup)?.[1] : undefined;
  const importedName = NAME_LINE.exec(imported)?.[1];
  if (setupName && importedName) {
    text = text.replace(NAME_LINE, '').replace(/\n{3,}/g, '\n\n');
    if (setupName !== importedName) result.personaNote = `kept the name "${setupName}" from setup; the old assistant was called "${importedName}" (change it with \`ruby setup\`)`;
  }
  const keep = mode === 'replace' ? [setup] : [setup, rest];
  const head = keep.filter(Boolean).join('\n\n');
  const room = PERSONA_MAX - (head ? head.length + 2 : 0);
  if (text.length > room) {
    const note = `\n[Imported from ${plan.source}; truncated to fit. Full text: workspace imported/${plan.source}/]`;
    text = room > note.length + 200 ? `${text.slice(0, room - note.length).trimEnd()}${note}` : '';
    const what = text ? 'truncated to fit the 4,000-character persona' : 'did not fit next to your persona at all';
    result.personaNote = [result.personaNote, `the imported persona ${what}; the originals are under imported/${plan.source}/`].filter(Boolean).join('; ');
  }
  if (!text) {
    result.persona = 'kept-existing';
    return;
  }
  deps.setPersona([head, text].filter(Boolean).join('\n\n'));
  result.persona = mode === 'replace' ? 'replaced' : 'merged';
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

