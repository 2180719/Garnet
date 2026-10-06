import { randomInt } from 'node:crypto';
import {
  errorMessage,
  RubyError,
  textOf,
  type ChannelAdapter,
  type InboundMessage,
  type OutboundMessage,
  type SendResult,
  type TaskRecord,
} from '../contracts/index.ts';
import type { Agent, LaneQueue, RuntimeEvent } from '../runtime/index.ts';
import type { ApprovalStore, GatewayStore, InboxRow, PairingCode, SessionStore } from '../store/index.ts';

export type Route = { match: { channel: string; chatId?: string | undefined }; conversation: string };
export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

export type GatewayDeps = {
  store: GatewayStore;
  /** Pending approvals; enables /approve and /deny in chat. */
  approvals?: ApprovalStore;
  sessions: SessionStore;
  agent: Agent;
  /** Agent for special conversations (e.g. `job:<id>` runs with the job's permissions). Defaults to `agent`. */
  agentFor?: (conversationKey: string) => Agent | undefined;
  lanes: LaneQueue;
  channels: ChannelAdapter[];
  routes?: Route[];
  pairingTtlMinutes?: number;
  log?: LogFn;
  now?: () => Date;
  /** Delivery poll interval. The outbox is also flushed right after each reply. */
  deliveryIntervalMs?: number;
  maxDeliveryAttempts?: number;
  /** False in short-lived processes (CLI): replies stay queued for the running service to send. */
  deliveryEnabled?: boolean;
  /** A send still pending after this long is treated as possibly delivered (`uncertain`). Default 60 s. */
  sendTimeoutMs?: number;
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Routes verified messages from channels to the agent and delivers replies
 * durably. Single source of truth for identity, conversations and delivery.
 */
export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly channels = new Map<string, ChannelAdapter>();
  private readonly active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private delivering: Promise<void> | null = null;
  private stopping = false;
  /** Set once every channel has started and the inbox backlog is queued; until then inbound messages are only persisted. */
  private started = false;
  private readonly log: LogFn;
  private readonly now: () => Date;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    for (const c of deps.channels) this.channels.set(channelKey(c.channel, c.account), c);
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Recovers from a previous run, starts every channel (failing fast on bad
   * credentials), then processes queued work. Messages that arrive while
   * channels are starting are persisted but dispatched only afterwards, together
   * with the backlog and in arrival order, so a new message never overtakes an
   * older one in the same conversation.
   */
  async start(): Promise<void> {
    this.recover();
    for (const c of this.channels.values()) {
      await c.start((m) => this.receive(m));
      this.log('info', `${c.channel}:${c.account} connected`);
    }
    // Synchronous from here to the end of the loop: no receive() can interleave.
    this.started = true;
    for (const row of this.deps.store.inboxByStatus('pending')) this.dispatch(row);
    this.timer = setInterval(() => void this.deliver(), this.deps.deliveryIntervalMs ?? 1000);
    this.timer.unref();
    void this.deliver();
  }

  /** Drains running tasks (up to `drainMs`), flushes deliveries, then releases channel sessions. */
  async stop(drainMs = 20_000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const drained = await Promise.race([this.deps.lanes.idle().then(() => true), sleep(drainMs).then(() => false)]);
    if (!drained) {
      this.log('warn', 'Shutdown timed out waiting for tasks; cancelling them.');
      for (const c of this.active.values()) c.abort();
      await Promise.race([this.deps.lanes.idle(), sleep(5000)]);
    }
    await this.deliver();
    for (const c of this.channels.values()) await c.stop().catch((e) => this.log('warn', `stopping ${c.channel}: ${errorMessage(e)}`));
  }

  /** Channel sink: persist first, then dispatch. Resolving acknowledges the message to the channel. */
  async receive(message: InboundMessage): Promise<void> {
    const row = this.deps.store.receive(message);
    if (!row) return; // duplicate delivery
    if (this.started && !this.stopping) this.dispatch(row);
  }

  /** Approves a pairing code and greets the newly paired sender. */
  approvePairing(code: string): PairingCode | null {
    const p = approvePairing(this.deps.store, code, this.now());
    if (p) void this.deliver();
    return p;
  }

  /**
   * Runs a task for a non-channel surface (HTTP API, dashboard) in the given
   * conversation, serialized with any other work on it.
   */
  chat(
    conversationKey: string,
    text: string,
    options: { signal?: AbortSignal; onEvent?: (e: RuntimeEvent) => void; source: string },
  ): Promise<{ task: TaskRecord; text: string; sessionId: string }> {
    return this.deps.lanes.run(conversationKey, async () => {
      const sessionId = this.sessionFor(conversationKey, options.source);
      const before = this.deps.sessions.lastSeq(sessionId);
      const agent = this.deps.agentFor?.(conversationKey) ?? this.deps.agent;
      // Registered like channel tasks, so /stop in the conversation and stop() can cancel it.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      this.active.set(conversationKey, controller);
      try {
        const task = await agent.run(sessionId, text, { ...options, signal: controller.signal });
        return { task, text: this.replyText(sessionId, before, task), sessionId };
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (this.active.get(conversationKey) === controller) this.active.delete(conversationKey);
      }
    });
  }

  /**
   * Decides an approval from a non-chat surface (dashboard, API) and resumes
   * the task. If the conversation is a chat, the outcome is also sent there.
   */
  async resolveApproval(code: string, decision: 'approved' | 'denied'): Promise<{ status: string; text: string | null; resumed: boolean }> {
    const approvals = this.deps.approvals;
    if (!approvals) throw new RubyError('invalid_input', 'Approvals are not enabled.');
    const decided = approvals.decide(code, decision, this.now().toISOString());
    if (!decided) throw new RubyError('invalid_input', 'No pending approval with that code (it may have expired or been decided).');
    const key = this.deps.store.keyForSession(decided.sessionId);
    if (!key) return { status: decision, text: null, resumed: false };
    const result = await this.chat(key, approvalText(decided.code, decided.summary, decision === 'approved'), { source: 'dashboard' });
    const chat = chatOfKey(key);
    if (chat && this.channels.has(channelKey(chat.channel, chat.account))) this.notify(chat, result.text);
    return { status: result.task.status, text: result.text, resumed: true };
  }

  /** Queues a proactive message (scheduled results, alerts) to a chat. */
  notify(target: { channel: string; account: string; chatId: string }, text: string): void {
    this.deps.store.enqueue({ ...target, text });
    void this.deliver();
  }

  /** Channel liveness and delivery backlog, for health endpoints. */
  health(): { channels: { channel: string; account: string; ok: boolean; lastSuccessAt: string | null; lastError: string | null }[]; outbox: Record<string, number> } {
    const outbox: Record<string, number> = {};
    for (const status of ['pending', 'failed', 'uncertain'] as const) outbox[status] = this.deps.store.outboxByStatus(status).length;
    return {
      channels: [...this.channels.values()].map((c) => ({ channel: c.channel, account: c.account, ...c.health() })),
      outbox,
    };
  }

  private dispatch(row: InboxRow): void {
    const { store } = this.deps;
    if (!row.isPrivate) {
      // Group chats are not supported yet; they never receive private memory or pairing prompts.
      store.setInbox(row.id, 'ignored');
      return;
    }
    if (!store.identity(row.channel, row.sender.id)) {
      store.setInbox(row.id, 'ignored');
      this.offerPairing(row);
      return;
    }
    const key = this.conversationKey(row);
    const command = row.text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '');
    if (command === '/stop') {
      const running = this.active.get(key);
      running?.abort();
      store.setInbox(row.id, 'done');
      this.reply(row, running ? 'Stopping…' : 'Nothing is running.');
      return;
    }
    if (command === '/new') {
      const session = this.deps.sessions.createSession(`${row.channel} chat`);
      store.bindConversation(key, session.id);
      store.setInbox(row.id, 'done', { sessionId: session.id });
      this.reply(row, 'Started a fresh conversation. Memory and settings are unchanged.');
      return;
    }
    if ((command === '/approve' || command === '/deny') && this.deps.approvals) {
      store.setInbox(row.id, 'done');
      const code = row.text.trim().split(/\s+/)[1]?.toUpperCase() ?? '';
      const pending = this.deps.approvals.get(code);
      // Owners may approve from any paired chat; the task resumes in the conversation that asked.
      const targetKey = pending ? (store.keyForSession(pending.sessionId) ?? null) : null;
      if (!pending || !targetKey) {
        this.reply(row, 'No pending approval with that code.');
        return;
      }
      const decided = this.deps.approvals.decide(code, command === '/approve' ? 'approved' : 'denied', this.now().toISOString());
      if (!decided) {
        this.reply(row, 'That approval already expired or was decided.');
        return;
      }
      // Continue the task in the conversation that asked; an approval grants exactly that operation once.
      const text = approvalText(decided.code, decided.summary, command === '/approve');
      void this.deps.lanes.run(targetKey, () => this.process({ ...row, text }, targetKey)).catch((e) => this.log('error', `resuming ${row.id}: ${errorMessage(e)}`));
      return;
    }
    if (command === '/start') {
      store.setInbox(row.id, 'done');
      this.reply(row, "Hi! I'm Ruby. Send me a message to get started. /new starts a fresh conversation; /stop cancels a running task.");
      return;
    }
    void this.deps.lanes.run(key, () => this.process(row, key)).catch((e) => this.log('error', `processing ${row.id}: ${errorMessage(e)}`));
  }

  private async process(row: InboxRow, key: string): Promise<void> {
    const { store, sessions } = this.deps;
    const agent = this.deps.agentFor?.(key) ?? this.deps.agent;
    const sessionId = this.sessionFor(key, row.channel);
    store.setInbox(row.id, 'processing', { sessionId });
    const controller = new AbortController();
    this.active.set(key, controller);
    const channel = this.channels.get(channelKey(row.channel, row.account));
    void channel?.typing?.(row.chatId);
    const typing = setInterval(() => void channel?.typing?.(row.chatId), 4500);
    typing.unref();
    try {
      const before = sessions.lastSeq(sessionId);
      const task = await agent.run(sessionId, row.text, { signal: controller.signal, source: row.channel });
      store.setInbox(row.id, 'done', { taskId: task.id });
      this.reply(row, this.replyText(sessionId, before, task));
    } catch (e) {
      store.setInbox(row.id, 'done');
      this.log('error', `task for ${row.id} crashed: ${errorMessage(e)}`);
      this.reply(row, 'Sorry, something went wrong on my side. The error has been logged.');
    } finally {
      clearInterval(typing);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }

  private replyText(sessionId: string, afterSeq: number, task: TaskRecord): string {
    const texts = this.deps.sessions
      .events(sessionId, afterSeq)
      .flatMap((e) => (e.type === 'assistant_message' ? [textOf(e.message).trim()] : []))
      .filter(Boolean);
    const text = texts.at(-1) ?? '';
    switch (task.status) {
      case 'completed':
        return text || 'Done.';
      case 'cancelled':
        return text ? `${text}\n\n(Stopped.)` : 'Stopped.';
      case 'waiting_for_approval':
        return `${text ? `${text}\n\n` : ''}${this.approvalPrompt(sessionId) || `⏸ ${task.reason ?? 'An action needs approval.'}`}`;
      case 'budget_exhausted':
        return `${text ? `${text}\n\n` : ''}(Stopped early: ${task.reason ?? 'budget exhausted'})`;
      default:
        return `Sorry, I couldn't finish that. ${task.reason ?? ''}`.trim();
    }
  }

  private approvalPrompt(sessionId: string): string {
    const pending = this.deps.approvals?.pending(sessionId, this.now().toISOString()) ?? [];
    if (pending.length === 0) return '';
    const lines = pending.map((a) => `• ${a.summary}\n  /approve ${a.code}   /deny ${a.code}`);
    return `⏸ I need your approval to continue:\n${lines.join('\n')}`;
  }

  private offerPairing(row: InboxRow): void {
    const now = this.now();
    if (this.deps.store.pairingFor(row.channel, row.sender.id, now.toISOString())) return; // one prompt per code lifetime
    const ttl = this.deps.pairingTtlMinutes ?? 60;
    const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    this.deps.store.addPairing({
      code,
      channel: row.channel,
      account: row.account,
      senderId: row.sender.id,
      senderName: row.sender.displayName ?? null,
      chatId: row.chatId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
    });
    this.log('info', `pairing requested by ${row.channel}:${row.sender.id} (${row.sender.displayName ?? 'unknown'}), code ${code}`);
    this.reply(row, `Hi! I'm a private assistant. To connect, my owner needs to run this on the host:\n\nruby pair approve ${code}\n\nThe code expires in ${ttl} minutes.`);
  }

  private reply(row: InboxRow, text: string): void {
    this.deps.store.enqueue({ channel: row.channel, account: row.account, chatId: row.chatId, text, replyToExternalId: row.externalId });
    void this.deliver();
  }

  private conversationKey(row: InboxRow): string {
    const routes = this.deps.routes ?? [];
    const route =
      routes.find((r) => r.match.channel === row.channel && r.match.chatId === row.chatId) ??
      routes.find((r) => r.match.channel === row.channel && r.match.chatId === undefined);
    return route ? `route:${route.conversation}` : `${row.channel}:${row.account}:${row.chatId}`;
  }

  private sessionFor(key: string, channel: string): string {
    const existing = this.deps.store.conversation(key);
    if (existing) return existing;
    const session = this.deps.sessions.createSession(`${channel} chat`);
    this.deps.store.bindConversation(key, session.id);
    return session.id;
  }

  /** Never replays work that may have had effects; tells the owner instead. */
  private recover(): void {
    const { store, sessions } = this.deps;
    const failed = sessions.failInterrupted('Interrupted by a restart before finishing.');
    if (failed.length) this.log('warn', `${failed.length} task(s) were interrupted by a restart`);
    for (const row of store.inboxByStatus('processing')) {
      store.setInbox(row.id, 'interrupted');
      this.reply(row, "I was restarted while working on your last message, so I stopped. Some steps may already have run. Ask me to check where things stand, or to continue.");
    }
    for (const out of store.outboxByStatus('sending')) {
      const channel = this.channels.get(channelKey(out.channel, out.account));
      if (channel?.capabilities.dedupesSends) store.markRetry(out.deliveryId, 'restarted during send', this.now().toISOString());
      else store.markOutbox(out.deliveryId, 'uncertain', 'Restarted during send; it may or may not have been delivered.');
    }
  }

  /**
   * One send attempt. A send that throws or hangs (the adapter contract says
   * it never does) may still have reached the platform, so it is `uncertain`,
   * unless the channel dedupes resends, in which case retrying is safe.
   */
  private async sendOnce(channel: ChannelAdapter, out: OutboundMessage): Promise<SendResult> {
    const timeoutMs = this.deps.sendTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs); // cleared below; keeps the process alive while a send is in flight
    });
    try {
      const result = await Promise.race([channel.send(out), timedOut]);
      if (result !== 'timeout') return result;
      return this.ambiguous(channel, `Send did not finish within ${timeoutMs}ms; it may or may not have been delivered.`);
    } catch (e) {
      return this.ambiguous(channel, errorMessage(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private ambiguous(channel: ChannelAdapter, error: string): SendResult {
    return channel.capabilities.dedupesSends ? { status: 'failed', retryable: true, error } : { status: 'uncertain', error };
  }

  /** Sends due outbox messages. Concurrent calls share one pass. */
  deliver(): Promise<void> {
    if (this.deps.deliveryEnabled === false) return Promise.resolve();
    if (this.delivering) return this.delivering;
    this.delivering = this.deliverOnce().finally(() => {
      this.delivering = null;
    });
    return this.delivering;
  }

  private async deliverOnce(): Promise<void> {
    const { store } = this.deps;
    const maxAttempts = this.deps.maxDeliveryAttempts ?? 8;
    for (;;) {
      const due = store.claimDue(this.now().toISOString());
      if (due.length === 0) return;
      for (const out of due) {
        const channel = this.channels.get(channelKey(out.channel, out.account));
        if (!channel) {
          store.markOutbox(out.deliveryId, 'failed', `Channel ${out.channel}:${out.account} is not running.`);
          continue;
        }
        const result = await this.sendOnce(channel, out);
        if (result.status === 'sent') {
          store.markSent(out.deliveryId);
        } else if (result.status === 'uncertain') {
          // It may have been delivered: resending could duplicate it, so leave it for the owner.
          store.markOutbox(out.deliveryId, 'uncertain', result.error);
          this.log('warn', `delivery ${out.deliveryId} is uncertain: ${result.error}`);
        } else if (result.retryable && out.attempts < maxAttempts) {
          const delay = result.retryAfterMs ?? Math.min(600_000, 2000 * 2 ** (out.attempts - 1));
          store.markRetry(out.deliveryId, result.error, new Date(this.now().getTime() + delay).toISOString());
        } else {
          store.markOutbox(out.deliveryId, 'failed', result.error);
          this.log('warn', `delivery ${out.deliveryId} failed: ${result.error}`);
        }
      }
    }
  }
}

/**
 * Approves a pairing code and queues a greeting. Safe to call from another
 * process (the CLI): the running service's delivery loop sends the greeting.
 */
export function approvePairing(store: GatewayStore, code: string, now: Date = new Date()): PairingCode | null {
  const p = store.approvePairing(code.trim().toUpperCase(), now.toISOString());
  if (!p) return null;
  store.enqueue({ channel: p.channel, account: p.account, chatId: p.chatId, text: "You're connected. I'm Ruby — how can I help?" });
  return p;
}

function approvalText(code: string, summary: string, approved: boolean): string {
  return approved
    ? `[Owner approved ${code}: ${summary}] Go ahead with exactly that operation, then continue.`
    : `[Owner declined ${code}: ${summary}] Do not do that. Continue without it, or explain what you need.`;
}

/** Parses a per-chat conversation key (`channel:account:chatId`); other keys (routes, jobs, API) return null. */
function chatOfKey(key: string): { channel: string; account: string; chatId: string } | null {
  const [channel, account, ...rest] = key.split(':');
  if (!channel || !account || rest.length === 0 || ['route', 'job', 'api', 'dashboard'].includes(channel)) return null;
  return { channel, account, chatId: rest.join(':') };
}

const channelKey = (channel: string, account: string) => `${channel}:${account}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
