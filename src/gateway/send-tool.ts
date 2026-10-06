import { z } from 'zod';
import { RubyError, type ToolDefinition } from '../contracts/index.ts';
import type { GatewayStore } from '../store/index.ts';
import { ChatDirectory } from './directory.ts';

type SendInput = { text: string; to?: string | undefined };

export type SendMessageDeps = {
  directory: ChatDirectory;
  store: GatewayStore;
  /** Queues the message and records it in the target chat's conversation (`Gateway.notify`, late-bound). Returns the delivery ID. */
  notify: (target: { channel: string; account: string; chatId: string }, text: string, record: { from: string; skipSession?: string; taint?: readonly string[] }) => string;
  /** Messages per rolling hour across all chats (`gateway.messagesPerHour`). */
  perHour: number;
  now?: () => Date;
};

/**
 * Throws when Ruby already sent `perHour` messages or files on its own in the
 * last hour (shared by send_message and send_file). Returns how many it sent.
 */
export function assertSendAllowed(store: GatewayStore, perHour: number, now: Date): number {
  const sent = store.sentSince(new Date(now.getTime() - 3_600_000).toISOString());
  if (sent >= perHour) {
    throw new RubyError(
      'budget_exhausted',
      `Not sent: Ruby already sent ${sent} messages or files on its own in the last hour (limit gateway.messagesPerHour = ${perHour}). Do not retry now; include it in your reply instead.`,
    );
  }
  return sent;
}

/**
 * `send_message`: messages a paired chat on Ruby's own initiative (capability
 * `message.send`, ask by default). Only private chats of paired identities can
 * be targeted, sends are rate-limited per hour, and each message is recorded
 * in the target chat's conversation. Delivery is durable (the outbox).
 *
 * Untrusted-content containment: the capability is declared here so a
 * tainted task (one that read web pages, email or other untrusted text) can
 * escalate this tool to `ask` in the executor without changes here.
 */
export function sendMessageTool(deps: SendMessageDeps): ToolDefinition<SendInput> {
  const now = deps.now ?? (() => new Date());
  return {
    name: 'send_message',
    version: 1,
    description:
      'Send a message to your owner on a messaging channel, e.g. to report back from long work or to reach them in another chat. Your normal reply already goes to the current chat, so do not use this to answer. Only paired chats can be reached.',
    input: z.object({
      text: z.string().trim().min(1).max(4000).describe('The message, as plain text.'),
      to: z
        .string()
        .max(200)
        .optional()
        .describe('Omit for the current chat (or, outside a chat, the owner\'s most recent one). "owner", a channel ("telegram"), or "channel:id" with a paired sender or chat id.'),
    }),
    capability: 'message.send',
    idempotent: false,
    targets: (input, ctx) => {
      const t = deps.directory.resolve(input.to, ctx.sessionId);
      return [`${t.channel}:${t.chatId}`];
    },
    summarize: (input, ctx) => {
      const t = deps.directory.resolve(input.to, ctx.sessionId);
      return `send_message to ${ChatDirectory.label(t)}:\n${input.text}`;
    },
    async run(input, ctx) {
      const target = deps.directory.resolve(input.to, ctx.sessionId);
      const sent = assertSendAllowed(deps.store, deps.perHour, now());
      const here = deps.directory.origin(ctx.sessionId).chat;
      const sameChat = !!here && here.channel === target.channel && here.account === target.account && here.chatId === target.chatId;
      const deliveryId = deps.notify(target, input.text, { from: 'send_message', skipSession: ctx.sessionId, ...(ctx.taint?.sources.length ? { taint: ctx.taint.sources } : {}) });
      deps.store.recordSent({ sessionId: ctx.sessionId, channel: target.channel, account: target.account, chatId: target.chatId, deliveryId });
      return {
        content: `Queued for ${ChatDirectory.label(target)}${sameChat ? ' (this chat)' : ''}; it is delivered by the running Ruby service. ${deps.perHour - sent - 1} more message(s) allowed this hour.`,
        data: { deliveryId, channel: target.channel, chatId: target.chatId },
      };
    },
  };
}
