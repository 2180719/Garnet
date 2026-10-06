import {
  addUsage,
  billedTokens,
  errorMessage,
  nowIso,
  textOf,
  toolCallsOf,
  unknownUsage,
  type Budget,
  type AttachmentRef,
  type ChatMessage,
  type ContentBlock,
  type ErrorCategory,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type StopReason,
  type TaskRecord,
  type TaskStatus,
  type ToolCallBlock,
  type ToolResult,
  type ToolSchema,
  type Usage,
} from '../contracts/index.ts';
import { extractSummary, frozenContext, messagesFromEvents, planCompaction, prepareAttachments, systemPrompt, type FrozenContext } from '../context/index.ts';
import type { SessionStore } from '../store/index.ts';
import type { ToolExecutor, ToolRegistry } from '../tools/index.ts';
import { sessionTaint } from './taint.ts';

/** Live progress for interactive surfaces. The event log remains the record. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; call: ToolCallBlock }
  | { type: 'tool_end'; call: ToolCallBlock; result: ToolResult }
  | { type: 'retry'; attempt: number; delayMs: number; message: string }
  | { type: 'compacting' }
  /** Untrusted content entered the context from `source`; `sources` is the session's full list. */
  | { type: 'tainted'; source: string; sources: readonly string[] }
  | { type: 'status'; status: TaskStatus; reason: string | null };

export type AgentDeps = {
  store: SessionStore;
  model: ModelAdapter;
  registry: ToolRegistry;
  executor: ToolExecutor;
  budget: Budget;
  workspace: string;
  memoryNamespace?: string;
  persona?: string | undefined;
  /**
   * Extra stable system-prompt sections for a memory namespace (memory
   * snapshot, skills index). Read when a session's prompt is frozen: at its
   * first task and after each compaction.
   */
  promptSections?: (memoryNamespace: string) => string[];
  /** Compact before a task when the previous request used at least this many input tokens. */
  compactAtTokens?: number;
  /** User turns kept verbatim after compaction. */
  keepTurns?: number;
  /** Returns a message when new model-calling tasks must be refused (the daily spending cap); null otherwise. */
  refuse?: () => string | null;
  /** Records model usage that belongs to no task (manual compaction), so the daily spending cap counts it. */
  recordSpend?: (usage: Usage) => void;
  maxOutputTokens: number;
  /** Transient provider failures retried per model call. */
  maxRetries?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Stored attachment bytes (the media store). Without it every attachment reaches the model as text. */
  loadAttachment?: (ref: AttachmentRef) => Uint8Array | null;
  /** Most images/PDFs sent as bytes per request; older ones become placeholders. Default 8. */
  maxAttachmentsInContext?: number;
  /**
   * The owner's IANA time zone. When set, each user message is shown to the
   * model with its send time (derived from the event log, not the system prompt).
   */
  timeZone?: string;
};

export type CompactionOutcome = {
  status: 'compacted' | 'nothing_to_compact' | 'failed' | 'refused';
  /** Why the compaction was refused (the daily spending cap); set with `status: 'refused'`. */
  reason?: string;
  /** Usage of the summarizing call; null when no call was made or the provider did not report it. */
  usage: Usage | null;
  modelCalls: number;
};

