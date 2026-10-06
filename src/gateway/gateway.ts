import { randomInt } from 'node:crypto';
import {
  addUsage,
  costOf,
  eventsCost,
  formatUsd,
  type Pricing,
  billedTokens,
  errorMessage,
  GarnetError,
  textOf,
  unknownUsage,
  type ChannelAdapter,
  type ContentBlock,
  type InboundAttachment,
  type InboundMessage,
  type OutboundMessage,
  type SendResult,
  type SessionEvent,
  type TaskRecord,
  type UnsupportedContent,
} from '../contracts/index.ts';
import type { Agent, LaneQueue, RuntimeEvent } from '../runtime/index.ts';
import type { FailedFile, MediaIngest, MediaInput } from '../media/index.ts';
import type { ApprovalStore, GatewayStore, InboxRow, PairingCode, SessionStore } from '../store/index.ts';
import { ChatDirectory, chatOfKey, conversationKeyFor } from './directory.ts';

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
  /** Stores, transcribes and describes inbound files. Without it, files get an honest "can't receive files" reply. */
  media?: MediaIngest;
  /** Shown by /status and /usage. */
  model?: { id: string; contextWindow: number; pricing?: Pricing | undefined };
  /** The configured assistant name. Defaults to "Garnet". */
  assistantName?: string | undefined;
};

export type ChatResult = { task: TaskRecord; text: string; sessionId: string };

/** Chat commands every channel understands (see /help). */
const HELP = [
  'Commands:',
  '/new: start a fresh conversation (memory and settings stay)',
  '/stop: cancel the running task',
  '/retry: run your last message again',
  '/usage: tokens and cost of this conversation (also /cost)',
  '/status: model, running task, pending approvals, channel health',
  '/approve CODE, /deny CODE: decide a pending action',
  '/help: this list',
].join('\n');

const UNSUPPORTED_REPLY: Record<UnsupportedContent, string> = {
  voice: "I can't listen to voice notes yet. Could you type it instead?",
  audio: "I can't listen to audio files yet. Could you type what you need instead?",
  photo: "I can't see photos yet. Could you describe it, or paste the text you need me to read?",
  video: "I can't watch videos yet. Could you describe what you need instead?",
  file: "I can't open files sent in chat yet. Paste the text, or put the file in my workspace and tell me its name.",
  sticker: "I can't see stickers yet, but I'm here. Send me a text message.",
  other: "I can only read text messages for now. Could you send that as text?",
};

/** A turn for a non-channel surface: text plus files already in memory (e.g. data URLs from the HTTP API). */
export type ChatInput = string | { text: string; files: (MediaInput | FailedFile)[] };

function unsupportedReply(kind: UnsupportedContent, hasCaption: boolean): string {
  return `${UNSUPPORTED_REPLY[kind]}${hasCaption ? ' (I did not act on the caption either; send it as its own message if it stands alone.)' : ''}`;
}

