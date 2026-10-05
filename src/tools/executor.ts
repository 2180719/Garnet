import {
  errorMessage,
  isRubyError,
  type ErrorCategory,
  type ToolCallBlock,
  type ToolContext,
  type ToolResult,
} from '../contracts/index.ts';
import type { Approver, Policy } from '../policy/index.ts';
import type { ToolRegistry } from './registry.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 20_000;

export type ExecutorDeps = {
  registry: ToolRegistry;
  policy: Policy;
  approver: Approver;
};

/**
 * Validates, authorizes and runs tool calls. Every failure becomes a compact,
 * actionable error result for the model; nothing here throws for tool-level
 * problems.
 */
export class ToolExecutor {
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  async execute(call: ToolCallBlock, ctx: Omit<ToolContext, 'callId'>): Promise<ToolResult> {
    const started = Date.now();
    const fail = (category: ErrorCategory, content: string): ToolResult => ({
      status: 'error',
      category,
      content,
      durationMs: Date.now() - started,
    });

    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      return fail('invalid_input', `Unknown tool "${call.name}". Available tools: ${this.deps.registry.names().join(', ')}.`);
    }

    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return fail('invalid_input', `Invalid arguments for ${tool.name}: ${issues}. Fix the arguments and call again.`);
    }
    const input = parsed.data;
    const fullCtx: ToolContext = { ...ctx, callId: call.id };

    let targets: string[];
    try {
      targets = tool.targets?.(input, fullCtx) ?? [];
    } catch (e) {
      return fail(isRubyError(e) ? e.category : 'invalid_input', errorMessage(e));
    }

    const decision = this.deps.policy.check(tool.capability);
    if (decision.verdict === 'deny') {
      return fail('denied', `Not permitted: ${decision.reason}. Do not retry; tell the owner if this is needed.`);
    }
    if (decision.verdict === 'ask') {
      const answer = await this.deps.approver({
        sessionId: ctx.sessionId,
        callId: call.id,
        tool: tool.name,
        capability: tool.capability,
        targets,
        summary: `${tool.name} ${targets.join(', ')}`.trim(),
      });
      if (answer === 'denied') return fail('denied', 'The owner declined this operation. Do not retry it.');
      if (answer === 'deferred') return fail('needs_approval', 'Waiting for the owner to approve this operation.');
    }

    if (ctx.signal.aborted) return fail('cancelled', 'Cancelled before the tool started.');
    const timeout = AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    try {
      const output = await raceAbort(tool.run(input, { ...fullCtx, signal }), signal);
      const max = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
      const truncated = output.content.length > max;
      const content = truncated
        ? `${output.content.slice(0, max)}\n[output truncated: showing ${max} of ${output.content.length} characters]`
        : output.content;
      return { status: 'ok', content, truncated, durationMs: Date.now() - started };
    } catch (e) {
      if (timeout.aborted && !ctx.signal.aborted) return fail('timeout', `${tool.name} timed out.`);
      if (ctx.signal.aborted) return fail('cancelled', `${tool.name} was cancelled.`);
      return fail(isRubyError(e) ? e.category : 'tool_failed', errorMessage(e));
    }
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
