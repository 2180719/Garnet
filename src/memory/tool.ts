import { z } from 'zod';
import type { ToolDefinition } from '../contracts/index.ts';
import type { MemoryStore } from './store.ts';

const input = z
  .object({
    action: z.enum(['add', 'replace', 'remove']).describe('add a new entry, replace an existing one, or remove one.'),
    target: z.enum(['memory', 'user']).describe('"memory" for your own notes (environment, conventions, lessons); "user" for the owner (preferences, communication style).'),
    text: z.string().min(1).max(2000).optional().describe('The entry text (one short line, max 500 chars). Required for add and replace.'),
    old_text: z.string().min(1).max(2000).optional().describe('A unique substring of the existing entry to replace or remove. Required for replace and remove.'),
  })
  .superRefine((v, ctx) => {
    const need = (field: 'text' | 'old_text') => {
      if (!v[field]) ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required for action "${v.action}".` });
    };
    if (v.action === 'add' || v.action === 'replace') need('text');
    if (v.action === 'replace' || v.action === 'remove') need('old_text');
  });

export type MemoryToolInput = z.infer<typeof input>;

export function memoryTool(store: MemoryStore): ToolDefinition<MemoryToolInput> {
  return {
    name: 'memory',
    version: 1,
    description:
      'Save durable facts to your small persistent memory, shown at the start of every session. ' +
      'Keep only what is worth remembering across sessions (environment facts, conventions, lessons), never task progress. ' +
      'Save owner preferences and communication style to target "user". Space is limited: when full, replace or remove entries to consolidate. ' +
      'Changes appear in the next session\'s prompt, not this one.',
    input,
    capability: 'memory.write',
    idempotent: false,
    async run(i, ctx) {
      const ns = ctx.memoryNamespace;
      const name = store.fileName(i.target);
      const r =
        i.action === 'add'
          ? store.add(ns, i.target, i.text ?? '')
          : i.action === 'replace'
            ? store.replace(ns, i.target, i.old_text ?? '', i.text ?? '')
            : store.remove(ns, i.target, i.old_text ?? '');
      const verb = i.action === 'add' ? 'Saved to' : i.action === 'replace' ? 'Updated in' : 'Removed from';
      return {
        content: `${verb} ${name} (${r.used}/${r.limit} chars). It takes effect in the next session's prompt.`,
        data: { used: r.used, limit: r.limit },
      };
    },
  };
}
