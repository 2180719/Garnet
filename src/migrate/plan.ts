// planImport: a pure read of an OpenClaw or Hermes Agent home directory. Nothing is written or executed;
// all text read from the source is treated as untrusted data.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, MAX_ENTRY_CHARS, injectionReason } from '../memory/index.ts';
import { MAX_BODY, MAX_DESCRIPTION, NAME_RE } from '../skills/index.ts';
import { makeScanner, type Scanner } from './safefs.ts';
import type { ImportPlan, MemoryAction, PersonaAction, SkillAction, Source } from './types.ts';

export const PERSONA_MAX = 4000;
const MAX_SKILL_DEPTH = 4;
const CHANNELS = ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'matrix', 'msteams', 'googlechat', 'irc', 'line', 'email'];

/** Default source home for a source (`--from` overrides). */
export function defaultSourceDir(source: Source, home: string = homedir()): string {
  return join(home, source === 'openclaw' ? '.openclaw' : '.hermes');
}

// eslint-disable-next-line no-control-regex
const stripControl = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/** Lowercase, hyphenate, and cut to Ruby's skill-name rules. Returns null if nothing usable remains. */
export function normalizeSkillName(raw: string): string | null {
  const n = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return NAME_RE.test(n) ? n : null;
}

export function planImport(source: Source, fromDir: string): ImportPlan {
  if (source !== 'openclaw' && source !== 'hermes') throw new Error(`Unknown source "${String(source)}": use openclaw or hermes.`);
  let sc: Scanner;
  try {
    sc = makeScanner(fromDir);
  } catch {
    throw new Error(`Source directory not found: ${fromDir}`);
  }
  if (!sc.isDir(sc.root)) throw new Error(`Source is not a directory: ${fromDir}`);
  return source === 'openclaw' ? planOpenClaw(sc, fromDir) : planHermes(sc, fromDir);
}

// ---- OpenClaw ----

