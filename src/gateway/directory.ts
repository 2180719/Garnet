// Delivery targets for messages Ruby sends on its own (send_message, job
// results): which chat a session belongs to, which chats belong to paired
// identities, and recording a sent message in the target chat's conversation.
import { RubyError } from '../contracts/index.ts';
import type { GatewayStore, SessionStore } from '../store/index.ts';
import type { Route } from './gateway.ts';

/** A chat Ruby can message: always a private chat of a paired identity. */
export type ChatTarget = { channel: string; account: string; chatId: string; senderId: string | null; name: string | null };

/** Where a session lives: its conversation key and, for a channel chat, the chat. */
export type SessionOrigin = {
  conversation: string | null;
  /** The chat replies in this session go to; null for terminal, API, dashboard and job sessions. */
  chat: ChatTarget | null;
  /** True for a scheduled job's own session. */
  isJob: boolean;
};

export type DirectoryDeps = { store: GatewayStore; sessions: SessionStore; routes?: Route[] };

const SURFACES = new Set(['route', 'job', 'api', 'dashboard', 'cli', 'demo']);

/** Parses a per-chat conversation key (`channel:account:chatId`); other keys (routes, jobs, API) return null. */
export function chatOfKey(key: string): { channel: string; account: string; chatId: string } | null {
  const [channel, account, ...rest] = key.split(':');
  if (!channel || !account || rest.length === 0 || SURFACES.has(channel)) return null;
  return { channel, account, chatId: rest.join(':') };
}

/** The conversation key a chat's messages go to (honoring `routes`). */
export function conversationKeyFor(routes: Route[], chat: { channel: string; account: string; chatId: string }): string {
  const route =
    routes.find((r) => r.match.channel === chat.channel && r.match.chatId === chat.chatId) ??
    routes.find((r) => r.match.channel === chat.channel && r.match.chatId === undefined);
  return route ? `route:${route.conversation}` : `${chat.channel}:${chat.account}:${chat.chatId}`;
}

export class ChatDirectory {
  private readonly deps: DirectoryDeps;

  constructor(deps: DirectoryDeps) {
    this.deps = deps;
  }

  /** Paired private chats, most recently active first. */
  chats(): ChatTarget[] {
    return this.deps.store.pairedChats().map((c) => ({ channel: c.channel, account: c.account, chatId: c.chatId, senderId: c.senderId, name: c.displayName }));
  }

  private known(ref: { channel: string; account: string; chatId: string }): ChatTarget {
    const match = this.chats().find((c) => c.channel === ref.channel && c.account === ref.account && c.chatId === ref.chatId);
    return match ?? { ...ref, senderId: null, name: null };
  }

  origin(sessionId: string): SessionOrigin {
    const key = this.deps.store.keyForSession(sessionId) ?? null;
    if (!key) return { conversation: null, chat: null, isJob: false };
    if (key.startsWith('job:')) return { conversation: key, chat: null, isJob: true };
    const direct = chatOfKey(key);
    if (direct) return { conversation: key, chat: this.known(direct), isJob: false };
    if (key.startsWith('route:')) {
      // A shared conversation: answer the chat that wrote into it most recently.
      const last = this.deps.store.lastChatForSession(sessionId);
      return { conversation: key, chat: last ? this.known(last) : null, isJob: false };
    }
    return { conversation: key, chat: null, isJob: false };
  }

  /**
   * Resolves who to message. `to` may be omitted or "here" (this chat, else
   * the owner's most recently used chat), "owner" (the most recently used
   * paired chat), a channel name ("telegram": the latest paired chat there),
   * or "<channel>:<id>" with a paired sender ID or chat ID. Only private chats
   * of paired identities can be targeted, never arbitrary IDs.
   */
  resolve(to: string | undefined, sessionId: string): ChatTarget {
    const spec = (to ?? '').trim();
    const chats = this.chats();
    const choices = () =>
      chats.length
        ? `Paired chats: ${chats.map((c) => `${c.channel}:${c.senderId}${c.name ? ` (${c.name})` : ''}`).join(', ')}.`
        : 'No paired chats yet: the owner must message Ruby on a channel and pair it first (ruby pair).';
    if (spec === '' || spec === 'here') {
      const here = this.origin(sessionId).chat;
      if (here) return here;
    }
    if (spec === '' || spec === 'here' || spec === 'owner') {
      const latest = chats[0];
      if (!latest) throw new RubyError('invalid_input', `There is no chat to send to. ${choices()}`);
      return latest;
    }
    const [channel, ...rest] = spec.split(':');
    const id = rest.join(':');
    const onChannel = chats.filter((c) => c.channel === channel);
    if (!id) {
      if (onChannel[0]) return onChannel[0];
      throw new RubyError('invalid_input', `No paired chat on "${channel}". ${choices()}`);
    }
    const match = onChannel.find((c) => c.senderId === id) ?? onChannel.find((c) => c.chatId === id);
    if (!match) throw new RubyError('invalid_input', `"${spec}" is not a paired chat; Ruby only messages paired identities. ${choices()}`);
    return match;
  }

  /** "telegram (Ada)" or "discord chat 123". */
  static label(t: ChatTarget): string {
    return t.name ? `${t.channel} (${t.name})` : `${t.channel} chat ${t.chatId}`;
  }


  /**
   * Records a message Ruby sent on its own in the target chat's conversation
   * (creating it if needed), so a reply ("tell me more") has context. A new
   * event, marked as not written by the owner; the log stays append-only.
   * Callers that may race a running turn go through the conversation's lane
   * (`Gateway.notify`). With `taint`, the sender's untrusted sources follow the note as inherited `tainted` events. Skipped when the target is `skipSession` (the sender's
   * own conversation already has the tool call).
   */
  record(target: { channel: string; account: string; chatId: string }, text: string, note: { from: string; skipSession?: string; taint?: readonly string[] }): void {
    const key = conversationKeyFor(this.deps.routes ?? [], target);
    let sessionId = this.deps.store.conversation(key);
    if (!sessionId) {
      sessionId = this.deps.sessions.createSession(`${target.channel} chat`).id;
      this.deps.store.bindConversation(key, sessionId);
    }
    if (sessionId === note.skipSession) return;
    this.deps.sessions.append(sessionId, {
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'text', text: `[Context note, not written by your owner: you sent them this message from ${note.from}.]\n${text}` }] },
      source: 'notification',
    });
    // A tainted sender's text can carry injected instructions: the conversation it lands in is tainted too.
    for (const source of new Set(note.taint ?? [])) this.deps.sessions.append(sessionId, { type: 'tainted', source, inherited: true });
  }
}
