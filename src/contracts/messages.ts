// Provider-neutral conversation shapes. Adapters translate to and from these.

export type TextBlock = { type: 'text'; text: string };

export type ToolCallBlock = {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: 'tool_result';
  callId: string;
  content: string;
  isError: boolean;
};

/**
 * Opaque provider data that must survive persistence and be sent back
 * unchanged (for example, signed thinking blocks). Only the adapter that
 * produced it interprets it.
 */
export type ProviderBlock = {
  type: 'provider';
  provider: string;
  data: unknown;
  /**
   * True when the block is bound to the exact conversation prefix that
   * produced it (e.g. signed thinking). Bound blocks are dropped from turns
   * retained after compaction, because their prefix no longer exists.
   */
  bound?: boolean;
};

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ProviderBlock;

export type Role = 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: ContentBlock[];
};

export function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolCallsOf(message: ChatMessage): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
}
