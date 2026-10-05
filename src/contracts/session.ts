import type { ChatMessage, ToolCallBlock } from './messages.ts';
import type { Usage } from './usage.ts';
import type { ToolResult } from './tools.ts';
import type { StopReason } from './model.ts';

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
  | { type: 'model_error'; category: string; message: string };

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