/** The reply category for a file when media handling is off. */
function unsupportedOfFile(f: InboundAttachment): UnsupportedContent {
  if (f.kind === 'image') return 'photo';
  if (f.kind === 'video') return 'video';
  if (f.kind === 'audio') return /voice/i.test(f.name ?? '') || f.mimeType === 'audio/ogg' ? 'voice' : 'audio';
  return 'file';
}

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
  private readonly directory: ChatDirectory;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.directory = new ChatDirectory({ store: deps.store, sessions: deps.sessions, routes: deps.routes ?? [] });
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
    const { unsupported, ...rest } = message;
    // Keep the caption (or a placeholder) in the inbox so the record shows what arrived.
    const row = this.deps.store.receive(unsupported ? { ...rest, text: rest.text || `[${unsupported}]` } : rest);
    if (!row) return; // duplicate delivery
    if (unsupported) return this.answerUnsupported(row, unsupported, message.text.trim() !== '');
    if (this.started && !this.stopping) this.dispatch(row);
  }

  /**
   * Content Garnet cannot read yet (voice, photos, files) gets a short honest
   * reply instead of silence. It never reaches the model: a caption alone
   * would be answered as if the attachment had been seen.
   */
  private answerUnsupported(row: InboxRow, kind: UnsupportedContent, hasCaption: boolean): void {
    const { store } = this.deps;
    if (!row.isPrivate) {
      store.setInbox(row.id, 'ignored');
      return;
    }
    if (!store.identity(row.channel, row.sender.id)) {
      store.setInbox(row.id, 'ignored');
      this.offerPairing(row);
      return;
    }
    store.setInbox(row.id, 'done');
    this.reply(row, unsupportedReply(kind, hasCaption));
  }

  /** Whether a conversation key already has a session (the API uses it to replay a stateless client's history once). */
  hasConversation(key: string): boolean {
    return this.deps.store.conversation(key) !== undefined;
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
    input: ChatInput,
    options: { signal?: AbortSignal; onEvent?: (e: RuntimeEvent) => void; source: string; /** Untrusted sources carried into this task (a job created by a tainted conversation). */ taint?: readonly string[] },
  ): Promise<ChatResult> {
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
        let turn: string | ContentBlock[] = typeof input === 'string' ? input : input.text;
        if (typeof input !== 'string' && input.files.length) {
          const media = this.deps.media;
          if (!media) throw new GarnetError('invalid_input', 'Files are not accepted: media handling is off (media.enabled in config.json).');
          const blocks = [...(input.text.trim() ? [{ type: 'text' as const, text: input.text }] : []), ...(await media.ingest(input.files, { sessionId, signal: controller.signal }))];
          const unreadable = media.unreadableReply(blocks);
          if (unreadable) throw new GarnetError('invalid_input', unreadable);
          turn = blocks;
        }
        const task = await agent.run(sessionId, turn, { ...options, signal: controller.signal });
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
    if (!approvals) throw new GarnetError('invalid_input', 'Approvals are not enabled.');
    const decided = approvals.decide(code, decision, this.now().toISOString());
    if (!decided) throw new GarnetError('invalid_input', 'No pending approval with that code (it may have expired or been decided).');
    const key = this.deps.store.keyForSession(decided.sessionId);
    if (!key) return { status: decision, text: null, resumed: false };
    const result = await this.chat(key, approvalText(decided.code, decided.summary, decision === 'approved'), { source: 'dashboard' });
    const chat = chatOfKey(key);
    if (chat && this.channels.has(channelKey(chat.channel, chat.account))) this.notify(chat, result.text);
    return { status: result.task.status, text: result.text, resumed: true };
  }

  /**
   * `/approve CODE` or `/deny CODE` typed in a non-channel chat (the HTTP
   * API). Only approvals raised in that same conversation can be decided
   * there; others are decided in their own chat or on the dashboard. On
   * success the task resumes and its result is returned.
   */
  async approveInConversation(
    conversationKey: string,
    code: string,
    decision: 'approved' | 'denied',
    options: { signal?: AbortSignal; onEvent?: (e: RuntimeEvent) => void; source: string },
  ): Promise<ChatResult | { text: string }> {
    const approvals = this.deps.approvals;
    if (!approvals) return { text: 'Approvals are not enabled.' };
    const pending = approvals.get(code.toUpperCase());
    if (!pending || pending.status !== 'pending') return { text: 'No pending approval with that code.' };
    if (this.deps.store.keyForSession(pending.sessionId) !== conversationKey) {
      return { text: 'That approval belongs to another conversation. Decide it there, or on the dashboard.' };
    }
    const decided = approvals.decide(pending.code, decision, this.now().toISOString());
    if (!decided) return { text: 'That approval already expired or was decided.' };
    return this.chat(conversationKey, approvalText(decided.code, decided.summary, decision === 'approved'), options);
  }

  /**
   * Queues a proactive message (scheduled results, alerts, files) to a chat. With
   * `record`, the text is also written into that chat's conversation as a
   * context note, so a reply ("tell me more") has something to refer to. The
   * note is appended after any running task (append-only, never mid-turn).
   */
  notify(
    target: { channel: string; account: string; chatId: string },
    text: string,
    record?: { from: string; skipSession?: string },
    attachments?: OutboundMessage['attachments'],
  ): string {
    const out = this.deps.store.enqueue({ ...target, text, ...(attachments?.length ? { attachments } : {}) });
    void this.deliver();
    if (!record) return out.deliveryId;
    const key = this.conversationKeyFor(target.channel, target.account, target.chatId);
    // On the conversation's lane, so the note never lands in the middle of a running turn.
    void this.deps.lanes
      .run(key, async () => this.directory.record(target, text, record))
      .catch((e) => this.log('warn', `recording a notification in ${key}: ${errorMessage(e)}`));
    return out.deliveryId;
  }

  /** Channel liveness and delivery backlog, for health endpoints. */
  health(): { channels: { channel: string; account: string; ok: boolean; lastSuccessAt: string | null; lastError: string | null }[]; outbox: Record<string, number> } {
    const { pending, failed, uncertain } = this.deps.store.outboxCounts();
    const outbox: Record<string, number> = { pending, failed, uncertain };
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
      const name = this.deps.assistantName || 'Garnet';
      this.reply(row, `Hi! I'm ${name}. Send me a message to get started. /new starts a fresh conversation; /stop cancels a running task; /help lists every command.`);
      return;
    }
    if (command === '/help') {
      store.setInbox(row.id, 'done');
      this.reply(row, HELP);
      return;
    }
    if (command === '/usage' || command === '/cost') {
      store.setInbox(row.id, 'done');
      this.reply(row, this.usageText(key));
      return;
    }
    if (command === '/status') {
      store.setInbox(row.id, 'done');
      this.reply(row, this.statusText(key));
      return;
    }
    if (command === '/retry') {
      if (this.active.has(key)) {
        store.setInbox(row.id, 'done');
        this.reply(row, "I'm still working on your last message. Send /stop first if you want me to start over.");
        return;
      }
      const sessionId = store.conversation(key);
      const last = sessionId ? lastOwnerMessage(this.deps.sessions.events(sessionId)) : null;
      if (!last) {
        store.setInbox(row.id, 'done');
        this.reply(row, 'There is no earlier message in this conversation to retry.');
        return;
      }
      // The log is append-only: the earlier attempt stays in history, so say plainly what is happening.
      const text = `${RETRY_PREFIX}${last}`;
      void this.deps.lanes.run(key, () => this.process({ ...row, text }, key)).catch((e) => this.log('error', `retrying ${row.id}: ${errorMessage(e)}`));
      return;
    }
    void this.deps.lanes.run(key, () => this.process(row, key)).catch((e) => this.log('error', `processing ${row.id}: ${errorMessage(e)}`));
  }

  /**
   * The turn for an inbound message: its text plus its files, downloaded from
   * the channel (only now, for a paired sender), stored and described. Returns
   * a direct reply instead when nothing in it is readable (a voice note with
   * no transcription set up, an image for a text-only model).
   */
  private async inboundTurn(row: InboxRow, sessionId: string, channel: ChannelAdapter | undefined, signal: AbortSignal): Promise<{ turn: string | ContentBlock[] } | { reply: string }> {
    const files = row.attachments ?? [];
    if (files.length === 0) return { turn: row.text };
    const text: ContentBlock[] = row.text.trim() ? [{ type: 'text', text: row.text }] : [];
    const media = this.deps.media;
    // Media handling off (media.enabled false): the same honest answer as other unreadable content; a caption is not acted on alone.
    if (!media) return { reply: unsupportedReply(unsupportedOfFile(files[0]!), row.text.trim() !== '') };
    const received: (MediaInput | FailedFile)[] = [];
    for (const f of files) {
      const base = { name: f.name, kind: f.kind };
      if (f.size !== undefined && f.size > media.maxBytes) {
        received.push({ ...base, error: `it is ${(f.size / 1048576).toFixed(1)} MB, over the ${(media.maxBytes / 1048576).toFixed(1)} MB limit (media.maxBytes)` });
        continue;
      }
      if (!channel?.fetchAttachment) {
        received.push({ ...base, error: `the ${row.channel} channel cannot download files` });
        continue;
      }
      try {
        const got = await channel.fetchAttachment(f.ref, { maxBytes: media.maxBytes, signal });
        received.push({ data: got.data, name: f.name, mimeType: got.mimeType ?? f.mimeType, durationSec: f.durationSec });
      } catch (e) {
        if (signal.aborted) throw e;
        this.log('warn', `${row.channel} attachment download failed: ${errorMessage(e)}`);
        received.push({ ...base, error: errorMessage(e) });
      }
    }
    const blocks = [...text, ...(await media.ingest(received, { sessionId, signal }))];
    const unreadable = media.unreadableReply(blocks);
    return unreadable ? { reply: unreadable } : { turn: blocks };
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
      const prepared = await this.inboundTurn(row, sessionId, channel, controller.signal);
      if ('reply' in prepared) {
        store.setInbox(row.id, 'done');
        this.reply(row, prepared.reply);
        return;
      }
      const before = sessions.lastSeq(sessionId);
      const task = await agent.run(sessionId, prepared.turn, { signal: controller.signal, source: row.channel });
      store.setInbox(row.id, 'done', { taskId: task.id });
      this.reply(row, this.replyText(sessionId, before, task));
    } catch (e) {
      store.setInbox(row.id, 'done');
      if (controller.signal.aborted) {
        // /stop while files were still downloading or being transcribed.
        this.reply(row, 'Stopped.');
        return;
      }
      this.log('error', `task for ${row.id} crashed: ${errorMessage(e)}`);
      this.reply(row, 'Sorry, something went wrong on my side. The error has been logged.');
    } finally {
      clearInterval(typing);
      if (this.active.get(key) === controller) this.active.delete(key);
    }
  }

  /** /usage: tokens this conversation's session has used, never treating unknown as zero. */
  private usageText(key: string): string {
    const sessionId = this.deps.store.conversation(key);
    if (!sessionId) return 'No usage yet: this conversation has not run a task.';
    let usage = unknownUsage();
    let context: number | null = null;
    let lastTaskId: string | null = null;
    const events = this.deps.sessions.events(sessionId);
    for (const e of events) {
      if (e.type === 'assistant_message' || e.type === 'checkpoint') usage = addUsage(usage, e.usage);
      if (e.type === 'assistant_message') context = e.usage.inputTokens === null && e.usage.cacheReadTokens === null ? null : billedTokens(e.usage);
      if (e.type === 'checkpoint') context = null; // unknown until the next request
      if (e.type === 'task_status') lastTaskId = e.taskId;
    }
    const n = (v: number | null) => (v === null ? '?' : v.toLocaleString('en-US'));
    const window = this.deps.model?.contextWindow;
    const lines = [
      `Usage in this conversation (session ${sessionId}):`,
      `• input ${n(usage.inputTokens)} · cache read ${n(usage.cacheReadTokens)} · cache write ${n(usage.cacheWriteTokens)} · output ${n(usage.outputTokens)} tokens`,
      `• context at the last request: ${context === null ? 'unknown' : `${n(context)}${window ? ` of ${n(window)}` : ''} tokens`}`,
    ];
    const pricing = this.deps.model?.pricing;
    lines.push(`• cost: ${formatUsd(eventsCost(events, pricing))}${pricing ? '' : ' (no price known for this model; set model.pricing)'}`);
    const task = lastTaskId ? this.deps.sessions.getTask(lastTaskId) : undefined;
    if (task) lines.push(`• last task: ${n(billedTokens(task.usage))} tokens, ${task.modelCalls} model call(s), ${task.toolCalls} tool call(s), ${task.status.replaceAll('_', ' ')}${task.modelCalls ? `, cost ${formatUsd(costOf(task.usage, pricing))}` : ''}`);
    lines.push('"?" means the provider did not report it; Garnet never counts unknown as zero.');
    return lines.join('\n');
  }

  /** /status: what Garnet is doing in this conversation and whether its channels are healthy. */
  private statusText(key: string): string {
    const sessionId = this.deps.store.conversation(key);
    const lines = ['Status:'];
    if (this.deps.model) lines.push(`• model: ${this.deps.model.id}`);
    lines.push(`• this conversation: ${this.active.has(key) ? 'working on a task (/stop cancels it)' : 'idle'}${sessionId ? `, session ${sessionId}` : ''}`);
    const pending = sessionId ? (this.deps.approvals?.pending(sessionId, this.now().toISOString()) ?? []) : [];
    for (const a of pending) lines.push(`• waiting for approval: ${a.summary} (/approve ${a.code} or /deny ${a.code})`);
    lines.push(`• tasks running overall: ${this.active.size}`);
    const { channels } = this.health();
    for (const c of channels) lines.push(`• ${c.channel}: ${c.ok ? 'ok' : `not ok${c.lastError ? ` (${c.lastError})` : ''}`}`);
    const { pending: queued, failed, uncertain } = this.deps.store.outboxCounts();
    lines.push(`• outbox: ${queued} queued, ${failed} failed, ${uncertain} uncertain`);
    return lines.join('\n');
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
    this.deps.store.pruneExpiredPairings(now.toISOString());
    let code: string;
    do code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    while (this.deps.store.hasPairingCode(code));
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
    this.reply(row, `Hi! I'm a private assistant. To connect, my owner needs to run this on the host:\n\ngarnet pair approve ${code}\n\nThe code expires in ${ttl} minutes.`);
  }

  private reply(row: InboxRow, text: string): void {
    this.deps.store.enqueue({ channel: row.channel, account: row.account, chatId: row.chatId, text, replyToExternalId: row.externalId });
    void this.deliver();
  }

  private conversationKey(row: InboxRow): string {
    return this.conversationKeyFor(row.channel, row.account, row.chatId);
  }

  private conversationKeyFor(channel: string, account: string, chatId: string): string {
    return conversationKeyFor(this.deps.routes ?? [], { channel, account, chatId });
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
  store.enqueue({ channel: p.channel, account: p.account, chatId: p.chatId, text: "You're connected. I'm Garnet — how can I help?" });
  return p;
}

const RETRY_PREFIX = '[Your owner used /retry: answer this earlier message again, from scratch.]\n\n';

/** The newest message the owner wrote in a session (not an approval continuation or context note; a retry counts as its original). */
function lastOwnerMessage(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== 'user_message' || e.source === 'notification') continue;
    let text = textOf(e.message).trim();
    if (/^\[Owner (approved|declined) /.test(text)) continue;
    if (text.startsWith(RETRY_PREFIX.trim())) text = text.slice(RETRY_PREFIX.trim().length).trim();
    if (text) return text;
  }
  return null;
}

function approvalText(code: string, summary: string, approved: boolean): string {
  return approved
    ? `[Owner approved ${code}: ${summary}] Go ahead with exactly that operation, then continue.`
    : `[Owner declined ${code}: ${summary}] Do not do that. Continue without it, or explain what you need.`;
}

const channelKey = (channel: string, account: string) => `${channel}:${account}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
