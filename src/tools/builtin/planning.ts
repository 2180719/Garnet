import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;

type Todo = { content: string; status: keyof typeof MARK };

/**
 * `todo_list`: the model's own checklist for multi-step work. Each call sends the whole list, so the latest call
 * in the history is the current state; nothing is stored outside the event log. Changes nothing outside the session.
 */
export const todoListTool: ToolDefinition<{ todos: Todo[] }> = {
  name: 'todo_list',
  version: 1,
  description: 'Keep a checklist for a task with several steps. Send the complete list every time (it replaces the previous one). At most one item is in_progress. Update it as you finish steps; skip it for simple requests.',
  input: z.object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1).max(300).describe('One step, in the imperative.'),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .max(30),
  }),
  capability: 'fs.read',
  capabilitiesFor: () => [],
  idempotent: true,
  async run({ todos }) {
    if (todos.filter((t) => t.status === 'in_progress').length > 1) {
      throw new GarnetError('invalid_input', 'Only one item can be in_progress at a time. Mark the others pending or completed.');
    }
    if (todos.length === 0) return { content: 'Checklist cleared.' };
    const done = todos.filter((t) => t.status === 'completed').length;
    return { content: `Checklist (${done}/${todos.length} done):\n${todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n')}` };
  },
};

/**
 * `clarify`: ask the owner a question the task cannot proceed without. It is a plain tool result telling the model
 * to put the question in its reply and wait, so it works on every channel without new UI.
 */
export const clarifyTool: ToolDefinition<{ question: string; options: string[] }> = {
  name: 'clarify',
  version: 1,
  description: 'Ask the user a question you cannot reasonably answer yourself, optionally with 2-6 choices. Use it only when a wrong guess would waste real work or cause harm; otherwise pick a sensible default and say so.',
  input: z.object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(100)).max(6).default([]).describe('Short answers to offer; leave empty for an open question.'),
  }),
  capability: 'fs.read',
  capabilitiesFor: () => [],
  idempotent: true,
  async run({ question, options }) {
    if (options.length === 1) throw new GarnetError('invalid_input', 'Give at least two options, or none for an open question.');
    const choices = options.length ? `\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '';
    return {
      content: `Question for the user:\n${question}${choices}\n\nSend exactly this question as your reply now, numbering any options so they can answer with a number, and stop. Do not continue the task until they answer.`,
    };
  },
};
