import { GarnetError } from '../contracts/index.ts';
import type { FetchRequest, FetchResponse, WebFetcher } from '../tools/index.ts';

/** Resolves a secret name (environment first, then the encrypted store); see src/secrets. */
export type SecretFn = (name: string) => string | undefined;

/** What every connector needs from the composition root. */
export type ConnectorDeps = {
  /** The SSRF-guarded HTTP client (public addresses only, pinned DNS, capped bodies). */
  fetcher: WebFetcher;
  secret: SecretFn;
  /** The owner's IANA time zone. */
  timeZone: string;
  /** Current time (tests). */
  now?: () => Date;
};

/** A request a connector will make, decided before the policy check so the targets are exactly what runs. */
export type PlannedRequest = { url: string; method: 'GET' | 'POST'; body?: string };

/** Fetches and parses a JSON response. Network failures keep the fetcher's own (host-only) messages. */
export async function fetchJson(fetcher: WebFetcher, url: string, req: FetchRequest): Promise<{ res: FetchResponse; data: unknown }> {
  const res = await fetcher.fetch(url, req);
  if (res.truncated) throw new GarnetError('tool_failed', `The response from ${new URL(url).host} was larger than the fetch limit (web.fetch.maxBytes); ask for fewer results.`);
  const text = res.body.toString('utf8');
  let data: unknown = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.status >= 200 && res.status < 300) throw new GarnetError('tool_failed', `${new URL(url).host} answered with something other than JSON.`);
    }
  }
  return { res, data };
}

/** A short field from an API error body (`{"message": ...}`), clipped; empty when absent. */
export function apiMessage(data: unknown): string {
  const m = data && typeof data === 'object' && 'message' in data ? (data as { message: unknown }).message : undefined;
  if (typeof m !== 'string' || !m.trim()) return '';
  return clip(m.replace(/\s+/g, ' ').trim(), 200);
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Strips control characters (terminal escapes, bidi tricks) from outside text before it reaches the model or the owner. */
export function clean(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();
}
