import {
  errorMessage,
  isGarnetError,
  type ErrorCategory,
  type ToolCallBlock,
  type ToolContext,
  type ToolOutput,
  type ToolResult,
  type UntrustedMark,
} from '../contracts/index.ts';
import { z, type ZodType } from 'zod';
import { describeSources, type ApprovalDecision, type Approver, type Decision, type Policy } from '../policy/index.ts';
import type { ToolRegistry } from './registry.ts';
import type { ArtifactStore } from './artifacts.ts';
import { repairCall } from './repair.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 20_000;

export type ExecutorDeps = {
  registry: ToolRegistry;
  policy: Policy;
  approver: Approver;
  /** When set, oversized outputs are saved here instead of being cut off. */
  artifacts?: ArtifactStore;
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

  async execute(original: ToolCallBlock, ctx: Omit<ToolContext, 'callId'>): Promise<ToolResult> {
    const { call, repairs } = repairCall(original, this.deps.registry.names());
    const result = await this.run(call, ctx);
    if (repairs.length === 0) return result;
    // Tell the model so it learns the exact form; history itself is never rewritten.
    const note = `\n[Garnet auto-corrected this call: ${repairs.join('; ')}. Use the exact form next time.]`;
    return { ...result, content: result.content + note, repairs };
  }

  private async run(call: ToolCallBlock, ctx: Omit<ToolContext, 'callId'>): Promise<ToolResult> {
    const started = Date.now();
    // Time spent waiting on an interactive approver; reported so the task's time budget can exclude it.
    let approvalWaitMs = 0;
    const waitMeta = () => (approvalWaitMs > 0 ? { approvalWaitMs } : {});
    const fail = (category: ErrorCategory, content: string): ToolResult => ({
      status: 'error',
      category,
      content,
      durationMs: Date.now() - started,
      ...waitMeta(),
    });

    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      return fail('invalid_input', `Unknown tool "${call.name}". Available tools: ${this.deps.registry.names().join(', ')}.`);
    }

    if (ctx.allowedTools && !ctx.allowedTools.includes(tool.name)) {
      return fail('invalid_input', `Tool "${tool.name}" is not available in this session. Available tools: ${ctx.allowedTools.join(', ')}.`);
    }

    const parsed = strict(tool.input).safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => describeIssue(i, tool.input)).join('; ');
      return fail('invalid_input', `Invalid arguments for ${tool.name}: ${issues}. Fix the arguments and call again.`);
    }
    const fullCtx: ToolContext = { ...ctx, callId: call.id };
    let input = parsed.data;
    try {
      if (tool.bind) input = tool.bind(input, fullCtx);
    } catch (e) {
      return fail(isGarnetError(e) ? e.category : 'invalid_input', errorMessage(e));
    }

    let targets: string[];
    try {
      targets = tool.targets?.(input, fullCtx) ?? [];
    } catch (e) {
      return fail(isGarnetError(e) ? e.category : 'invalid_input', errorMessage(e));
    }

    // Every capability this call needs is checked (with the session's taint); the strictest verdict wins. On a tie the
    // more consequential capability labels the approval (exec, then anything but a read like net.fetch), so the owner
    // sees the write, and an "always" given for a read (keyed on the capability) can never cover it.
    const rank = { allow: 0, ask: 1, deny: 2 } as const;
    const weight = (c: string) => (c === 'exec' ? 2 : c === 'net.fetch' || c === 'fs.read' ? 0 : 1);
    let capability = tool.capability;
    let decision: Decision = { verdict: 'allow', reason: 'no permission needed' };
    let taint: readonly string[] | undefined;
    try {
      for (const cap of tool.capabilitiesFor ? tool.capabilitiesFor(input) : [tool.capability]) {
        const d = this.deps.policy.check(cap, { targets, taint: ctx.taint });
        if (d.taint) taint = d.taint;
        if (rank[d.verdict] > rank[decision.verdict] || (d.verdict === decision.verdict && weight(cap) > weight(capability))) [decision, capability] = [d, cap];
      }
    } catch (e) {
      return fail(isGarnetError(e) ? e.category : 'invalid_input', errorMessage(e));
    }
    if (decision.verdict === 'deny') {
      return fail('denied', `Not permitted: ${decision.reason}. Do not retry; tell the owner if this is needed.`);
    }
    if (decision.verdict === 'ask') {
      let summary: string;
      try {
        // Commands are shown in full: a truncated command could hide its dangerous part from the owner.
        summary = tool.summarize ? tool.summarize(input, fullCtx) : describe(tool.name, input, targets, ctx.workspace, capability === 'exec' ? 10_000 : 120);
      } catch (e) {
        return fail(isGarnetError(e) ? e.category : 'invalid_input', errorMessage(e));
      }
      let answer: ApprovalDecision;
      const asked = Date.now();
      try {
        answer = await this.deps.approver({
          sessionId: ctx.sessionId,
          callId: call.id,
          tool: tool.name,
          capability,
          targets,
          input,
          summary: summary + taintNote(taint),
          ...(taint ? { taint } : {}),
        });
      } catch (e) {
        approvalWaitMs = Date.now() - asked;
        return fail('internal', `Could not ask the owner for approval: ${errorMessage(e)}. The operation did not run.`);
      }
      approvalWaitMs = Date.now() - asked;
      if (answer === 'denied') return fail('denied', 'The owner declined this operation. Do not retry it.');
      if (answer === 'deferred') return fail('needs_approval', 'Waiting for the owner to approve this operation.');
    }

    if (ctx.signal.aborted) return fail('cancelled', 'Cancelled before the tool started.');
    const timeout = AbortSignal.timeout(tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    // From here the tool has run: an untrusted tool's result taints the session even when it failed
    // (an error page or a server's error message is outside content too).
    const defaultMark = tool.untrustedOutput ? { untrusted: { source: tool.name } } : {};
    let output: ToolOutput;
    try {
      output = await raceAbort(tool.run(input, { ...fullCtx, signal }), signal);
    } catch (e) {
      if (timeout.aborted && !ctx.signal.aborted) return { ...fail('timeout', `${tool.name} timed out.`), ...defaultMark };
      if (ctx.signal.aborted) return { ...fail('cancelled', `${tool.name} was cancelled.`), ...defaultMark };
      return { ...fail(isGarnetError(e) ? e.category : 'tool_failed', errorMessage(e)), ...defaultMark };
    }
    const { content, truncated, artifactId } = this.limit(output.content, tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT, ctx.sessionId);
    const untrusted = output.untrusted ?? defaultMark.untrusted;
    const meta = { ...waitMeta(), ...(artifactId ? { artifactId } : {}), ...(untrusted ? { untrusted: boundMark(untrusted) } : {}) };
    // A tool that ran but reports a failed operation is an error result, never a success.
    if (output.error) return { ...fail(output.error, content), ...meta };
    return { status: 'ok', content, truncated, durationMs: Date.now() - started, ...meta };
  }

  /** Applies the output cap, saving the full text as an artifact when a store is configured. */
  private limit(full: string, max: number, sessionId: string): { content: string; truncated: boolean; artifactId?: string } {
    if (full.length <= max) return { content: full, truncated: false };
    const head = full.slice(0, max);
    const note = `[output truncated: showing ${max} of ${full.length} characters`;
    let artifactId: string | undefined;
    try {
      artifactId = this.deps.artifacts?.save(sessionId, full);
    } catch {
      // The tool already ran: report its (truncated) output rather than a failure.
    }
    if (!artifactId) return { content: `${head}\n${note}]`, truncated: true };
    return { content: `${head}\n${note}. Full output saved as ${artifactId}; use read_artifact to see the rest.]`, truncated: true, artifactId };
  }
}

