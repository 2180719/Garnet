import type { Capability, SessionTaint } from '../contracts/index.ts';
import type { Permission } from '../config/index.ts';
import { hostMatches, hostOf, normalizeUrl } from './urls.ts';

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
  /**
   * Set when the operation needs approval only because the session has read
   * untrusted content: where that content came from. Approvers must not
   * apply standing "always allow" answers to such a request.
   */
  taint?: readonly string[];
};

export type ApprovalDecision = 'approved' | 'denied' | 'deferred';

/**
 * Asks the owner. Interactive surfaces answer immediately; others return
 * `deferred`, which pauses the task in `waiting_for_approval`.
 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export const denyAll: Approver = async () => 'denied';
export const deferAll: Approver = async () => 'deferred';

export type Decision = {
  verdict: Permission;
  reason: string;
  /** Present when untrusted content escalated the verdict from allow to ask: its sources. */
  taint?: readonly string[];
};

/** Untrusted-content containment (see AGENTS.md). */
export type Containment = {
  /** Off: taint is still recorded and shown, but never escalates anything. */
  enabled: boolean;
  /** Capabilities escalated from allow to ask while the session is tainted. */
  escalate: readonly Capability[];
  /**
   * While tainted, let `net.fetch` reach a URL that an untrusted tool reported
   * verbatim (a search result, a link on a fetched page) without asking. Such
   * a URL carries no data the model composed, but an attacker who planted
   * several links can still learn which one was chosen.
   */
  fetchSeenUrls: boolean;
};

export const DEFAULT_CONTAINMENT: Containment = {
  enabled: true,
  escalate: ['fs.write', 'exec', 'message.send', 'memory.write', 'schedule.edit', 'net.fetch'],
  fetchSeenUrls: true,
};

export type PolicyOptions = {
  containment?: Containment;
  /** Hosts `net.fetch` may reach without asking when it is set to ask (`example.com`, `*.example.com`). */
  allowHosts?: readonly string[];
  /**
   * URL prefixes of owner-configured endpoints (search backends). The owner
   * chose the destination, so a tainted session may still send requests there.
   */
  trustedEndpoints?: readonly string[];
};

export type CheckContext = {
  /** Paths or URLs the operation touches (`ToolDefinition.targets`). */
  targets?: readonly string[];
  taint?: SessionTaint | undefined;
};

/**
 * Authorizes operations independently of model instructions. Nothing the
 * model says can change a policy; only configuration can.
 */
export class Policy {
  private readonly permissions: Record<Capability, Permission>;
  private readonly options: Required<PolicyOptions>;

  constructor(permissions: Record<Capability, Permission>, options: PolicyOptions = {}) {
    this.permissions = { ...permissions };
    this.options = {
      containment: options.containment ?? DEFAULT_CONTAINMENT,
      allowHosts: options.allowHosts ?? [],
      trustedEndpoints: (options.trustedEndpoints ?? []).flatMap((e) => normalizeUrl(e) ?? []),
    };
  }

  check(capability: Capability, ctx: CheckContext = {}): Decision {
    const base = this.permissions[capability] ?? 'deny';
    if (base === 'deny') return { verdict: 'deny', reason: `${capability} is set to "deny"` };
    const targets = ctx.targets ?? [];
    let decision: Decision = { verdict: base, reason: `${capability} is set to "${base}"` };
    if (base === 'ask' && capability === 'net.fetch' && targets.length > 0 && targets.every((t) => this.hostAllowed(t))) {
      decision = { verdict: 'allow', reason: `net.fetch is allowed for ${[...new Set(targets.map(hostOf))].join(', ')} (web.allowHosts)` };
    }
    const sources = ctx.taint?.sources ?? [];
    const c = this.options.containment;
    if (decision.verdict !== 'allow' || sources.length === 0 || !c.enabled || !c.escalate.includes(capability)) return decision;
    if (capability === 'net.fetch' && targets.length > 0 && targets.every((t) => this.carriesNoData(t, ctx.taint!))) return decision;
    return {
      verdict: 'ask',
      reason: `this conversation has read untrusted content (${describeSources(sources)}), so ${capability} needs the owner's approval until a new conversation starts`,
      taint: sources,
    };
  }

  private hostAllowed(target: string): boolean {
    const host = hostOf(target);
    return host !== null && this.options.allowHosts.some((p) => hostMatches(host, p));
  }

  /**
   * True when fetching `target` cannot carry data the model composed: the
   * owner wrote that exact URL, it is an owner-configured endpoint, or (when
   * enabled) an untrusted tool reported it verbatim. An allow-listed host is
   * not enough: anyone can own a path on a popular host and read its logs.
   */
  private carriesNoData(target: string, taint: SessionTaint): boolean {
    const url = normalizeUrl(target);
    if (!url) return false;
    if (taint.ownerUrls.has(url)) return true;
    if (this.options.trustedEndpoints.some((e) => url === e || url.startsWith(e.endsWith('/') ? e : `${e}/`) || url.startsWith(`${e}?`))) return true;
    return this.options.containment.fetchSeenUrls && taint.seenUrls.has(url);
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
    return new Policy(merged, this.options);
  }
}

/** "web_fetch https://a/, web_search …" with at most three sources named. */
export function describeSources(sources: readonly string[]): string {
  const shown = sources.slice(0, 3).join('; ');
  return sources.length > 3 ? `${shown}; and ${sources.length - 3} more` : shown;
}
