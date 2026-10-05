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
};

export type ToolOutput = {
  content: string;
  /** Short structured data for programmatic consumers (not sent to the model). */
  data?: unknown;
};

export type ToolDefinition<I = any> = {
  name: string;
  version: number;
  description: string;
  input: z.ZodType<I>;
  capability: Capability;
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
