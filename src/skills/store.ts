import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { GarnetError } from '../contracts/index.ts';
import { injectionReason } from '../memory/index.ts';
import { parseSkillFile, serializeSkillFile, type Entry } from './frontmatter.ts';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_DESCRIPTION = 300;
export const MAX_BODY = 20_000;

export type Provenance = 'agent' | 'user';

export type SkillMeta = {
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
  uses: number;
  lastUsedAt: string | null;
  agentHash: string | null;
  archived: boolean;
};

export type SkillInfo = {
  name: string;
  description: string;
  provenance: Provenance;
  locked: boolean;
  uses: number;
  lastUsedAt: string | null;
  hasProposal: boolean;
  archived: boolean;
};

export type SkillProblem = { name: string; problem: string };

type Loaded = {
  name: string;
  description: string;
  body: string;
  others: Entry[];
  content: string;
  meta: SkillMeta;
  hasSidecar: boolean;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function bad(message: string): never {
  throw new GarnetError('invalid_input', message);
}

function checkFields(description: string, body: string): void {
  if (description.trim() === '') bad('Skill description must not be empty.');
  if (description.length > MAX_DESCRIPTION || /[\r\n]/.test(description))
    bad(`Skill description must be one line of at most ${MAX_DESCRIPTION} characters.`);
  // The description is replayed into every session's prompt (the skills index), like memory.
  const why = injectionReason(description);
  if (why) bad(`Skill description rejected: it ${why}. Describe what the skill does and when to use it.`);
  if (body.trim() === '') bad('Skill body must not be empty.');
  if (body.length > MAX_BODY) bad(`Skill body is too long (${body.length} characters; maximum ${MAX_BODY}). Make it more concise.`);
}

/** Largest bundled file `readFile` returns, in bytes. */
export const MAX_SKILL_FILE = 64 * 1024;
const MAX_FILE_DEPTH = 4;
const MAX_LISTED_FILES = 100;

export class SkillStore {
  readonly root: string;
  private readonly now: () => Date;
  private problemList: SkillProblem[] = [];

  constructor(opts: { root: string; now?: () => Date }) {
    this.root = opts.root;
    this.now = opts.now ?? (() => new Date());
  }

  // ---- paths and helpers ----

  private checkName(name: string): void {
    if (!NAME_RE.test(name)) bad(`Invalid skill name "${name}". Use lowercase letters, digits and hyphens (max 64), starting with a letter or digit.`);
  }
  private dir(name: string): string {
    this.checkName(name);
    return join(this.root, name);
  }
  private skillPath(name: string): string {
    return join(this.dir(name), 'SKILL.md');
  }
  private proposalPath(name: string): string {
    return join(this.dir(name), 'PROPOSED.md');
  }
  private metaPath(name: string): string {
    return join(this.dir(name), '.garnet.json');
  }
  /** Sidecar name used before the rename to Garnet; read when the new one is missing. */
  private legacyMetaPath(name: string): string {
    return join(this.dir(name), '.ruby.json');
  }
  private iso(): string {
    return this.now().toISOString();
  }

  private readMeta(name: string): { meta: SkillMeta; found: boolean } {
    const fallback = (): SkillMeta => {
      const t = this.iso();
      return { provenance: 'user', createdAt: t, updatedAt: t, uses: 0, lastUsedAt: null, agentHash: null, archived: false };
    };
    try {
      const file = existsSync(this.metaPath(name)) ? this.metaPath(name) : this.legacyMetaPath(name);
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<SkillMeta>;
      const base = fallback();
      return {
        found: true,
        meta: {
          provenance: j.provenance === 'agent' ? 'agent' : 'user',
          createdAt: typeof j.createdAt === 'string' ? j.createdAt : base.createdAt,
          updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : base.updatedAt,
          uses: typeof j.uses === 'number' && j.uses >= 0 ? j.uses : 0,
          lastUsedAt: typeof j.lastUsedAt === 'string' ? j.lastUsedAt : null,
          agentHash: typeof j.agentHash === 'string' ? j.agentHash : null,
          archived: j.archived === true,
        },
      };
    } catch {
      // Missing or unreadable sidecar: treat as owner-provided (locked).
      return { meta: fallback(), found: false };
    }
  }

  private writeMeta(name: string, meta: SkillMeta): void {
    this.ensureDir(this.dir(name));
    writeAtomic(this.metaPath(name), `${JSON.stringify(meta, null, 2)}\n`);
  }

  private ensureDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  private load(name: string): Loaded | string {
    let content: string;
    try {
      content = readFileSync(this.skillPath(name), 'utf8');
    } catch {
      return 'SKILL.md could not be read';
    }
    const parsed = parseSkillFile(content);
    if (typeof parsed === 'string') return parsed;
    const get = (k: string) => parsed.entries.find((e) => e.key === k)?.value;
    const fmName = get('name');
    const description = get('description');
    if (!fmName) return 'frontmatter is missing "name"';
    if (fmName !== name) return `frontmatter name "${fmName}" does not match directory "${name}"`;
    if (!description) return 'frontmatter is missing "description"';
    if (description.length > MAX_DESCRIPTION) return `description is longer than ${MAX_DESCRIPTION} characters`;
    if (parsed.body.length > MAX_BODY) return `body is longer than ${MAX_BODY} characters`;
    const { meta, found } = this.readMeta(name);
    return {
      name,
      description,
      body: parsed.body.replace(/^\n+/, ''),
      others: parsed.entries.filter((e) => e.key !== 'name' && e.key !== 'description'),
      content,
      meta,
      hasSidecar: found,
    };
  }

  private isLocked(s: Loaded): boolean {
    return s.meta.provenance === 'user' || s.meta.agentHash === null || sha(s.content) !== s.meta.agentHash;
  }

  private info(s: Loaded): SkillInfo {
    return {
      name: s.name,
      description: s.description,
      provenance: s.meta.provenance,
      locked: this.isLocked(s),
      uses: s.meta.uses,
      lastUsedAt: s.meta.lastUsedAt,
      hasProposal: existsSync(this.proposalPath(s.name)),
      archived: s.meta.archived,
    };
  }

  private names(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private all(): Loaded[] {
    const out: Loaded[] = [];
    const problems: SkillProblem[] = [];
    for (const name of this.names()) {
      if (!NAME_RE.test(name)) {
        problems.push({ name, problem: 'directory name is not a valid skill name' });
        continue;
      }
      if (!existsSync(this.skillPath(name))) continue;
      const s = this.load(name);
      if (typeof s === 'string') problems.push({ name, problem: s });
      else out.push(s);
    }
    this.problemList = problems;
    return out;
  }

  private require(name: string): Loaded {
    const s = this.load(name);
    if (typeof s === 'string') bad(existsSync(this.skillPath(name)) ? `Skill "${name}" is unusable: ${s}.` : `No skill named "${name}". Check the skills index.`);
    return s;
  }

  // ---- reads ----

  /** True when <root>/<name>/SKILL.md exists (usable, archived or broken): such a skill shadows a built-in of the same name. */
  has(name: string): boolean {
    return NAME_RE.test(name) && existsSync(this.skillPath(name));
  }

  list(): SkillInfo[] {
    return this.all()
      .filter((s) => !s.meta.archived)
      .map((s) => this.info(s));
  }

  /** Archived skills, so the owner can find and restore them. */
  archived(): SkillInfo[] {
    return this.all()
      .filter((s) => s.meta.archived)
      .map((s) => this.info(s));
  }

  /** Skills skipped by the most recent list()/index()/stale() scan, with the reason. */
  problems(): SkillProblem[] {
    this.all();
    return [...this.problemList];
  }

  /** Deterministic prompt section: no counts or timestamps, so prompt caching stays stable. */
  index(): string {
    const skills = this.list();
    if (skills.length === 0) return 'Skills: none yet.';
    return [
      'Skills (reusable procedures). Call skill_view with the name before following one:',
      ...skills.map((s) => `- ${s.name}: ${s.description}`),
    ].join('\n');
  }

  /** Owner read: returns the skill without counting a use (works for archived skills too). */
  read(name: string): { name: string; description: string; body: string } {
    const s = this.require(name);
    return { name, description: s.description, body: s.body };
  }

  view(name: string): { name: string; description: string; body: string } {
    const s = this.require(name);
    if (s.meta.archived) bad(`Skill "${name}" is archived.`);
    this.writeMeta(name, { ...s.meta, uses: s.meta.uses + 1, lastUsedAt: this.iso() });
    return { name, description: s.description, body: s.body };
  }

  /** Files bundled with a skill (`references/`, `scripts/`, assets), as sorted relative paths. Skips SKILL.md, PROPOSED.md, dotfiles and symlinks. */
  files(name: string): string[] {
    const dir = this.dir(name);
    const out: string[] = [];
    const walk = (rel: string, depth: number): void => {
      if (depth > MAX_FILE_DEPTH || out.length >= MAX_LISTED_FILES) return;
      let entries;
      try {
        entries = readdirSync(join(dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r, depth + 1);
        else if (e.isFile() && !(rel === '' && (e.name === 'SKILL.md' || e.name === 'PROPOSED.md')) && out.length < MAX_LISTED_FILES) out.push(r);
      }
    };
    walk('', 0);
    return out;
  }

  /**
   * Reads one text file bundled with a skill. Contained to the skill's folder: relative paths only,
   * no `..`, no symlinks (checked by real path), regular files only, UTF-8 text, at most MAX_SKILL_FILE bytes.
   */
  readFile(name: string, file: string): string {
    const s = this.require(name);
    if (s.meta.archived) bad(`Skill "${name}" is archived.`);
    const dir = this.dir(name);
    const parts = file.split(/[\\/]/);
    if (!file || file.includes('\0') || isAbsolute(file) || parts.includes('..')) bad(`Invalid file "${file}": use a path relative to the skill folder, without "..".`);
    const rel = parts.filter((p) => p && p !== '.').join('/');
    if (!rel || rel.startsWith('.') || rel === 'PROPOSED.md' || rel.split('/').some((p) => p.startsWith('.'))) bad(`File "${file}" is not available. Use skill_view without "file" to list the bundled files.`);
    const full = join(dir, rel);
    let real: string;
    try {
      if (lstatSync(full).isSymbolicLink()) bad(`File "${file}" is a symbolic link and cannot be read.`);
      real = realpathSync(full);
    } catch (e) {
      if (e instanceof GarnetError) throw e;
      bad(`File "${file}" not found in skill "${name}". Use skill_view without "file" to list the bundled files.`);
    }
    const inside = relative(realpathSync(dir), real);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..')) bad(`File "${file}" is outside the skill folder.`);
    const st = lstatSync(real);
    if (!st.isFile()) bad(`"${file}" is not a regular file.`);
    if (st.size > MAX_SKILL_FILE) bad(`File "${file}" is ${st.size} bytes; the limit is ${MAX_SKILL_FILE}.`);
    const buf = readFileSync(real);
    if (buf.includes(0)) bad(`File "${file}" is binary; only text files can be read.`);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return bad(`File "${file}" is not valid UTF-8 text.`);
    }
  }

  // ---- agent writes ----

  /**
   * `frontmatter`: extra single-line keys kept verbatim in SKILL.md (the importer keeps `metadata`
   * and `requires` this way). `name` and `description` cannot be set through it.
   */
  create(name: string, description: string, body: string, provenance: Provenance = 'agent', frontmatter: Record<string, string> = {}): { status: 'created' } {
    this.checkName(name);
    checkFields(description, body);
    if (existsSync(this.dir(name))) bad(`A skill named "${name}" already exists. Use skill_update to change it.`);
    const extra: Entry[] = [];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'name' || key === 'description' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) || /[\r\n]/.test(value)) bad(`Invalid frontmatter key "${key}".`);
      extra.push({ key, raw: [`${key}: ${value}`], value });
    }
    this.ensureDir(this.root);
    this.ensureDir(this.dir(name));
    const content = serializeSkillFile(name, description, body, extra);
    writeAtomic(this.skillPath(name), content);
    const t = this.iso();
    this.writeMeta(name, {
      provenance,
      createdAt: t,
      updatedAt: t,
      uses: 0,
      lastUsedAt: null,
      agentHash: provenance === 'agent' ? sha(content) : null,
      archived: false,
    });
    return { status: 'created' };
  }

  update(name: string, change: { description?: string; body: string }): { status: 'updated' | 'proposed' } {
    const s = this.require(name);
    const description = change.description ?? s.description;
    checkFields(description, change.body);
    const content = serializeSkillFile(name, description, change.body, s.others);
    if (this.isLocked(s)) {
      writeAtomic(this.proposalPath(name), content);
      return { status: 'proposed' };
    }
    writeAtomic(this.skillPath(name), content);
    this.writeMeta(name, { ...s.meta, updatedAt: this.iso(), agentHash: sha(content) });
    return { status: 'updated' };
  }

  // ---- owner actions ----

  proposal(name: string): string | null {
    try {
      return readFileSync(this.proposalPath(name), 'utf8');
    } catch {
      return null;
    }
  }

  acceptProposal(name: string): void {
    const s = this.require(name);
    const text = this.proposal(name);
    if (text === null) bad(`Skill "${name}" has no proposal.`);
    const parsed = parseSkillFile(text);
    if (typeof parsed === 'string') bad(`The proposal is malformed: ${parsed}.`);
    // Accepting must leave a loadable skill: same name, a valid description and body.
    const get = (k: string) => parsed.entries.find((e) => e.key === k)?.value;
    if (get('name') !== name) bad(`The proposal names the skill "${get('name') ?? ''}", not "${name}"; reject it or fix PROPOSED.md.`);
    const description = get('description');
    if (!description || description.length > MAX_DESCRIPTION) bad(`The proposal needs a description of at most ${MAX_DESCRIPTION} characters.`);
    if (parsed.body.length > MAX_BODY) bad(`The proposal body is longer than ${MAX_BODY} characters.`);
    writeAtomic(this.skillPath(name), text);
    // Owner-approved content: an agent-provenance skill becomes agent-writable again;
    // a user-provenance skill stays locked because provenance is unchanged.
    this.writeMeta(name, { ...s.meta, updatedAt: this.iso(), agentHash: s.meta.provenance === 'agent' ? sha(text) : s.meta.agentHash });
    rmSync(this.proposalPath(name), { force: true });
  }

  rejectProposal(name: string): void {
    this.dir(name);
    rmSync(this.proposalPath(name), { force: true });
  }

  archive(name: string): void {
    const s = this.require(name);
    this.writeMeta(name, { ...s.meta, archived: true, updatedAt: this.iso() });
  }

  unarchive(name: string): void {
    const s = this.require(name);
    this.writeMeta(name, { ...s.meta, archived: false, updatedAt: this.iso() });
  }

  /** Agent-created, non-archived skills unused for `days`. For owner review only; never auto-deleted. */
  stale(days = 60): SkillInfo[] {
    const cutoff = this.now().getTime() - days * 86_400_000;
    return this.all()
      .filter((s) => !s.meta.archived && s.meta.provenance === 'agent')
      .filter((s) => Date.parse(s.meta.lastUsedAt ?? s.meta.createdAt) < cutoff)
      .map((s) => this.info(s));
  }
}