function planOpenClaw(sc: Scanner, fromDir: string): ImportPlan {
  const plan = emptyPlan('openclaw', fromDir);
  // Default workspace is <home>/workspace; --from may also point straight at a workspace.
  const ws = join(sc.root, 'workspace');
  const content = sc.isDir(ws) ? ws : sc.root;
  plan.contentDir = content;
  const r = (name: string) => join(content, name);
  const text = (name: string) => sc.readText(r(name));

  const mem = text('MEMORY.md');
  if (mem !== null) plan.memory.push(memoryAction('memory', sc.rel(r('MEMORY.md')), parseMarkdownEntries(mem)));
  const usr = text('USER.md');
  if (usr !== null) plan.memory.push(memoryAction('user', sc.rel(r('USER.md')), parseMarkdownEntries(usr)));

  const personaParts: { file: string; label: string; text: string; optional: boolean }[] = [];
  for (const [file, label, optional] of [['SOUL.md', 'Soul', false], ['IDENTITY.md', 'Identity', false], ['AGENTS.md', 'Operating instructions', true]] as const) {
    const t = text(file);
    if (t !== null && t.trim()) personaParts.push({ file: sc.rel(r(file)), label, text: t, optional });
  }
  plan.persona = buildPersona(personaParts, 'openclaw');
  // AGENTS.md is only partly mapped (and IDENTITY/SOUL when truncated), so keep the originals.
  for (const p of personaParts) if (p.file.endsWith('AGENTS.md') || plan.persona?.truncated) addCopy(plan, p.file, 'persona source kept in full');

  for (const [file, why] of [
    ['HEARTBEAT.md', 'heartbeat checklist: recreate as a Ruby heartbeat/cron job'],
    ['TOOLS.md', 'tool notes have no Ruby equivalent'],
    ['BOOTSTRAP.md', 'first-run script has no Ruby equivalent'],
  ] as const) {
    if (text(file) !== null) addCopy(plan, sc.rel(r(file)), why);
  }
  const daily = join(content, 'memory');
  for (const e of sc.list(daily)) {
    if (!e.dir && e.name.endsWith('.md') && sc.readBuffer(join(daily, e.name)) !== null) addCopy(plan, sc.rel(join(daily, e.name)), 'daily memory note (Ruby has no daily notes)');
  }
  for (const e of sc.list(sc.root)) {
    if (e.dir && /^workspace-.+/.test(e.name)) plan.warnings.push(`Found another agent workspace "${e.name}"; only the default workspace is imported. Run again with --from ${join(fromDir, e.name)} to import it.`);
  }

  // Skills: workspace skills win over managed ones in ~/.openclaw/skills.
  const roots = [join(content, 'skills')];
  if (content !== sc.root) roots.push(join(sc.root, 'skills'));
  collectSkills(sc, plan, roots, new Set());

  scanSecrets(sc, plan, [join(sc.root, '.env'), join(content, '.env')]);
  const cfg = sc.readText(join(sc.root, 'openclaw.json'));
  if (cfg !== null) {
    for (const m of cfg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) addEnv(plan, m[1]!);
    for (const c of CHANNELS) if (new RegExp(`["']?${c}["']?\\s*:\\s*\\{`, 'i').test(cfg)) addChannel(plan, c);
    plan.notImported.push({ what: 'openclaw.json', why: 'models, provider settings, API keys, tool policies, cron jobs and channel tokens are not imported; configure Ruby with `ruby setup` (keys go in the encrypted store or ~/.ruby/env)' });
    if (/"?(apiKey|token|botToken|secret)"?\s*:\s*["'][^"'$]/i.test(cfg)) {
      plan.notImported.push({ what: 'inline secrets in openclaw.json', why: 'never imported or copied; store the ones you still need with `ruby secrets set <NAME>`' });
    }
  }
  finish(sc, plan);
  return plan;
}

// ---- Hermes ----

function planHermes(sc: Scanner, fromDir: string): ImportPlan {
  const plan = emptyPlan('hermes', fromDir);
  plan.contentDir = sc.root;
  const mdir = join(sc.root, 'memories');
  const mem = sc.readText(join(mdir, 'MEMORY.md'));
  if (mem !== null) plan.memory.push(memoryAction('memory', sc.rel(join(mdir, 'MEMORY.md')), parseDelimitedEntries(mem)));
  const usr = sc.readText(join(mdir, 'USER.md'));
  if (usr !== null) plan.memory.push(memoryAction('user', sc.rel(join(mdir, 'USER.md')), parseDelimitedEntries(usr)));

  const soul = sc.readText(join(sc.root, 'SOUL.md'));
  if (soul !== null && soul.trim()) {
    plan.persona = buildPersona([{ file: 'SOUL.md', label: 'Soul', text: soul, optional: false }], 'hermes');
    if (plan.persona?.truncated) addCopy(plan, 'SOUL.md', 'persona source kept in full');
  }

  // Bundled skills are synced into ~/.hermes/skills too; skip the ones its manifest lists (format assumed).
  const skip = new Set<string>();
  const manifest = sc.readText(join(sc.root, 'skills', '.bundled_manifest'));
  if (manifest !== null) {
    for (const l of manifest.split('\n')) {
      const n = l.trim().split(/[:\s]/)[0];
      if (n) skip.add(n);
    }
    plan.notImported.push({ what: 'bundled Hermes skills', why: `${skip.size} skills listed in skills/.bundled_manifest ship with Hermes itself and are skipped` });
  }
  collectSkills(sc, plan, [join(sc.root, 'skills')], skip);

  scanSecrets(sc, plan, [join(sc.root, '.env')]);
  if (sc.exists(join(sc.root, 'auth.json'))) plan.notImported.push({ what: 'auth.json', why: 'OAuth credentials are never imported; sign in to your provider again in Ruby' });
  const cfg = sc.readText(join(sc.root, 'config.yaml'));
  if (cfg !== null) {
    for (const c of CHANNELS) if (new RegExp(`^\\s*${c}\\s*:`, 'im').test(cfg)) addChannel(plan, c);
    for (const m of cfg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) addEnv(plan, m[1]!);
    plan.notImported.push({ what: 'config.yaml', why: 'model/provider settings, MCP servers, toolsets and gateway settings are not imported; configure Ruby with `ruby setup` (or config.json; `ruby config explain` lists every setting)' });
  }
  for (const [name, why] of [['cron', 'scheduled jobs: recreate them under "jobs" in config.json (`ruby config explain`), then check with `ruby jobs list`'], ['state.db', 'session history is not imported'], ['sessions', 'session history is not imported']] as const) {
    if (sc.exists(join(sc.root, name))) plan.notImported.push({ what: name, why });
  }
  finish(sc, plan);
  return plan;
}

// ---- shared helpers ----

function emptyPlan(source: Source, fromDir: string): ImportPlan {
  return { source, fromDir, contentDir: fromDir, memory: [], persona: null, skills: [], copies: [], notImported: [], envVars: [], channels: [], warnings: [] };
}

function finish(sc: Scanner, plan: ImportPlan): void {
  for (const m of plan.memory) {
    if (m.fitCount < m.entries.length || m.skipped.length > 0 || m.shortened > 0) addCopy(plan, m.from, 'full original memory file; curate it with `ruby memory edit`');
  }
  plan.warnings.push(...sc.warnings);
  const total = plan.skills.length;
  if (total > 50) plan.warnings.push(`${total} skills found; consider archiving the ones you do not need (ruby skills).`);
  if (plan.channels.length) {
    plan.notImported.push({ what: `channel settings (${plan.channels.join(', ')})`, why: 'tokens and pairings are not imported; enable the matching Ruby channels (Telegram, Discord, Signal) with `ruby setup` and pair again with `ruby pair`' });
  }
  if (plan.envVars.length) {
    plan.notImported.push({ what: `secrets (${plan.envVars.length} env var names)`, why: 'values are never read or copied; store the ones you still need with `ruby secrets set <NAME>` (or in ~/.ruby/env)' });
  }
}

function addCopy(plan: ImportPlan, src: string, reason: string): void {
  if (plan.copies.some((c) => c.src === src)) return;
  plan.copies.push({ src, dest: `imported/${plan.source}/${src}`, reason });
}
function addEnv(plan: ImportPlan, name: string): void {
  if (!plan.envVars.includes(name)) plan.envVars.push(name);
  const m = /^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX)_/.exec(name);
  if (m) addChannel(plan, m[1]!.toLowerCase());
}
function addChannel(plan: ImportPlan, c: string): void {
  if (!plan.channels.includes(c)) plan.channels.push(c);
}

