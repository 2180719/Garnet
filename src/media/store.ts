import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GarnetError, type AttachmentRef } from '../contracts/index.ts';
import { detectMime, kindOf } from './mime.ts';

const ID = /^med_[a-f0-9]{32}$/;

export type MediaInput = {
  data: Uint8Array;
  name?: string | undefined;
  /** Claimed type (from the platform or a client); checked against the bytes. */
  mimeType?: string | undefined;
  durationSec?: number | undefined;
  /** See `InboundAttachment.liveVoice`; already checked by the gateway. */
  liveVoice?: boolean | undefined;
};

/**
 * Attachments on disk under `<home>/media`, content-addressed
 * (`med_<sha256 prefix>`), outside the workspace so tools cannot reach or
 * change them. The event log keeps only `AttachmentRef`s. Files are written
 * once and never modified.
 */
export class MediaStore {
  readonly root: string;
  readonly maxBytes: number;

  constructor(root: string, maxBytes: number) {
    this.root = root;
    this.maxBytes = maxBytes;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** Stores the bytes and returns a reference with a sniffed type. Rejects empty files and files over `maxBytes`. */
  put(input: MediaInput): AttachmentRef {
    const { data } = input;
    if (data.byteLength > this.maxBytes) throw new GarnetError('invalid_input', `The file is too large (${formatMb(data.byteLength)}; the limit is ${formatMb(this.maxBytes)}).`);
    if (data.byteLength === 0) throw new GarnetError('invalid_input', 'The file is empty.');
    const id = `med_${createHash('sha256').update(data).digest('hex').slice(0, 32)}`;
    const file = this.path(id);
    if (existsSync(file)) utimesSync(file, new Date(), new Date()); // in use again: keeps retention from removing it
    else writeFileSync(file, data, { mode: 0o600 });
    const mimeType = detectMime(data, input.mimeType, input.name);
    const name = input.name ? cleanName(input.name) : '';
    return {
      id,
      kind: kindOf(mimeType),
      mimeType,
      size: data.byteLength,
      ...(name ? { name } : {}),
      ...(input.durationSec !== undefined && Number.isFinite(input.durationSec) && input.durationSec >= 0 ? { durationSec: input.durationSec } : {}),
    };
  }

  path(id: string): string {
    if (!ID.test(id)) throw new GarnetError('invalid_input', `Not a media id: "${id}".`);
    return join(this.root, `${id}.bin`);
  }

  has(id: string): boolean {
    return ID.test(id) && existsSync(this.path(id));
  }

  /** The stored bytes, or null when the file is gone (deleted by the owner, or a backup restored without media). */
  read(id: string): Buffer | null {
    if (!this.has(id)) return null;
    return readFileSync(this.path(id));
  }

  /**
   * Deletes stored files last written or re-sent before `before` (epoch ms)
   * whose id is not in `inUse`. Returns how many were removed. Other files in
   * the directory are left alone.
   */
  prune(before: number, inUse: ReadonlySet<string>): number {
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      const id = name.endsWith('.bin') ? name.slice(0, -4) : '';
      if (!ID.test(id) || inUse.has(id)) continue;
      try {
        const file = join(this.root, name);
        if (statSync(file).mtimeMs >= before) continue;
        unlinkSync(file);
        removed++;
      } catch {
        // Gone already, or not removable: try again next time.
      }
    }
    return removed;
  }
}

const formatMb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** A display name only: no directories, no control or bidi characters, bounded length. */
export function cleanName(name: string): string {
  const parts = name.split(/[\\/]/);
  // eslint-disable-next-line no-control-regex
  const base = (parts.at(-1) ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  return base.length > 120 ? base.slice(-120) : base;
}
