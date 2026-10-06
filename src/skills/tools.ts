import { z } from 'zod';
import type { ToolDefinition } from '../contracts/index.ts';
import { MAX_BODY, MAX_DESCRIPTION, MAX_SKILL_FILE, type SkillStore } from './store.ts';
import type { BuiltinSkill } from './builtin.ts';

export type SkillToolOptions = {
  /**
   * A built-in skill active in this session, by name (undefined when it is not
   * shipped or not on for the session). Consulted only when <home>/skills has
   * no skill of that name.
   */
  builtin?: (name: string, sessionId: string) => BuiltinSkill | undefined;
};

const name = z.string().min(1).max(64).describe('Skill name: lowercase letters, digits and hyphens.');
const description = z.string().min(1).max(MAX_DESCRIPTION).describe('One line saying what the skill does and when to use it.');
const body = z.string().min(1).max(MAX_BODY).describe('Markdown instructions: generic, numbered steps, no one-off details.');

export function skillTools(store: SkillStore, options: SkillToolOptions = {}): ToolDefinition[] {
  const view: ToolDefinition<{ name: string; file?: string | undefined }> = {
    name: 'skill_view',
    version: 1,
    description:
      'Load the full instructions of a skill from the skills index, plus the list of files bundled with it (references/, scripts/, assets). Call this before following a skill. Pass "file" (a relative path from that list, e.g. references/api.md) to read one bundled text file instead.',
    input: z.object({
      name,
      file: z.string().min(1).max(256).optional().describe('Relative path of a bundled text file, as listed by skill_view.'),
    }),
    capability: 'fs.read',
    idempotent: true,
    maxOutputChars: Math.max(MAX_BODY, MAX_SKILL_FILE) + 1000,
    async run({ name, file }, ctx) {
      const shipped = store.has(name) ? undefined : options.builtin?.(name, ctx.sessionId);
      if (shipped) {
        if (file !== undefined) return { content: `Built-in skill "${name}" has no bundled files.`, error: 'invalid_input' };
        return { content: `# Skill: ${shipped.name} (built in)\n${shipped.description}\n\n${shipped.body}`, data: { name: shipped.name, builtin: true } };
      }
      if (file !== undefined) return { content: store.readFile(name, file), data: { name, file } };
      const s = store.view(name);
      const files = store.files(name);
      const list = files.length
        ? `\n\n## Bundled files\nRead one with skill_view {"name": "${s.name}", "file": "<path>"}. Scripts are text to read; run them only through your normal tools.\n${files.map((f) => `- ${f}`).join('\n')}`
        : '';
      return { content: `# Skill: ${s.name}\n${s.description}\n\n${s.body}${list}`, data: { name: s.name } };
    },
  };

  const create: ToolDefinition<{ name: string; description: string; body: string }> = {
    name: 'skill_create',
    version: 1,
    description:
      'Save a reusable procedure as a skill, only after you completed a task whose steps are likely to be needed again. Write the steps generically, without one-off details or secrets.',
    input: z.object({ name, description, body }),
    capability: 'memory.write',
    idempotent: false,
    async run(i) {
      store.create(i.name, i.description, i.body, 'agent');
      return { content: `Skill "${i.name}" created.`, data: { status: 'created' } };
    },
  };

  const update: ToolDefinition<{ name: string; description?: string | undefined; body: string }> = {
    name: 'skill_update',
    version: 1,
    description:
      'Replace a skill\'s instructions when you found a better way. Provide the complete new body. If your owner has edited the skill, your change is saved as a proposal for them to review.',
    input: z.object({ name, description: description.optional(), body }),
    capability: 'memory.write',
    idempotent: false,
    async run(i) {
      const r = store.update(i.name, i.description === undefined ? { body: i.body } : { description: i.description, body: i.body });
      return {
        content:
          r.status === 'proposed'
            ? 'This skill was edited by your owner, so your change was saved as a proposal for them to review.'
            : `Skill "${i.name}" updated.`,
        data: { status: r.status },
      };
    },
  };

  return [view, create, update];
}