/** Collect variable NAMES only. Values are never stored in the plan. */
function scanSecrets(sc: Scanner, plan: ImportPlan, files: string[]): void {
  for (const f of files) {
    const t = sc.readText(f);
    if (t === null) continue;
    for (const line of t.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) addEnv(plan, m[1]!);
    }
    plan.notImported.push({ what: sc.rel(f), why: 'secrets file: never imported or copied' });
  }
}

function clean(s: string): string {
  return stripControl(s.replace(/\s+/g, ' ')).trim();
}

/** OpenClaw MEMORY.md/USER.md are free-form markdown: every bullet or non-empty line is one entry; headings are dropped. */
export function parseMarkdownEntries(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const l = raw.trim();
    if (!l || /^#{1,6}\s/.test(l) || /^(-{3,}|\*{3,}|_{3,})$/.test(l) || /^<!--.*-->$/.test(l)) continue;
    out.push(l.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
  }
  return out;
}

/** Hermes stores entries separated by a line containing only "§" (confirmed in hermes-agent: ENTRY_DELIMITER = "\n§\n"). Entries may span lines. */
export function parseDelimitedEntries(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/^[ \t]*§[ \t]*$/m).map((e) => e.trim()).filter(Boolean);
}

function memoryAction(file: 'memory' | 'user', from: string, raw: string[]): MemoryAction {
  const cap = DEFAULT_LIMITS[file];
  const entries: string[] = [];
  const skipped: MemoryAction['skipped'] = [];
  let shortened = 0;
  const seen = new Set<string>();
  for (const r of raw) {
    let e = clean(r).replace(/^-\s+/, '');
    if (!e) continue;
    // The memory store's hygiene heuristic (not a security boundary): entries are replayed into prompts.
    const why = injectionReason(e);
    if (why) {
      skipped.push({ text: e.slice(0, 80), reason: why });
      continue;
    }
    if (e.length > MAX_ENTRY_CHARS) {
      e = `${e.slice(0, MAX_ENTRY_CHARS - 3).trimEnd()}...`;
      shortened++;
    }
    if (seen.has(e)) continue;
    seen.add(e);
    entries.push(e);
  }
  return { file, from, entries, fitCount: selectFit(entries, [], cap).length, cap, skipped, shortened };
}

/**
 * Choose which entries to add. Policy: the most recent (last) entries win, because both tools append new
 * facts at the end. Walk from the end, take every entry that still fits, and keep source order.
 */
export function selectFit(entries: string[], existingLines: string[], cap: number): string[] {
  const have = new Set(existingLines);
  let used = existingLines.length ? existingLines.join('\n').length : -1; // -1: first line needs no newline
  const picked: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `- ${entries[i]!}`;
    if (have.has(line)) continue;
    const next = used + 1 + line.length;
    if (next > cap) continue;
    used = next;
    picked.push(line);
  }
  return picked.reverse().map((l) => l.slice(2));
}

