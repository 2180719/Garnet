import {
  NATIVE_IMAGE_TYPES,
  attachmentText,
  type AttachmentBlock,
  type AttachmentRef,
  type ChatMessage,
  type ContentBlock,
  type MediaCapabilities,
} from '../contracts/index.ts';

export type AttachmentView = {
  /** What the model reads natively; undefined means text only. */
  media: MediaCapabilities | undefined;
  /** Most images and PDFs sent as bytes in one request; older ones become text placeholders. */
  maxInContext: number;
  /** The stored bytes, or null when the file is gone. */
  load: ((ref: AttachmentRef) => Uint8Array | null) | undefined;
};

/**
 * Prepares derived messages for a model request. Attachment references from
 * the event log become either native blocks with their bytes (`data`) —
 * images and PDFs the model can read, newest first, at most `maxInContext` —
 * or text: a header with the file's details plus any transcript or extracted
 * text. Older images past the cap are replaced by a placeholder, so a long
 * photo-heavy chat cannot outgrow the context window. Returns new messages;
 * the input (and the event log) is never changed.
 */
export function prepareAttachments(messages: ChatMessage[], view: AttachmentView): ChatMessage[] {
  let budget = view.maxInContext;
  const out: ChatMessage[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.content.some((b) => b.type === 'attachment')) {
      out[i] = m;
      continue;
    }
    const blocks: ContentBlock[][] = new Array(m.content.length);
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j]!;
      if (b.type !== 'attachment') {
        blocks[j] = [b];
        continue;
      }
      const stored: AttachmentBlock = { type: 'attachment', attachment: b.attachment, ...(b.text !== undefined ? { text: b.text } : {}), ...(b.note !== undefined ? { note: b.note } : {}) };
      const native = nativeReason(stored, view.media);
      if (native !== true) {
        blocks[j] = [{ type: 'text', text: attachmentText(stored, native ?? undefined) }];
        continue;
      }
      if (budget <= 0) {
        blocks[j] = [{ type: 'text', text: attachmentText(stored, 'Not shown again here, to save context. Ask the owner to resend it if you need to see it.') }];
        continue;
      }
      const bytes = view.load?.(stored.attachment) ?? null;
      if (!bytes) {
        blocks[j] = [{ type: 'text', text: attachmentText(stored, 'The stored file is no longer available.') }];
        continue;
      }
      budget--;
      blocks[j] = [{ type: 'text', text: attachmentText(stored) }, { ...stored, data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') }];
    }
    out[i] = { role: m.role, content: blocks.flat() };
  }
  return out;
}

/** True when the model can take the file as bytes; otherwise why not (null when there is nothing to explain). */
function nativeReason(b: AttachmentBlock, media: MediaCapabilities | undefined): true | string | null {
  const a = b.attachment;
  if (a.kind === 'image') {
    if (!media?.images) return 'The current model cannot view images.';
    if (!NATIVE_IMAGE_TYPES.has(a.mimeType)) return `${a.mimeType} images cannot be shown to the model.`;
    if (a.size > media.maxImageBytes) return 'Too large to show the model.';
    return true;
  }
  if (a.mimeType === 'application/pdf' && media?.pdf && a.size <= media.maxPdfBytes && !b.text) return true;
  return null;
}
