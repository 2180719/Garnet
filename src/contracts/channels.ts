// Channel adapter contract. Adapters normalize a messaging platform into these
// shapes; the gateway owns identity, routing, dedupe and durable delivery.

export type InboundMessage = {
  channel: string; // e.g. "telegram"
  account: string; // which bot/account of that channel received it
  chatId: string;
  /** Platform message ID, unique per (channel, account, chatId). Used for dedupe. */
  externalId: string;
  sender: { id: string; displayName?: string };
  text: string;
  /** True for one-to-one chats. Group chats never get private memory or pairing. */
  isPrivate: boolean;
  receivedAt: string; // ISO timestamp
  /**
   * Set when the message carried content Ruby cannot read yet (voice note,
   * photo, file, sticker...). `text` then holds the caption, if any. The
   * gateway answers honestly instead of dropping the message.
   */
  unsupported?: UnsupportedContent;
};

export type UnsupportedContent = 'voice' | 'audio' | 'photo' | 'video' | 'file' | 'sticker' | 'other';

export type OutboundMessage = {
  deliveryId: string;
  channel: string;
  account: string;
  chatId: string;
  text: string; // plain text; adapters handle formatting and splitting
  replyToExternalId?: string;
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
  /** Optional "typing…" hint while a task runs. Never throws. */
  typing?(chatId: string): Promise<void>;
  /** Stops receiving and releases platform sessions (e.g. long polls) before resolving, for clean handover. */
  stop(): Promise<void>;
  health(): ChannelHealth;
}
