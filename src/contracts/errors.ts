// Error categories with distinct recovery paths. Every failure surfaced by a
// module maps to exactly one category.

export type ErrorCategory =
  | 'invalid_input' // malformed model output or bad tool arguments: the model can correct it
  | 'denied' // policy refused the operation
  | 'needs_approval' // policy requires the owner to approve first
  | 'tool_failed' // the tool ran and failed
  | 'timeout'
  | 'cancelled'
  | 'budget_exhausted'
  | 'provider_transient' // retryable provider failure (rate limit, overload, network)
  | 'provider_fatal' // non-retryable provider failure (auth, bad request)
  | 'config' // invalid configuration
  | 'conflict' // the operation clashes with current state (e.g. already running)
  | 'internal'; // a bug in Garnet

export class GarnetError extends Error {
  readonly category: ErrorCategory;
  readonly detail: Record<string, unknown> | undefined;

  constructor(category: ErrorCategory, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'GarnetError';
    this.category = category;
    this.detail = detail;
  }
}

export function isGarnetError(e: unknown, category?: ErrorCategory): e is GarnetError {
  return e instanceof GarnetError && (category === undefined || e.category === category);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
