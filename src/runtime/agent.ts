import {
  addUsage,
  billedTokens,
  nowIso,
  unknownUsage,
  type Budget,
  type ChatMessage,
  type ModelAdapter,
  type ModelEvent,
  type StopReason,
  type TaskRecord,
  type TaskStatus,
  type ToolCallBlock,
  type ToolResult,
  type Usage,
} from '../contracts/index.ts';
import { messagesFromEvents, systemPrompt } from '../context/index.ts';
import type { SessionStore } from '../store/index.ts';
import type { ToolExecutor, ToolRegistry } from '../tools/index.ts';

/** Live progress for interactive surfaces. The event log remains the record. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; call: ToolCallBlock }
  | { type: 'tool_end'; call: ToolCallBlock; result: ToolResult }
  | { type: 'retry'; attempt: number; delayMs: number; message: string }
  | { type: 'status'; status: TaskStatus; reason: string | null };

export type AgentDeps = {
  store: SessionStore;
  model: ModelAdapter;
  registry: ToolRegistry;
  executor: ToolExecutor;
  budget: Budget;
  workspace: string;
  persona?: string | undefined;
  maxOutputTokens: number;
  /** Transient provider failures retried per model call. */
  maxRetries?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type RunOptions = {
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
  source?: string;
};

/**
 * Drives one task: the model decides what to do; the runtime owns execution,
 * persistence, permissions (via the executor), cancellation and budgets.
 */
