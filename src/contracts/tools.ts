import type { z } from 'zod';
import type { ErrorCategory } from './errors.ts';

/** Capabilities a policy can allow, require approval for, or deny. */
export type Capability =
  | 'fs.read'
  | 'fs.write'
  | 'net.fetch'
  | 'exec'
  | 'message.send'
  | 'memory.write'
  | 'schedule.edit';

export type ToolContext = {
  sessionId: string;
  callId: string;
  /** Absolute workspace root for this session's sandbox. */
  workspace: string;
  /** Memory namespace this session may read and write (from its routing profile). */
  memoryNamespace: string;
  signal: AbortSignal;
  /** Names of the tools in the session's frozen schemas. When set, any other tool is refused. */
  allowedTools?: readonly string[];
};

export type ToolOutput = {
  content: string;
  /**
   * Set when the tool ran but the operation did not succeed (for example, a
   * command that timed out), so the content is still useful but must reach
   * the model as an error result, never as a success.
   */
  error?: ErrorCategory;
  /** Short structured data for programmatic consumers (not sent to the model). */
  data?: unknown;
};

export type ToolDefinition<I = any> = {
  name: string;
  version: number;
  description: string;
  input: z.ZodType<I>;
  capability: Capability;
  /**
   * Capabilities this particular call needs, when they depend on the input
   * (e.g. `schedule` needs `exec` too for a script job, and nothing to list
   * jobs). Defaults to `[capability]`; the strictest verdict wins. An empty
   * list means the call only reads Ruby's own state and needs no permission.
   */
  capabilitiesFor?: (input: I) => Capability[];
  /** Plain-language description of the call for approval prompts. Must show everything consequential in full. */
  summarize?: (input: I, ctx: ToolContext) => string;
  /** Paths/hosts the call touches, used for scoped policy checks. */
  targets?: (input: I, ctx: ToolContext) => string[];
  /** True when repeating the call cannot cause a duplicate external effect. */
  idempotent: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  run: (input: I, ctx: ToolContext) => Promise<ToolOutput>;
};

/** Extra facts recorded with a result for audit; not sent to the model separately. */
export type ToolResultMeta = {
  /** Deterministic repairs applied to the call before execution (repair records). */
  repairs?: string[];
  /** Artifact holding the full output when it was too large to return. */
  artifactId?: string;
};

export type ToolResult = ToolResultMeta &
  (
    | { status: 'ok'; content: string; truncated: boolean; durationMs: number }
    | { status: 'error'; category: ErrorCategory; content: string; durationMs: number }
  );
