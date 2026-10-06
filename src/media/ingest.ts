// Turns received files into content blocks: store, sniff, transcribe or extract.
import { NATIVE_IMAGE_TYPES, errorMessage, formatBytes, type AttachmentBlock, type ContentBlock, type MediaCapabilities } from '../contracts/index.ts';
import { runOnFile, type CommandSpec } from './command.ts';
import { isTextMime } from './mime.ts';
import { MediaStore, cleanName, type MediaInput } from './store.ts';
import type { Transcriber } from './transcribe.ts';

export type MediaIngestOptions = {
  store: MediaStore;
  /** Speech to text for audio; null when none is configured. */
  transcriber?: Transcriber | null;
  /** Command that prints a PDF's text (e.g. pdftotext), for models without native PDF input. */
  pdfText?: CommandSpec | null;
  /** What the model reads natively; decides whether PDFs need text extraction and what to tell the owner. */
  modelMedia?: MediaCapabilities | undefined;
  /** Longest text kept inline in the turn; the rest goes to an artifact when `saveText` is set. */
  maxTextChars: number;
  /** Saves a long extracted text for `read_artifact` and returns its id. */
  saveText?: (sessionId: string, text: string) => string;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
};

/** Prefix of the text block that stands in for a file that never arrived. */
const NOT_RECEIVED = '[Not received: ';

/** A file that could not be received at all (too large, download failed), described for the turn. */
export type FailedFile = { name?: string | undefined; kind?: string | undefined; error: string };

/**
 * Ingest for every surface (channels, the HTTP API, the terminal chat): each
 * file is stored once, its type is decided from its bytes, and derived text
 * (a transcript, a text file's contents, a PDF's text) is attached to its
 * block so the event log records exactly what the model was given.
 */
export class MediaIngest {
  readonly store: MediaStore;
  private readonly o: MediaIngestOptions;

  constructor(options: MediaIngestOptions) {
    this.o = options;
    this.store = options.store;
  }

  get maxBytes(): number {
    return this.store.maxBytes;
  }

  get canTranscribe(): boolean {
    return !!this.o.transcriber;
  }

  /** See `unreadableReply`, with this model's capabilities. */
  unreadableReply(blocks: ContentBlock[]): string | null {
    return unreadableReply(blocks, this.o.modelMedia);
  }

  async ingest(files: (MediaInput | FailedFile)[], ctx: { sessionId: string; signal: AbortSignal }): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [];
    for (const f of files) {
      if ('error' in f) {
        blocks.push({ type: 'text', text: `${NOT_RECEIVED}${f.kind ?? 'file'}${f.name ? ` "${cleanName(f.name)}"` : ''}: ${f.error}]` });
        continue;
      }
      let block: AttachmentBlock;
      try {
        block = { type: 'attachment', attachment: this.store.put(f) };
      } catch (e) {
        blocks.push({ type: 'text', text: `${NOT_RECEIVED}file${f.name ? ` "${cleanName(f.name)}"` : ''}: ${errorMessage(e)}]` });
        continue;
      }
      if (f.liveVoice && block.attachment.kind === 'audio') block.liveVoice = true;
      await this.derive(block, f.data, ctx);
      blocks.push(block);
    }
    return blocks;
  }

  private async derive(block: AttachmentBlock, data: Uint8Array, ctx: { sessionId: string; signal: AbortSignal }): Promise<void> {
    const a = block.attachment;
    const media = this.o.modelMedia;
    if (a.kind === 'audio') {
      const t = this.o.transcriber;
      if (!t) {
        block.note = 'No transcription backend is configured (media.transcription), so this audio could not be transcribed.';
        return;
      }
      try {
        const transcript = (await t.transcribe({ data, mimeType: a.mimeType, name: a.name }, ctx.signal)).trim();
        if (transcript) this.setText(block, `Transcript:\n${transcript}`, ctx.sessionId);
        else block.note = 'The transcription was empty (silence or unintelligible audio).';
      } catch (e) {
        this.o.log?.('warn', `transcription failed: ${errorMessage(e)}`);
        block.note = `Transcription failed: ${errorMessage(e)}`;
      }
      return;
    }
    if (a.mimeType === 'application/pdf') {
      if (media?.pdf) return; // read natively
      if (!this.o.pdfText) {
        block.note = 'The model cannot read PDFs directly and no PDF text extractor is configured (media.pdfText).';
        return;
      }
      try {
        const text = (await runOnFile(this.o.pdfText, data, a.mimeType, ctx.signal)).trim();
        if (text) this.setText(block, `Extracted text:\n${text}`, ctx.sessionId);
        else block.note = 'No text could be extracted (the PDF may be scanned images).';
      } catch (e) {
        block.note = `PDF text extraction failed: ${errorMessage(e)}`;
      }
      return;
    }
    if (isTextMime(a.mimeType)) {
      this.setText(block, new TextDecoder().decode(data), ctx.sessionId);
      return;
    }
    if (a.kind === 'video') block.note = 'Video cannot be watched; only the file details are available.';
    else if (a.kind === 'file' || a.kind === 'document') block.note = 'This file type cannot be read; only the file details are available.';
  }

  /** Inline text up to `maxTextChars`; anything longer is saved in full as an artifact when possible. */
  private setText(block: AttachmentBlock, text: string, sessionId: string): void {
    const max = this.o.maxTextChars;
    if (text.length <= max) {
      block.text = text;
      return;
    }
    block.text = text.slice(0, max);
    let where = '';
    if (this.o.saveText) {
      try {
        where = `; the full text is artifact ${this.o.saveText(sessionId, text)} (use read_artifact)`;
      } catch {
        // fall back to the truncated text alone
      }
    }
    block.note = `Showing the first ${max} of ${text.length} characters${where}.`;
  }
}

