// Content-type detection. The sender's claimed type is a hint; the bytes decide.
import { extname } from 'node:path';
import type { AttachmentKind } from '../contracts/index.ts';

const startsWith = (d: Uint8Array, bytes: number[], offset = 0) => d.length >= offset + bytes.length && bytes.every((b, i) => d[offset + i] === b);
const ascii = (d: Uint8Array, offset: number, len: number) => (d.length >= offset + len ? String.fromCharCode(...d.subarray(offset, offset + len)) : '');

/** The MIME type the bytes prove, or null when the signature is unknown. */
export function sniffMime(d: Uint8Array): string | null {
  if (startsWith(d, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(d, 0, 6) === 'GIF87a' || ascii(d, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(d, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(d, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(d, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(d, 0, 3) === 'ID3') return 'audio/mpeg';
  if (startsWith(d, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(d, 4, 4) === 'ftyp') {
    const brand = ascii(d, 8, 4);
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(d, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  return null;
}

const BY_EXTENSION: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.log': 'text/plain',
  '.ics': 'text/calendar',
  '.vcf': 'text/vcard',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeFromName(name: string | undefined): string | null {
  return name ? (BY_EXTENSION[extname(name).toLowerCase()] ?? null) : null;
}

/** File extension for a MIME type (for temporary files handed to commands and providers). */
export function extensionFor(mime: string): string {
  const hit = Object.entries(BY_EXTENSION).find(([, m]) => m === mime);
  return hit ? hit[0] : '.bin';
}

/** Types whose bytes are text a model can read directly. */
export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || ['application/json', 'application/jsonl', 'application/yaml', 'application/xml', 'application/x-ndjson'].includes(mime);
}

/** True when the bytes decode as UTF-8 and hold no NUL or other binary control characters. */
export function looksLikeText(d: Uint8Array): boolean {
  const sample = d.subarray(0, 64 * 1024);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < d.length ? trimPartial(sample) : sample);
  } catch {
    return false;
  }
  for (const b of sample) if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b)) return false;
  return true;
}

/** Drops a UTF-8 sequence cut off at the end of a sample. */
function trimPartial(d: Uint8Array): Uint8Array {
  for (let i = 1; i <= 3 && d.length - i >= 0; i++) {
    const b = d[d.length - i]!;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    return b >= 0xc0 ? d.subarray(0, d.length - i) : d; // a lead byte starts a possibly incomplete sequence
  }
  return d;
}

/**
 * Decides a file's type: a recognized signature wins over any claim (so a
 * renamed executable is never treated as an image), then the claimed type or
 * the file name, then a text check. Falls back to application/octet-stream.
 */
export function detectMime(data: Uint8Array, claimed?: string, name?: string): string {
  const hint = normalize(claimed) ?? mimeFromName(name);
  const sniffed = sniffMime(data);
  if (sniffed) {
    // Containers that several types share: keep a compatible, more specific claim.
    if (sniffed === 'application/zip' && hint?.startsWith('application/vnd.openxmlformats')) return hint;
    if (sniffed === 'video/mp4' && (hint === 'audio/mp4' || hint === 'audio/x-m4a')) return 'audio/mp4';
    if (sniffed === 'video/webm' && hint === 'audio/webm') return hint;
    return sniffed;
  }
  // A claimed type that has a signature, without the signature, is false.
  if (hint && (hint.startsWith('image/') || hint === 'application/pdf')) return looksLikeText(data) ? 'text/plain' : 'application/octet-stream';
  if (hint && isTextMime(hint)) return looksLikeText(data) ? hint : 'application/octet-stream';
  // Many MP3s start with a bare frame header rather than an ID3 tag; trust the claim only for audio.
  if (hint === 'audio/mpeg' && data.length > 1 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0) return hint;
  if (looksLikeText(data)) return 'text/plain';
  if (hint && (hint.startsWith('audio/') || hint.startsWith('video/'))) return hint;
  return 'application/octet-stream';
}

function normalize(mime: string | undefined): string | null {
  if (!mime) return null;
  const m = mime.split(';')[0]!.trim().toLowerCase();
  if (m === 'audio/x-m4a') return 'audio/mp4';
  if (m === 'audio/mp3') return 'audio/mpeg';
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(m) && m !== 'application/octet-stream' ? m : null;
}

export function kindOf(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || isTextMime(mime) || mime.startsWith('application/vnd.openxmlformats')) return 'document';
  return 'file';
}
