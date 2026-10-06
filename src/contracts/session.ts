import type { ChatMessage, ToolCallBlock } from './messages.ts';
import type { Usage } from './usage.ts';
import type { ToolResult } from './tools.ts';
import type { StopReason, ToolSchema } from './model.ts';

export type TaskStatus =
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_approval'
  | 'completed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'failed';

export const terminalStatuses: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'cancelled',
  'budget_exhausted',
  'failed',
]);

/** Session events are the immutable audit trail. Context is derived from them. */
export type SessionEventPayload =
  | { type: 'user_message'; message: ChatMessage; source: string }
  | { type: 'assistant_message'; message: ChatMessage; stopReason: StopReason; usage: Usage; model: string }
  | { type: 'tool_started'; call: ToolCallBlock; operationId: string }
  | { type: 'tool_finished'; callId: string; operationId: string; result: ToolResult }
  | { type: 'task_status'; taskId: string; status: TaskStatus; reason?: string }
  | { type: 'model_error'; category: string; message: string }
  /**
   * The system prompt (memory snapshot, skills index) and tool schemas frozen
   * for this session. Kept stable for prompt caching and prefix-bound blocks;
   * refreshed only at compaction. `tools` is absent in sessions frozen before
   * tool sets were frozen.
   */
  | { type: 'context_frozen'; system: string; tools?: ToolSchema[] }
  /**
   * Untrusted content entered the model-facing context. From here on the
   * session is tainted: policy escalates consequential capabilities from
   * allow to ask (see src/policy). `callId` names the tool call that brought
   * it in; `inherited` marks taint passed in with the task itself (a
   * subagent's parent, an untrusted trigger payload), whose user message is
   * then not treated as the owner's words.
   */
  | { type: 'tainted'; source: string; callId?: string; inherited?: boolean }
  /** Compaction: events up to and including `throughSeq` are represented by `summary`. */
  | { type: 'checkpoint'; summary: string; throughSeq: number; usage: Usage };

export type SessionEvent = SessionEventPayload & {
  sessionId: string;
  seq: number;
  at: string; // ISO timestamp
};

export type Budget = {
  maxModelCalls: number;
  maxTokens: number;
  maxToolCalls: number;
  maxWallMs: number;
};

export type TaskRecord = {
  id: string;
  sessionId: string;
  status: TaskStatus;
  usage: Usage;
  modelCalls: number;
  toolCalls: number;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
};
