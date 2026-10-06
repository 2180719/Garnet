// Channel adapter contract. Adapters normalize a messaging platform into these
// shapes; the gateway owns identity, routing, dedupe and durable delivery.
import type { AttachmentKind } from './messages.ts';

/**
 * A file in an inbound message, not yet downloaded. `ref` is opaque to
 * everyone but the adapter that made it (a Telegram file_id, a Discord CDN
 * URL, a signal-cli attachment id); the gateway persists it and downloads the
 * bytes with `fetchAttachment` only for paired senders.
 */
export type InboundAttachment = {
  kind: AttachmentKind;
  /** As the platform claims it; the media store sniffs the bytes. */
  mimeType?: string;
  name?: string;
  /** Bytes, when the platform says so up front. */
  size?: number;
  durationSec?: number;
  ref: string;
};

/** A stored file to send. `path` is an absolute path the adapter may read. */
export type OutboundAttachment = {
  path: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
};

export type InboundMessage = {
  channel: string; // e.g. "telegram"
  account: string; // which bot/account of that channel received it
  chatId: string;
  /** Platform message ID, unique per (channel, account, chatId). Used for dedupe. */
  externalId: string;
  sender: { id: string; displayName?: string };
  /** Message text or media caption; empty for a file without a caption. */
  text: string;
  attachments?: InboundAttachment[];
  /** Content Ruby cannot read at all (a sticker, a location, a poll), described for an honest reply. */
  unsupported?: string;
  /** True for one-to-one chats. Group chats never get private memory or pairing. */
  isPrivate: boolean;
  receivedAt: string; // ISO timestamp
};

export type OutboundMessage = {
  deliveryId: string;
  channel: string;
  account: string;
  chatId: string;
  text: string; // plain text; adapters handle formatting and splitting
  replyToExternalId?: string;
  /** Files sent before the text; the text may become the last file's caption. */
  attachments?: OutboundAttachment[];
};

export type SendResult =
  | { status: 'sent'; externalIds: string[] }
  /** `retryable: false` means sending again cannot succeed (blocked bot, bad chat). */
  | { status: 'failed'; retryable: boolean; error: string; retryAfterMs?: number }
  /** The request may have reached the platform (e.g. it timed out after sending). The gateway never resends it blindly. */
  | { status: 'uncertain'; error: string };

export type ChannelCapabilities = {
  maxMessageChars: number;
  /** True when the platform can deduplicate a resend of the same delivery. */
  dedupesSends: boolean;
  typingIndicator: boolean;
  /** Set when `send` delivers `attachments`: the largest file the platform accepts from a bot. */
  maxUploadBytes?: number;
};

export type ChannelHealth = {
  ok: boolean;
  /** Last successful poll or send; liveness is judged on real traffic, not a "connected" flag. */
  lastSuccessAt: string | null;
  lastError: string | null;
};

/**
 * The sink persists the message durably before resolving. Adapters must only
 * acknowledge a message to the platform (advance offsets, etc.) after the sink
 * resolves, giving at-least-once delivery; the gateway deduplicates.
 */
export type InboundSink = (message: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly channel: string;
  readonly account: string;
  readonly capabilities: ChannelCapabilities;
  /** Validates credentials and begins receiving. Resolves once receiving has started. */
  start(sink: InboundSink): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  /**
   * Downloads an inbound attachment by its `ref`. Rejects (with a message fit
   * for the owner) when the file is larger than `maxBytes` or unavailable.
   */
  fetchAttachment?(ref: string, options: { maxBytes: number; signal: AbortSignal }): Promise<{ data: Uint8Array; mimeType?: string }>;
  /** Optional "typing…" hint while a task runs. Never throws. */
  typing?(chatId: string): Promise<void>;
  /** Stops receiving and releases platform sessions (e.g. long polls) before resolving, for clean handover. */
  stop(): Promise<void>;
  health(): ChannelHealth;
}
