import { GarnetError, textOf, type ModelAdapter, type SessionTaint, type SubagentOutcome, type SubagentRequest, type SubagentRunner } from '../contracts/index.ts';
import type { SessionStore } from '../store/index.ts';
import type { Agent } from './agent.ts';
import { sessionTaint } from './taint.ts';

/** A model chosen for a subagent: the adapter plus the provider and model names to report. */
export type ResolvedSubagentModel = { adapter: ModelAdapter; provider: string; model: string };

export type SubagentDeps = {
  store: SessionStore;
  /** How deep the agent using this factory already is (0 for the top-level agent). */
  depth: number;
  /** The deepest level a subagent may exist at (2: a subagent may start one more, which cannot start another). */
  maxDepth: number;
  /** Configured providers, for the tool's error messages. */
  providers: () => { name: string; model: string }[];
  /** Resolves the request to a model; throws a `GarnetError` naming the known providers when it cannot (unknown name, missing key). */
  resolve: (provider: string | undefined, model: string | undefined) => ResolvedSubagentModel;
  /** Builds the child's agent: same permissions as the parent, a smaller budget, its own model, one level deeper. */
  makeChild: (resolved: ResolvedSubagentModel, limits: { maxWallMs: number }) => Agent;
};

const BRIEF = [
  'You are a subagent. Another agent handed you the task below and will read only your final reply.',
  'Work on it with the tools you have, then finish with a concise report: the answer or result first, then anything the other agent must know (what you checked, what you could not do).',
  'You cannot ask the owner questions; if something is missing, say what in the report.',
].join(' ');

/**
 * Returns the function `Agent` uses to give each tool call a `SubagentRunner` bound to its session: the child runs
 * under the same permissions (the executor and approver come from `makeChild`), starts with the parent's taint, and
 * stops when the parent is cancelled or the tool call times out, and gets at most the parent's remaining time. The
 * child is a normal session in the event log (linked to its parent, so it is scoped like the parent), so its work
 * is auditable.
 */
export function subagentFactory(deps: SubagentDeps): (parent: { sessionId: string; signal: AbortSignal; taint: SessionTaint; remainingMs: number }) => SubagentRunner {
  return (parent) => ({
    providers: deps.providers,
    async run(request: SubagentRequest, callSignal?: AbortSignal): Promise<SubagentOutcome> {
      if (deps.depth >= deps.maxDepth) {
        throw new GarnetError('denied', `Subagents can nest only ${deps.maxDepth} levels deep; do this task yourself.`);
      }
      const resolved = deps.resolve(request.provider, request.model);
      const session = deps.store.createSession(`subagent: ${request.task.replace(/\s+/g, ' ').slice(0, 60)}`, undefined, parent.sessionId);
      const task = await deps.makeChild(resolved, { maxWallMs: parent.remainingMs }).run(session.id, `${BRIEF}\n\nTask:\n${request.task}`, {
        signal: callSignal ? AbortSignal.any([parent.signal, callSignal]) : parent.signal,
        source: 'subagent',
        taint: parent.taint.sources,
      });
      const events = deps.store.events(session.id);
      const reply = [...events].reverse().find((e) => e.type === 'assistant_message');
      const known = new Set(parent.taint.sources);
      return {
        sessionId: session.id,
        status: task.status,
        text: reply?.type === 'assistant_message' ? textOf(reply.message).trim() : '',
        provider: resolved.provider,
        model: resolved.model,
        modelCalls: task.modelCalls,
        toolCalls: task.toolCalls,
        newTaint: sessionTaint(events).sources.filter((s) => !known.has(s)),
      };
    },
  });
}
