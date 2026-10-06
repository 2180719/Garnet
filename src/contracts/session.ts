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
   * tool sets were frozen. `extras` is the set of optional built-ins (skills,
   * connectors) resolved for this session from config (global plus its
   * channel or conversation scope); it is chosen once and kept for the
   * session's life, compaction included. Absent in sessions frozen before
   * built-ins existed, or by a runtime that does not select them.
   */
  | { type: 'context_frozen'; system: string; tools?: ToolSchema[]; extras?: ActiveExtras }
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

/** Optional built-in skills and connectors active in one session (names, sorted). */
export type ActiveExtras = { skills: string[]; connectors: string[] };

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
