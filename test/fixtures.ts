import { tempDir } from './helpers.ts';
import { defaultConfig } from '../src/config/index.ts';
import type { ChannelAdapter, InboundMessage, ToolDefinition, InboundSink, OutboundMessage, SendResult } from '../src/contracts/index.ts';
import { Gateway, persistentApprover, type GatewayDeps, type Route } from '../src/gateway/index.ts';
import { FakeModel, type FakeScript } from '../src/models/index.ts';
import { Policy, deferAll } from '../src/policy/index.ts';
import { Agent, LaneQueue, type AgentDeps } from '../src/runtime/index.ts';
import { ApprovalStore, GatewayStore, openDb, SessionStore } from '../src/store/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from '../src/tools/index.ts';

export class FakeChannel implements ChannelAdapter {
  readonly channel = 'fake';
  readonly account = 'default';
  readonly capabilities = { maxMessageChars: 4096, dedupesSends: false, typingIndicator: false };
  sink: InboundSink | null = null;
  sent: OutboundMessage[] = [];
  failures: SendResult[] = [];
  stopped = false;
  async start(sink: InboundSink) { this.sink = sink; }
  async send(m: OutboundMessage): Promise<SendResult> {
    const f = this.failures.shift();
    if (f) return f;
    this.sent.push(m);
    return { status: 'sent', externalIds: [String(this.sent.length)] };
  }
  async stop() { this.stopped = true; }
  health() { return { ok: true, lastSuccessAt: null, lastError: null }; }
}

let ext = 0;
export const msg = (text: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'fake', account: 'default', chatId: 'chat1', externalId: String(++ext),
  sender: { id: 'u1', displayName: 'Ada' }, text, isPrivate: true, receivedAt: new Date().toISOString(), ...over,
});

export function setup(script: FakeScript = [], opts: { routes?: Route[]; db?: ReturnType<typeof openDb>; withApprovals?: boolean; tools?: ToolDefinition[]; agent?: Partial<AgentDeps>; gateway?: Partial<GatewayDeps>; policy?: Policy } = {}) {
  const db = opts.db ?? openDb(':memory:');
  const sessions = new SessionStore(db);
  const store = new GatewayStore(db);
  const registry = new ToolRegistry();
  for (const t of [...fileTools, ...(opts.tools ?? [])]) registry.register(t);
  const config = defaultConfig();
  const approvals = new ApprovalStore(db);
  const approver = opts.withApprovals ? persistentApprover(approvals) : deferAll;
  const model = new FakeModel(script);
  const agent = new Agent({
    store: sessions, model, registry, workspace: tempDir(), maxOutputTokens: 100, budget: config.budgets,
    ...opts.agent,
    executor: new ToolExecutor({ registry, policy: opts.policy ?? new Policy(config.permissions), approver }),
  });
  const channel = new FakeChannel();
  const lanes = new LaneQueue(2);
  const gateway = new Gateway({ store, sessions, agent, lanes, channels: [channel], routes: opts.routes ?? [], deliveryIntervalMs: 10_000, ...(opts.withApprovals ? { approvals } : {}), ...opts.gateway });
  return { db, sessions, store, approvals, model, channel, lanes, gateway };
}

