import { nowIso } from '../contracts/index.ts';
import type { Db } from './db.ts';

export type ApiKeyRow = {
  id: string;
  name: string;
  salt: string;
  hash: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

type Row = Record<string, string | null>;

const fromRow = (r: Row): ApiKeyRow => ({
  id: r.id!,
  name: r.name!,
  salt: r.salt!,
  hash: r.hash!,
  scopes: JSON.parse(r.scopes!) as string[],
  createdAt: r.created_at!,
  expiresAt: r.expires_at ?? null,
  revokedAt: r.revoked_at ?? null,
  lastUsedAt: r.last_used_at ?? null,
});

/** Persistence for API key records (hashes only) and the API audit log. Hashing lives in the gateway. */
export class KeyStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  insert(key: Omit<ApiKeyRow, 'lastUsedAt' | 'revokedAt'>): void {
    this.db
      .prepare('INSERT INTO api_keys (id, name, salt, hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key.id, key.name, key.salt, key.hash, JSON.stringify(key.scopes), key.createdAt, key.expiresAt);
  }

  get(id: string): ApiKeyRow | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Row | undefined;
    return r && fromRow(r);
  }

  list(): ApiKeyRow[] {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as Row[]).map(fromRow);
  }

  /** Keys that are neither revoked nor expired. */
  activeCount(now: string = nowIso()): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)')
      .get(now) as { n: number };
    return r.n;
  }

  revoke(id: string): boolean {
    return this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id).changes > 0;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  audit(entry: { keyId: string | null; ip: string | null; method: string; path: string; status: number }): void {
    this.db
      .prepare('INSERT INTO api_audit (at, key_id, ip, method, path, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowIso(), entry.keyId, entry.ip, entry.method, entry.path, entry.status);
  }

  auditLog(limit = 100): { at: string; keyId: string | null; ip: string | null; method: string; path: string; status: number }[] {
    const rows = this.db.prepare('SELECT * FROM api_audit ORDER BY at DESC LIMIT ?').all(limit) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      at: r.at as string,
      keyId: (r.key_id as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      method: r.method as string,
      path: r.path as string,
      status: r.status as number,
    }));
  }
}