export class Agent {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  async run(sessionId: string, userText: string, options: RunOptions = {}): Promise<TaskRecord> {
    const { store } = this.deps;
    const signal = options.signal ?? new AbortController().signal;
    const emit = options.onEvent ?? (() => {});
    store.append(sessionId, {
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'text', text: userText }] },
      source: options.source ?? 'cli',
    });
    const task = store.createTask(sessionId, unknownUsage());
    const started = Date.now();

    const finish = (status: TaskStatus, reason: string | null = null): TaskRecord => {
      task.status = status;
      task.reason = reason;
      if (status !== 'waiting_for_approval' && status !== 'waiting_for_user') task.endedAt = nowIso();
      store.updateTask(task);
      store.append(sessionId, { type: 'task_status', taskId: task.id, status, ...(reason ? { reason } : {}) });
      emit({ type: 'status', status, reason });
      return task;
    };

    const tools = this.deps.registry.schemas();
    const system = systemPrompt({ persona: this.deps.persona, workspace: this.deps.workspace, toolNames: tools.map((t) => t.name) });

    for (;;) {
      if (signal.aborted) return finish('cancelled', 'Cancelled by the owner.');
      const exhausted = this.budgetProblem(task, started);
      if (exhausted) return finish('budget_exhausted', exhausted);

      const messages = messagesFromEvents(store.events(sessionId));
      const turn = await this.callModel({ system, messages, tools, maxOutputTokens: this.deps.maxOutputTokens, signal }, emit);
      task.modelCalls += 1;
      if (turn.usage) task.usage = addUsage(task.usage, turn.usage);

      if (turn.kind === 'error') {
        store.append(sessionId, { type: 'model_error', category: turn.category, message: turn.message });
        store.updateTask(task);
        if (turn.category === 'cancelled' || signal.aborted) return finish('cancelled', 'Cancelled by the owner.');
        return finish('failed', `Model error (${turn.category}): ${turn.message}`);
      }

      store.append(sessionId, {
        type: 'assistant_message',
        message: turn.message,
        stopReason: turn.stopReason,
        usage: turn.usage,
        model: this.deps.model.id,
      });
      store.updateTask(task);

      const calls = turn.message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
      if (calls.length === 0) {
        return finish('completed', turn.stopReason === 'max_tokens' ? 'Stopped at the output token limit.' : null);
      }

      let waiting: string | null = null;
      for (const call of calls) {
        const operationId = `${task.id}:${call.id}`;
        let result: ToolResult;
        if (signal.aborted) {
          result = { status: 'error', category: 'cancelled', content: 'Cancelled before this tool ran.', durationMs: 0 };
        } else if (turn.stopReason === 'max_tokens' || turn.stopReason === 'refusal') {
          // The call may be truncated or cut off mid-input; never execute it.
          const why = turn.stopReason === 'max_tokens' ? 'your output hit the token limit' : 'the response was declined';
          result = { status: 'error', category: 'invalid_input', content: `Not run: ${why} before this call was complete. Retry with a shorter call.`, durationMs: 0 };
        } else if (waiting) {
          result = { status: 'error', category: 'needs_approval', content: 'Skipped while an earlier operation awaits approval.', durationMs: 0 };
        } else if (task.toolCalls >= this.deps.budget.maxToolCalls) {
          result = { status: 'error', category: 'budget_exhausted', content: 'Tool call budget exhausted for this task.', durationMs: 0 };
        } else {
          // Persist intent before any effect, so recovery knows what may have happened.
          store.append(sessionId, { type: 'tool_started', call, operationId });
          emit({ type: 'tool_start', call });
          task.toolCalls += 1;
          result = await this.deps.executor.execute(call, { sessionId, workspace: this.deps.workspace, signal });
          emit({ type: 'tool_end', call, result });
          if (result.status === 'error' && result.category === 'needs_approval') waiting = `Approval needed for ${call.name}.`;
        }
        store.append(sessionId, { type: 'tool_finished', callId: call.id, operationId, result });
      }
      store.updateTask(task);
      if (waiting) return finish('waiting_for_approval', waiting);
    }
  }

  private budgetProblem(task: TaskRecord, started: number): string | null {
    const b = this.deps.budget;
    if (task.modelCalls >= b.maxModelCalls) return `Reached the limit of ${b.maxModelCalls} model calls.`;
    if (billedTokens(task.usage) >= b.maxTokens) return `Reached the limit of ${b.maxTokens} tokens.`;
    if (Date.now() - started >= b.maxWallMs) return `Reached the time limit of ${Math.round(b.maxWallMs / 1000)}s.`;
    return null;
  }

  private async callModel(
    request: Parameters<ModelAdapter['stream']>[0] & { signal: AbortSignal },
    emit: (e: RuntimeEvent) => void,
  ): Promise<
    | { kind: 'done'; message: ChatMessage; stopReason: StopReason; usage: Usage }
    | { kind: 'error'; category: Extract<ModelEvent, { type: 'error' }>['category']; message: string; usage: Usage | null }
  > {
    const maxRetries = this.deps.maxRetries ?? 3;
    const sleep = this.deps.sleep ?? abortableSleep;
    for (let attempt = 0; ; attempt++) {
      let streamedText = false;
      let lastError: Extract<ModelEvent, { type: 'error' }> | null = null;
      try {
        for await (const event of this.deps.model.stream(request)) {
          if (event.type === 'text_delta') {
            streamedText = true;
            emit({ type: 'text', text: event.text });
          } else if (event.type === 'done') {
            return { kind: 'done', message: event.message, stopReason: event.stopReason, usage: event.usage };
          } else if (event.type === 'error') {
            lastError = event;
            break;
          }
        }
      } catch (e) {
        lastError = { type: 'error', category: 'internal', message: e instanceof Error ? e.message : String(e) };
      }
      const err = lastError ?? { type: 'error' as const, category: 'internal' as const, message: 'Model stream ended without a result.' };
      // Retrying after visible output would duplicate it for the user.
      const retryable = err.category === 'provider_transient' && !streamedText && attempt < maxRetries;
      if (!retryable || request.signal.aborted) return { kind: 'error', category: err.category, message: err.message, usage: null };
      const delayMs = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
      emit({ type: 'retry', attempt: attempt + 1, delayMs, message: err.message });
      try {
        await sleep(delayMs, request.signal);
      } catch {
        return { kind: 'error', category: 'cancelled', message: 'Cancelled while waiting to retry.', usage: null };
      }
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