export type RunOptions = {
  signal?: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
  source?: string;
  /**
   * Taint carried in with this task: the sources a parent session had read
   * (a subagent started by a tainted session) or an untrusted trigger
   * payload. Recorded as inherited `tainted` events right after the user
   * message, so the session is tainted before its first tool call and URLs in
   * that message do not count as the owner's.
   */
  taint?: readonly string[];
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

  /**
   * `input` is the user's text, or the turn's content blocks (text plus
   * attachments already stored and described by the media ingest).
   */
  async run(sessionId: string, input: string | ContentBlock[], options: RunOptions = {}): Promise<TaskRecord> {
    const { store } = this.deps;
    const signal = options.signal ?? new AbortController().signal;
    const emit = options.onEvent ?? (() => {});
    // A request cancelled while queued must not leave its message in history.
    const cancelledEarly = signal.aborted;
    const refused = cancelledEarly ? null : (this.deps.refuse?.() ?? null);
    if (!cancelledEarly && !refused) {
      store.append(sessionId, {
        type: 'user_message',
        message: { role: 'user', content: typeof input === 'string' ? [{ type: 'text', text: input }] : input.map((b) => (b.type === 'attachment' ? withoutData(b) : b)) },
        source: options.source ?? 'cli',
      });
      const known = sessionTaint(store.events(sessionId)).sources;
      for (const source of new Set([...(options.taint ?? []), ...fileTaint(input)])) {
        store.append(sessionId, { type: 'tainted', source, inherited: true });
        if (!known.includes(source)) emit({ type: 'tainted', source, sources: [...known, source] });
      }
    }
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

    if (cancelledEarly) return finish('cancelled', 'Cancelled by the owner.');
    if (refused) return finish('budget_exhausted', refused);
    try {
      return await this.loop(sessionId, task, started, signal, emit, finish);
    } catch (e) {
      // A bug or a store failure must not leave the task `running` forever.
      // Record what we can, then let the caller see the original error.
      try {
        finish('failed', `Internal error: ${errorMessage(e)}`);
      } catch {
        // the store itself is failing; the original error matters more
      }
      throw e;
    }
  }

  private async loop(
    sessionId: string,
    task: TaskRecord,
    started: number,
    signal: AbortSignal,
    emit: (e: RuntimeEvent) => void,
    finish: (status: TaskStatus, reason?: string | null) => TaskRecord,
  ): Promise<TaskRecord> {
    const { store } = this.deps;
    const deadline = started + this.deps.budget.maxWallMs;
    // The system prompt and tool set are frozen per session (context_frozen)
    // so the provider cache and prefix-bound blocks (signed thinking) remain
    // valid. Both are refreshed only by compaction.
    await this.maybeCompact(sessionId, task, signal, emit, deadline);
    const { system, tools } = this.frozenFor(sessionId);

    for (;;) {
      if (signal.aborted) return finish('cancelled', 'Cancelled by the owner.');
      const exhausted = this.budgetProblem(task, started);
      if (exhausted) return finish('budget_exhausted', exhausted);

      const messages = this.view(messagesFromEvents(store.events(sessionId), { timeZone: this.deps.timeZone }));
      const turn = await this.callModel({ system, messages, tools, maxOutputTokens: this.deps.maxOutputTokens, signal }, emit, deadline);
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

      const calls = toolCallsOf(turn.message);
      if (calls.length === 0) {
        return finish('completed', turn.stopReason === 'max_tokens' ? 'Stopped at the output token limit.' : null);
      }

      let waiting: string | null = null;
      let taint = sessionTaint(store.events(sessionId));
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
          result = await this.deps.executor.execute(call, { sessionId, workspace: this.deps.workspace, memoryNamespace: this.deps.memoryNamespace ?? 'default', signal, allowedTools: tools.map((t) => t.name), taint });
          emit({ type: 'tool_end', call, result });
          if (result.status === 'error' && result.category === 'needs_approval') waiting = `Approval needed for ${call.name}.`;
        }
        store.append(sessionId, { type: 'tool_finished', callId: call.id, operationId, result });
        if (result.untrusted) {
          // Recorded after the result so the log reads in order; later calls in this turn already see it.
          const { source } = result.untrusted;
          if (!taint.sources.includes(source)) {
            store.append(sessionId, { type: 'tainted', source, callId: call.id });
            emit({ type: 'tainted', source, sources: [...taint.sources, source] });
          }
          taint = sessionTaint(store.events(sessionId));
        }
      }
      store.updateTask(task);
      if (waiting) return finish('waiting_for_approval', waiting);
    }
  }

  /**
   * The frozen system prompt and tool set, freezing them on first use. A
   * session frozen before tool sets were recorded keeps its prompt and has the
   * current tools frozen alongside it from now on.
   */
  private frozenFor(sessionId: string): { system: string; tools: ToolSchema[] } {
    const frozen: FrozenContext | undefined = frozenContext(this.deps.store.events(sessionId));
    if (frozen?.tools) return { system: frozen.system, tools: frozen.tools };
    return this.freeze(sessionId, frozen?.system ?? this.freshSystem());
  }

  private freeze(sessionId: string, system: string): { system: string; tools: ToolSchema[] } {
    const tools = this.deps.registry.schemas();
    this.deps.store.append(sessionId, { type: 'context_frozen', system, tools });
    return { system, tools };
  }

  private freshSystem(): string {
    const ns = this.deps.memoryNamespace ?? 'default';
    return systemPrompt({ persona: this.deps.persona, workspace: this.deps.workspace, sections: this.deps.promptSections?.(ns) ?? [], timestamps: this.deps.timeZone !== undefined });
  }

  /**
   * Keep-tail compaction between tasks (never mid tool round), run when the
   * previous request crossed `compactAtTokens`. Failures are logged as events
   * and never block the task.
   */
  private async maybeCompact(
    sessionId: string,
    task: TaskRecord,
    signal: AbortSignal,
    emit: (e: RuntimeEvent) => void,
    deadline: number,
  ): Promise<void> {
    const threshold = this.deps.compactAtTokens;
    if (!threshold) return;
    const events = this.deps.store.events(sessionId);
    const lastUsage = events.findLast((e) => e.type === 'assistant_message' || e.type === 'checkpoint');
    if (lastUsage?.type !== 'assistant_message') return; // nothing new since the last checkpoint
    const u = lastUsage.usage;
    const contextTokens = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    if (contextTokens < threshold) return;
    const outcome = await this.compactNow(sessionId, signal, emit, deadline);
    if (outcome.modelCalls) task.modelCalls += outcome.modelCalls;
    if (outcome.usage) task.usage = addUsage(task.usage, outcome.usage);
  }

  /**
   * Compacts a session now, regardless of `compactAtTokens` (the owner asked,
   * for example with `/compact`). Must not run while a task is running on the
   * same session. `nothing_to_compact` means there are no turns older than the
   * kept tail that a checkpoint does not already cover.
   */
  async compact(sessionId: string, options: { signal?: AbortSignal; onEvent?: (event: RuntimeEvent) => void } = {}): Promise<CompactionOutcome> {
    const outcome = await this.compactNow(sessionId, options.signal ?? new AbortController().signal, options.onEvent ?? (() => {}));
    if (outcome.usage) this.deps.recordSpend?.(outcome.usage); // no task row carries this call
    return outcome;
  }

  /**
   * Folds older turns into a summary (keep-tail), records a checkpoint, then
   * re-freezes the system prompt and tool set so memory and tool changes take effect.
   */
  private async compactNow(sessionId: string, signal: AbortSignal, emit: (e: RuntimeEvent) => void, deadline = Infinity): Promise<CompactionOutcome> {
    const plan = planCompaction(this.deps.store.events(sessionId), this.deps.keepTurns ?? 2, { timeZone: this.deps.timeZone });
    if (!plan) return { status: 'nothing_to_compact', usage: null, modelCalls: 0 };
    // Compaction is a model call like any other: the daily spending cap applies before it is made.
    const refused = this.deps.refuse?.();
    if (refused) return { status: 'refused', reason: refused, usage: null, modelCalls: 0 };
    emit({ type: 'compacting' });
    // Summarize with the current frozen prefix so the request can hit the cache.
    const { system, tools } = this.frozenFor(sessionId);
    const turn = await this.callModel({ system, messages: this.view(plan.messages), tools, maxOutputTokens: this.deps.maxOutputTokens, signal }, () => {}, deadline);
    // A summary cut off at the output limit would silently drop whatever it did not reach.
    const summary = turn.kind === 'done' && turn.stopReason !== 'max_tokens' ? extractSummary(textOf(turn.message)) : '';
    if (turn.kind === 'error' || !summary) {
      this.deps.store.append(sessionId, { type: 'model_error', category: turn.kind === 'error' ? turn.category : 'invalid_input', message: 'Compaction failed; continuing with full history.' });
      return { status: 'failed', usage: turn.usage, modelCalls: 1 };
    }
    this.deps.store.append(sessionId, { type: 'checkpoint', summary, throughSeq: plan.throughSeq, usage: turn.usage });
    this.freeze(sessionId, this.freshSystem());
    return { status: 'compacted', usage: turn.usage, modelCalls: 1 };
  }

  /** Attachments as the model can take them: bytes for what it reads natively (newest first, capped), text otherwise. */
  private view(messages: ChatMessage[]): ChatMessage[] {
    return prepareAttachments(messages, {
      media: this.deps.model.capabilities.media,
      maxInContext: this.deps.maxAttachmentsInContext ?? 8,
      load: this.deps.loadAttachment,
    });
  }

  private budgetProblem(task: TaskRecord, started: number): string | null {
    const b = this.deps.budget;
    if (task.modelCalls >= b.maxModelCalls) return `Reached the limit of ${b.maxModelCalls} model calls.`;
    if (billedTokens(task.usage) >= b.maxTokens) return `Reached the limit of ${b.maxTokens} tokens.`;
    if (Date.now() - started >= b.maxWallMs) return `Reached the time limit of ${Math.round(b.maxWallMs / 1000)}s.`;
    // The daily spending cap, re-checked before every model call (the task row is saved after each one).
    return this.deps.refuse?.() ?? null;
  }

  /**
   * One model turn with retries. Only `provider_transient` errors are retried,
   * only before any text was streamed (a retry would repeat it), and never past
   * `deadline` (the task's wall-clock limit): a long `retry-after` fails now
   * instead of holding the conversation's lane.
   */
  private async callModel(
    request: ModelRequest & { signal: AbortSignal },
    emit: (e: RuntimeEvent) => void,
    deadline: number,
  ): Promise<
    | { kind: 'done'; message: ChatMessage; stopReason: StopReason; usage: Usage }
    | { kind: 'error'; category: ErrorCategory; message: string; usage: Usage | null }
  > {
    const maxRetries = this.deps.maxRetries ?? 3;
    const sleep = this.deps.sleep ?? abortableSleep;
    for (let attempt = 0; ; attempt++) {
      let streamedText = false;
      let err: ModelError | null = null;
      try {
        for await (const event of this.deps.model.stream(request)) {
          if (event.type === 'text_delta') {
            streamedText = true;
            emit({ type: 'text', text: event.text });
          } else if (event.type === 'done') {
            return { kind: 'done', message: event.message, stopReason: event.stopReason, usage: event.usage };
          } else if (event.type === 'error') {
            err = event;
            break;
          }
        }
      } catch (e) {
        err = { type: 'error', category: 'internal', message: errorMessage(e) };
      }
      err ??= { type: 'error', category: 'internal', message: 'Model stream ended without a result.' };
      const fail = (message = err.message) => ({ kind: 'error' as const, category: err.category, message, usage: null });
      if (err.category !== 'provider_transient' || streamedText || attempt >= maxRetries || request.signal.aborted) return fail();
      const delayMs = err.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
      if (Date.now() + delayMs >= deadline) {
        return fail(`${err.message} (not retried: waiting ${Math.ceil(delayMs / 1000)}s would pass the task's time limit)`);
      }
      emit({ type: 'retry', attempt: attempt + 1, delayMs, message: err.message });
      try {
        await sleep(delayMs, request.signal);
      } catch {
        return { kind: 'error', category: 'cancelled', message: 'Cancelled while waiting to retry.', usage: null };
      }
    }
  }
}

type ModelError = Extract<ModelEvent, { type: 'error' }>;

/**
 * Files the owner passes on (images, PDFs, documents) were usually written by
 * someone else and can carry instructions, so they taint the session like a
 * fetched page. The one exception is a voice note the
 * paired owner recorded live in a private chat, which the gateway marks
 * (`liveVoice`) from the channel's own voice-note flag; forwarded voice notes
 * and audio files taint like any file.
 */
function fileTaint(input: string | ContentBlock[]): string[] {
  if (typeof input === 'string') return [];
  return input.flatMap((b) => (b.type === 'attachment' && !(b.liveVoice && b.attachment.kind === 'audio') ? [`file ${b.attachment.name ? JSON.stringify(b.attachment.name) : b.attachment.id} sent in chat`] : []));
}

/** Bytes never enter the event log; only the reference and derived text do. */
function withoutData<T extends { data?: string }>(block: T): T {
  const { data: _data, ...rest } = block;
  return rest as T;
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
