import { z } from 'zod';
import { GarnetError, type ToolDefinition, type ToolOutput } from '../../contracts/index.ts';

type DelegateInput = { task: string; provider?: string; model?: string };

/**
 * `delegate_task`: hands a self-contained task to a subagent and returns its final report. The subagent runs under
 * the same permissions and untrusted-content state as this session (the runner is bound to them by the runtime),
 * with a smaller budget, so delegating never widens what Garnet may do. The tool itself needs no permission: every
 * action the subagent takes is checked on its own. If the subagent read untrusted content, the report is marked
 * untrusted so the parent is contained too.
 */
export const delegateTaskTool: ToolDefinition<DelegateInput> = {
  name: 'delegate_task',
  version: 1,
  description:
    'Give a self-contained task to a subagent and get back its final report. Use it for side work that would clutter this conversation (research, a long search, a second opinion) or that suits another model. The subagent knows nothing you have not put in `task`. Optionally pick `provider` (a configured provider name) and/or `model`; omit both to use the current model. Subagents may delegate further only within a small depth limit.',
  input: z.object({
    task: z.string().min(1).max(20_000).describe('Everything the subagent needs: the goal, relevant details, and the form of answer you want.'),
    provider: z.string().min(1).max(64).optional().describe('Name of a configured provider (e.g. "default", "local"). With no model, its own model is used.'),
    model: z.string().min(1).max(200).optional().describe('Model name to use on that provider (or on the current provider if `provider` is omitted).'),
  }),
  capability: 'fs.read',
  capabilitiesFor: () => [],
  idempotent: false,
  // A subagent can take as long as a whole task; the runtime's own limits (budget, wall clock, cancellation) apply inside it.
  timeoutMs: 30 * 60_000,
  maxOutputChars: 20_000,
  async run(input, ctx): Promise<ToolOutput> {
    if (!ctx.subagents) throw new GarnetError('denied', 'Delegation is not available in this session.');
    const outcome = await ctx.subagents.run(input, ctx.signal);
    const where = `${outcome.provider}/${outcome.model}`;
    const stats = `${outcome.modelCalls} model call(s), ${outcome.toolCalls} tool call(s)`;
    const untrusted = outcome.newTaint.length > 0 ? { untrusted: { source: `subagent on ${where} read untrusted content: ${outcome.newTaint.join('; ').slice(0, 300)}` } } : {};
    const data = { sessionId: outcome.sessionId, status: outcome.status, provider: outcome.provider, model: outcome.model };
    switch (outcome.status) {
      case 'completed':
        return { content: `Subagent report (${where}; ${stats}):\n${outcome.text || '(the subagent finished without a reply)'}`, data, ...untrusted };
      case 'budget_exhausted':
        return { content: `The subagent ran out of budget (${stats}) before finishing.${outcome.text ? `\nIts last words:\n${outcome.text}` : ''}`, error: 'budget_exhausted', data, ...untrusted };
      case 'cancelled':
        return { content: 'The subagent was cancelled.', error: 'cancelled', data, ...untrusted };
      case 'waiting_for_approval':
      case 'waiting_for_user':
        return {
          content: `The subagent stopped because an action needed the owner's approval, which cannot be given inside a subagent. Do that step yourself or ask the owner.${outcome.text ? `\nIts last words:\n${outcome.text}` : ''}`,
          error: 'needs_approval',
          data,
          ...untrusted,
        };
      default:
        return { content: `The subagent failed (${stats}).${outcome.text ? `\nIts last words:\n${outcome.text}` : ''}`, error: 'tool_failed', data, ...untrusted };
    }
  },
};
