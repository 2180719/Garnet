import type { Capability } from '../contracts/index.ts';
import type { Permission } from '../config/index.ts';

export type ApprovalRequest = {
  sessionId: string;
  callId: string;
  tool: string;
  capability: Capability;
  targets: string[];
  /** Validated input; approvals are bound to this exact operation. */
  input: unknown;
  /** Human-readable summary of the operation, shown to the owner. */
  summary: string;
};

export type ApprovalDecision = 'approved' | 'denied' | 'deferred';

/**
 * Asks the owner. Interactive surfaces answer immediately; others return
 * `deferred`, which pauses the task in `waiting_for_approval`.
 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export const denyAll: Approver = async () => 'denied';
export const deferAll: Approver = async () => 'deferred';

export type Decision = { verdict: Permission; reason: string };

/**
 * Authorizes operations independently of model instructions. Nothing the
 * model says can change a policy; only configuration can.
 */
export class Policy {
  private readonly permissions: Record<Capability, Permission>;

  constructor(permissions: Record<Capability, Permission>) {
    this.permissions = { ...permissions };
  }

  check(capability: Capability): Decision {
    const verdict = this.permissions[capability] ?? 'deny';
    return { verdict, reason: `${capability} is set to "${verdict}"` };
  }

  /** Effective policy granting at most what both policies grant (used for scheduled jobs). */
  intersect(other: Policy): Policy {
    const rank: Record<Permission, number> = { deny: 0, ask: 1, allow: 2 };
    const merged = {} as Record<Capability, Permission>;
    for (const cap of Object.keys(this.permissions) as Capability[]) {
      const a = this.permissions[cap];
      const b = other.permissions[cap] ?? 'deny';
      merged[cap] = rank[a] <= rank[b] ? a : b;
    }
    return new Policy(merged);
  }
}