/**
 * When a message carries no text and nothing in it is readable by the model,
 * the honest answer is a direct reply rather than a model call that can only
 * guess. Returns that reply, or null when the model should run.
 */
export function unreadableReply(blocks: ContentBlock[], media: MediaCapabilities | undefined): string | null {
  if (blocks.some((b) => b.type === 'text' && b.text.trim() && !b.text.startsWith(NOT_RECEIVED))) return null;
  const attachments = blocks.filter((b): b is AttachmentBlock => b.type === 'attachment');
  const failed = blocks.flatMap((b) => (b.type === 'text' && b.text.startsWith(NOT_RECEIVED) ? [b.text.slice(NOT_RECEIVED.length, -1)] : []));
  const reasons: string[] = [];
  for (const b of attachments) {
    const a = b.attachment;
    if (b.text) return null;
    if (a.kind === 'image' && media?.images && a.size <= media.maxImageBytes && NATIVE_IMAGE_TYPES.has(a.mimeType)) return null;
    if (a.mimeType === 'application/pdf' && media?.pdf && a.size <= media.maxPdfBytes) return null;
    reasons.push(reasonFor(b, media));
  }
  for (const f of failed) reasons.push(`I couldn't receive your ${f}.`);
  if (reasons.length === 0) return null;
  return `${[...new Set(reasons)].join('\n')}\nCould you send it as text instead?`;
}


function reasonFor(b: AttachmentBlock, media: MediaCapabilities | undefined): string {
  const a = b.attachment;
  const what = a.kind === 'audio' ? 'your voice note' : a.kind === 'image' ? 'your image' : a.kind === 'video' ? 'your video' : `your file${a.name ? ` "${a.name}"` : ''}`;
  if (a.kind === 'audio') {
    if (b.note?.startsWith('No transcription backend')) return `I got ${what}, but I can't listen to audio: no transcription backend is set up (media.transcription in config.json).`;
    return `I got ${what}, but couldn't transcribe it. ${b.note ?? ''}`.trim();
  }
  if (a.kind === 'image') {
    if (!NATIVE_IMAGE_TYPES.has(a.mimeType)) return `I got ${what}, but ${a.mimeType} images can't be shown to the model (JPEG, PNG, GIF and WebP can).`;
    if (media?.images && a.size > media.maxImageBytes) return `I got ${what}, but at ${formatBytes(a.size)} it is too large to show the model (limit ${formatBytes(media.maxImageBytes)}).`;
    return `I got ${what}, but the current model can't view images (if it can, set model.vision to true in config.json).`;
  }
  if (a.mimeType === 'application/pdf') return `I got ${what}, but I can't read PDFs with the current setup. ${b.note ?? ''}`.trim();
  return `I got ${what}, but I can't read ${a.mimeType} files.`;
}
