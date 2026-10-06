import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { GarnetError } from '../contracts/index.ts';
import type { ApiKeyRow, KeyStore } from '../store/index.ts';

export const SCOPES = ['chat', 'read', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** `ruby_` is the prefix keys had before the rename to Garnet; they keep working. */
const KEY_SHAPE = /^(?:garnet|ruby)_([A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/;

function base62(length: number): string {
  // Rejection sampling keeps the distribution uniform.
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/**
 * Keys are 190-bit random secrets, so a salted HMAC-SHA256 is sufficient; a
 * slow password hash would add latency to every request without adding
 * security. Only the hash is stored.
 */
function digest(salt: string, secret: string): string {
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(secret).digest('hex');
}

export type CreatedKey = { id: string; key: string; name: string; scopes: Scope[]; expiresAt: string | null };

export class ApiKeys {
  private readonly store: KeyStore;

  constructor(store: KeyStore) {
    this.store = store;
  }

  /** Creates a key. The full key is returned once and never stored. */
  create(name: string, scopes: Scope[], expiresInDays?: number): CreatedKey {
    if (!name.trim() || name.length > 64) throw new GarnetError('invalid_input', 'Key name must be 1-64 characters.');
    const unknown = scopes.filter((s) => !SCOPES.includes(s));
    if (scopes.length === 0 || unknown.length) throw new GarnetError('invalid_input', `Scopes must be some of: ${SCOPES.join(', ')}.`);
    if (expiresInDays !== undefined && !(Number.isFinite(expiresInDays) && expiresInDays > 0 && expiresInDays <= 3650)) {
      throw new GarnetError('invalid_input', 'Expiry must be a number of days from 1 to 3650 (omit it for a key that does not expire).');
    }
    const id = base62(8);
    const secret = base62(32);
    const salt = randomBytes(16).toString('hex');
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    const unique = [...new Set(scopes)];
    this.store.insert({ id, name: name.trim(), salt, hash: digest(salt, secret), scopes: unique, createdAt: new Date().toISOString(), expiresAt });
    return { id, key: `garnet_${id}_${secret}`, name: name.trim(), scopes: unique, expiresAt };
  }

  /** Returns the key record when `presented` is a valid, active key. Constant-time comparison. */
  verify(presented: string, now: Date = new Date()): ApiKeyRow | null {
    const m = KEY_SHAPE.exec(presented);
    if (!m) return null;
    const row = this.store.get(m[1]!);
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now.toISOString())) return null;
    const expected = Buffer.from(row.hash, 'hex');
    const actual = Buffer.from(digest(row.salt, m[2]!), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    this.store.touch(row.id);
    return row;
  }

  list(): Omit<ApiKeyRow, 'salt' | 'hash'>[] {
    return this.store.list().map(({ salt: _s, hash: _h, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    return this.store.revoke(id);
  }

  activeCount(): number {
    return this.store.activeCount();
  }
}

/** Token bucket per key: `limit` requests per `windowMs`, refilled continuously. In memory: limits reset on restart, which is acceptable for abuse control. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Returns 0 when allowed, otherwise milliseconds until the next token. */
  take(key: string, now = Date.now()): number {
    const rate = this.limit / this.windowMs;
    const b = this.buckets.get(key) ?? { tokens: this.limit, at: now };
    b.tokens = Math.min(this.limit, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.prune(now);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate);
  }

  /** Drops full buckets so memory stays bounded under many distinct keys (e.g. visitor IPs). */
  private prune(now: number): void {
    for (const [k, b] of this.buckets) if (b.tokens + (now - b.at) * (this.limit / this.windowMs) >= this.limit) this.buckets.delete(k);
  }
}
