import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GarnetError } from '../contracts/index.ts';
import { parseSkillFile } from './frontmatter.ts';
import { MAX_BODY, MAX_DESCRIPTION, NAME_RE } from './store.ts';

export type BuiltinSkill = { name: string; description: string; body: string };

/** Where the shipped skills live: src/skills/builtin/<name>/SKILL.md. */
export const BUILTIN_SKILLS_DIR = join(import.meta.dirname, 'builtin');

/**
 * Optional skills shipped with Garnet. Read-only: they live in the install,
 * which Garnet never writes (no sidecars, no usage counts, no proposals). A
 * skill is offered to a session only when config turns it on for that
 * session's scope; a skill of the same name in <home>/skills takes precedence.
 */
export class BuiltinSkills {
  private readonly skills: Map<string, BuiltinSkill>;

  constructor(root: string = BUILTIN_SKILLS_DIR) {
    this.skills = new Map(load(root).map((s) => [s.name, s]));
  }

  /** Every shipped skill, sorted by name. */
  list(): BuiltinSkill[] {
    return [...this.skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  get(name: string): BuiltinSkill | undefined {
    return this.skills.get(name);
  }

  /**
   * The prompt section for a session's active built-in skills (names not
   * shipped, or shadowed by a local skill, are left out). Deterministic, so it
   * is cache-friendly; empty when none are active.
   */
  index(active: readonly string[], shadowed: (name: string) => boolean = () => false): string {
    const shown = [...active].sort().flatMap((n) => {
      const s = this.skills.get(n);
      return s && !shadowed(n) ? [s] : [];
    });
    if (!shown.length) return '';
    return ['Built-in skills (shipped with Garnet). Call skill_view with the name before following one:', ...shown.map((s) => `- ${s.name}: ${s.description}`)].join('\n');
  }
}

/** Loads and checks every shipped skill. A broken one is a bug in the install, so it throws. */
function load(root: string): BuiltinSkill[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return dirs.map((dir) => {
    const bad = (why: string): never => {
      throw new GarnetError('internal', `Built-in skill ${dir} is broken: ${why}.`);
    };
    if (!NAME_RE.test(dir)) bad('the folder name is not a valid skill name');
    const parsed = parseSkillFile(readFileSync(join(root, dir, 'SKILL.md'), 'utf8'));
    if (typeof parsed === 'string') return bad(parsed);
    const get = (k: string) => parsed.entries.find((e) => e.key === k)?.value;
    const description = get('description') ?? '';
    if (get('name') !== dir) bad(`frontmatter name must be "${dir}"`);
    if (!description || description.length > MAX_DESCRIPTION) bad(`description must be 1 to ${MAX_DESCRIPTION} characters`);
    const body = parsed.body.replace(/^\n+/, '');
    if (body.length > MAX_BODY) bad(`body is longer than ${MAX_BODY} characters`);
    return { name: dir, description, body };
  });
}
