// Provider-neutral conversation shapes. Adapters translate to and from these.

export type TextBlock = { type: 'text'; text: string };

export type ToolCallBlock = {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: 'tool_result';
  callId: string;
  content: string;
  isError: boolean;
};

/**
 * Opaque provider data that must survive persistence and be sent back
 * unchanged (for example, signed thinking blocks). Only the adapter that
 * produced it interprets it.
 */
export type ProviderBlock = {
  type: 'provider';
  provider: string;
  data: unknown;
  /**
   * True when the block is bound to the exact conversation prefix that
   * produced it (e.g. signed thinking). Bound blocks are dropped from turns
   * retained after compaction, because their prefix no longer exists.
   */
  bound?: boolean;
};

export type AttachmentKind = 'image' | 'document' | 'audio' | 'video' | 'file';

/**
 * A file stored by the media store. The event log keeps only this reference;
 * the bytes live on disk under `<home>/media`, addressed by `id`.
 */
export type AttachmentRef = {
  /** `med_<sha256 prefix>`: content-addressed, so the same file is stored once. */
  id: string;
  kind: AttachmentKind;
  /** Sniffed from the bytes where possible; never trusted from the sender alone. */
  mimeType: string;
  name?: string;
  size: number;
  /** Audio and video length, when the platform reported it. */
  durationSec?: number;
};

/**
 * A file in a user turn. `text` is content derived at ingest (a voice-note
 * transcript, a text file's contents); `note` says why there is none or what
 * was left out. Both are persisted with the reference.
 */
export type AttachmentBlock = {
  type: 'attachment';
  attachment: AttachmentRef;
  text?: string;
  note?: string;
  /**
   * Base64 bytes. Set only on blocks inside a `ModelRequest`, by the runtime,
   * for images and documents the model can read natively; never persisted.
   */
  data?: string;
};

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ProviderBlock | AttachmentBlock;

export type Role = 'user' | 'assistant';

export type ChatMessage = {
  role: Role;
  content: ContentBlock[];
};

export function textOf(message: ChatMessage): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function toolCallsOf(message: ChatMessage): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
}

export function attachmentsOf(message: ChatMessage): AttachmentBlock[] {
  return message.content.filter((b): b is AttachmentBlock => b.type === 'attachment');
}

/** "12 KB", "3.4 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Image types every vision-capable provider accepts inline. */
export const NATIVE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const KIND_LABEL: Record<AttachmentKind, string> = { image: 'Image', document: 'Document', audio: 'Audio', video: 'Video', file: 'File' };

/**
 * A text rendering of an attachment for models (or surfaces) that do not get
 * the bytes: a header with what it is, then derived text and any note.
 * `omitted` explains why the file itself is not shown.
 */
export function attachmentText(block: AttachmentBlock, omitted?: string): string {
  const a = block.attachment;
  const facts = [a.name ? JSON.stringify(a.name) : null, a.mimeType, formatBytes(a.size), a.durationSec !== undefined ? `${Math.round(a.durationSec)}s` : null].filter(Boolean);
  const lines = [`[${KIND_LABEL[a.kind]} attached: ${facts.join(', ')}; id ${a.id}]`];
  if (omitted) lines.push(`(${omitted})`);
  if (block.note) lines.push(`(${block.note})`);
  if (block.text) lines.push(block.text);
  return lines.join('\n');
}