/**
 * Validates object inputs strictly: an unknown argument is an error the model
 * can correct, never silently dropped (dropping `append: true` would turn an
 * append into an overwrite). Schemas that set their own catchall keep it.
 */
function strict(schema: ZodType): ZodType {
  return schema instanceof z.ZodObject && schema.def.catchall === undefined ? schema.strict() : schema;
}

function describeIssue(issue: z.core.$ZodIssue, schema: ZodType): string {
  if (issue.code === 'unrecognized_keys') {
    const where = issue.path.length ? ` in ${issue.path.join('.')}` : '';
    const names = issue.keys.map((k) => `"${k}"`).join(', ');
    const allowed = issue.path.length === 0 && schema instanceof z.ZodObject ? ` Allowed: ${Object.keys(schema.shape).join(', ')}.` : '';
    return `unknown argument${issue.keys.length > 1 ? 's' : ''} ${names}${where}.${allowed}`;
  }
  return `${issue.path.join('.') || 'input'}: ${issue.message}`;
}

/** Keeps the recorded mark small: it is stored in the event log with every result. */
function boundMark(mark: UntrustedMark): UntrustedMark {
  const source = mark.source.length > 300 ? `${mark.source.slice(0, 300)}…` : mark.source;
  return mark.links?.length ? { source, links: mark.links.slice(0, 300) } : { source };
}

/** Appended to an approval summary when untrusted content is why the owner is asked. */
function taintNote(taint: readonly string[] | undefined): string {
  if (!taint?.length) return '';
  return `\n⚠ This conversation has read untrusted content (${describeSources(taint)}). It may be trying to steer Garnet: approve only if you asked for this.`;
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

/** A short, human-readable description of an operation for approval prompts. */
function describe(tool: string, input: unknown, targets: string[], workspace: string, maxString: number): string {
  const where = targets.map((t) => (t.startsWith(workspace + '/') ? t.slice(workspace.length + 1) : t)).join(', ');
  const preview = JSON.stringify(input, (_k, v) => (typeof v === 'string' && v.length > maxString ? `${v.slice(0, maxString)}… (${v.length} chars)` : v));
  const short = maxString > 120 || preview.length <= 300 ? preview : `${preview.slice(0, 300)}…`;
  return `${tool}${where ? ` on ${where}` : ''} ${short}`;
}