function buildPersona(parts: { file: string; label: string; text: string; optional: boolean }[], source: Source): PersonaAction | null {
  if (!parts.length) return null;
  const note = `\n[Imported from ${source}; truncated. Full text: workspace imported/${source}/]`;
  const header = `Imported from ${source}. Treat as the owner's style and standing preferences.`;
  const blocks = parts.map((p) => `## ${p.label}\n${stripControl(p.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008]/g, '')).trim()}`);
  const full = `${header}\n\n${blocks.join('\n\n')}`;
  if (full.length <= PERSONA_MAX) return { text: full, from: parts.map((p) => p.file), truncated: false };
  // Mandatory parts first (SOUL/IDENTITY), optional ones (AGENTS.md) only with what room is left.
  const budget = PERSONA_MAX - note.length;
  const text = `${full.slice(0, budget).trimEnd()}${note}`;
  const used = parts.filter((p, i) => full.indexOf(blocks[i]!) < budget || !p.optional);
  return { text, from: used.map((p) => p.file), truncated: true };
}

// ---- skills ----

function collectSkills(sc: Scanner, plan: ImportPlan, roots: string[], skip: Set<string>): void {
  const seen = new Map<string, string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH) return;
    const entries = sc.list(dir);
    if (entries.some((e) => !e.dir && e.name === 'SKILL.md')) {
      addSkill(sc, plan, dir, seen, skip);
      return;
    }
    for (const e of entries) {
      if (e.dir && !e.name.startsWith('.') && e.name !== 'node_modules') visit(join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) if (sc.isDir(root)) visit(root, 0);
}

function listFiles(sc: Scanner, dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  return sc.list(dir).flatMap((e) => (e.dir ? (e.name.startsWith('.') ? [] : listFiles(sc, join(dir, e.name), depth + 1)) : [join(dir, e.name)]));
}

function addSkill(sc: Scanner, plan: ImportPlan, dir: string, seen: Map<string, string>, skip: Set<string>): void {
  const file = join(dir, 'SKILL.md');
  const from = sc.rel(file);
  const dirName = dir.split(/[\\/]/).pop()!;
  if (skip.has(dirName)) return;
  const raw = sc.readText(file);
  if (raw === null) return;
  const { fm, body } = parseSkillText(raw);
  const originalName = fm.name || dirName;
  const name = normalizeSkillName(originalName) ?? normalizeSkillName(dirName);
  let description = clean(fm.description ?? '');
  if (!description) description = clean(body.split('\n').find((l) => l.trim() && !/^#/.test(l.trim())) ?? '');
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 3).trimEnd()}...`;
  const action: SkillAction = { name: name ?? '', originalName, description, body: '', from, extraFiles: [], bodyTruncated: false };
  // Keep newlines and tabs, drop other control characters.
  let text = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (text.length > MAX_BODY) {
    const note = '\n\n[Imported skill truncated to fit Ruby\'s limit; the original is under the workspace imported/ folder.]';
    text = `${text.slice(0, MAX_BODY - note.length).trimEnd()}${note}`;
    action.bodyTruncated = true;
  }
  action.body = text;
  if (!name) action.conflict = `name "${originalName}" cannot be converted to a valid Ruby skill name`;
  else if (!description) action.conflict = 'no description in frontmatter and none could be derived';
  else if (!text) action.conflict = 'skill body is empty';
  else if (seen.has(name)) action.conflict = `name "${name}" already taken by ${seen.get(name)!} in this source`;
  if (name && !seen.has(name)) seen.set(name, from);
  const extras = listFiles(sc, dir).filter((p) => p !== file && sc.readBuffer(p) !== null);
  action.extraFiles = extras.map((p) => sc.rel(p));
  if (action.extraFiles.length || action.bodyTruncated) {
    for (const p of [from, ...action.extraFiles]) addCopy(plan, p, `skill "${name ?? originalName}": ${action.extraFiles.length ? 'supporting files Ruby skills cannot hold' : 'original body'}`);
  }
  plan.skills.push(action);
}

/** Minimal frontmatter reader: top-level `key: value` pairs, quotes stripped, folded/literal blocks joined. */
export function parseSkillText(text: string): { fm: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { fm: {}, body: t };
  const fm: Record<string, string> = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      v = parts.join(' ');
    }
    fm[kv[1]!] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fm, body: t.slice(m[0].length) };
}
