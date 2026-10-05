import { randomBytes } from 'node:crypto';

/** Sortable, prefixed IDs: `<prefix>_<time base36><random hex>`. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

export const nowIso = (): string => new Date().toISOString();
