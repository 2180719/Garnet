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
  /**
   * What untrusted content this session's context holds (see `SessionTaint`).
   * Set by the runtime before every call; policy uses it to escalate
   * consequential capabilities. Tools may read it, e.g. to pass the taint on
   * to a subagent.
   */
  taint?: SessionTaint;
};

/**
 * Untrusted content (web pages, search results, email, MCP results) that has
 * entered a session's model-facing context. Derived from the event log.
 */
export type SessionTaint = {
  /** Where untrusted content came from, oldest first, e.g. "web_fetch https://example.com/". Empty: not tainted. */
  sources: readonly string[];
  /** Normalized URLs the owner wrote in their own messages. Fetching these carries no data the owner did not choose. */
  ownerUrls: ReadonlySet<string>;
  /** Normalized URLs that untrusted tools reported finding (search results, page links), verbatim. */
  seenUrls: ReadonlySet<string>;
};

/** Marks a tool's output as untrusted data (it came from outside: a web page, an email, an MCP server). */
export type UntrustedMark = {
  /** Short, human-readable origin shown to the owner, e.g. "web_fetch https://example.com/page". */
  source: string;
  /** URLs found verbatim in the content (search results, page links), at most a few hundred. */
  links?: string[];
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
  /** Set when this output carries untrusted content. Tools with `untrustedOutput` get a default mark. */
  untrusted?: UntrustedMark;
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
   * list means the call only reads Garnet's own state and needs no permission.
   */
  capabilitiesFor?: (input: I) => Capability[];
  /**
   * Resolves what would otherwise be resolved later (a relative time, a
   * recipient alias like "owner") into concrete values. Runs right after
   * validation; the returned input is what is authorized, shown in the
   * approval, hashed into the grant and run, so the executed action is exactly
   * the approved one. Must not throw for inputs the tool can reject later.
   */
  bind?: (input: I, ctx: ToolContext) => I;
  /** Plain-language description of the call for approval prompts. Must show everything consequential in full. */
  summarize?: (input: I, ctx: ToolContext) => string;
  /** Paths/hosts the call touches, used for scoped policy checks. */
  targets?: (input: I, ctx: ToolContext) => string[];
  /** True when repeating the call cannot cause a duplicate external effect. */
  idempotent: boolean;
  /**
   * True when the tool brings outside content into the context (web, email,
   * MCP). Every result of a run, including errors, then taints the session.
   * Tools whose output is only sometimes untrusted set `ToolOutput.untrusted`.
   */
  untrustedOutput?: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  run: (input: I, ctx: ToolContext) => Promise<ToolOutput>;
};

/** Extra facts recorded with a result for audit; not sent to the model separately. */
export type ToolResultMeta = {
  /** Milliseconds the call waited on an interactive approval. The runtime does not count it against the task's time limit. */
  approvalWaitMs?: number;
  /** Deterministic repairs applied to the call before execution (repair records). */
  repairs?: string[];
  /** Artifact holding the full output when it was too large to return. */
  artifactId?: string;
  /** The result carries untrusted content; the runtime records a `tainted` event. */
  untrusted?: UntrustedMark;
};

export type ToolResult = ToolResultMeta &
  (
    | { status: 'ok'; content: string; truncated: boolean; durationMs: number }
    | { status: 'error'; category: ErrorCategory; content: string; durationMs: number }
  );
