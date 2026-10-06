import { textOf, type SessionEvent, type SessionTaint } from '../contracts/index.ts';
import { normalizeUrl, urlsInText } from '../policy/index.ts';

/**
 * Derives a session's taint from its event log: the sources recorded by
 * `tainted` events, the URLs the owner wrote, and the URLs untrusted tools
 * reported finding.
 *
 * Taint is never cleared within a session. Compaction does not clear it
 * either: a summary written from untrusted text can carry its instructions.
 * A fresh session (`/new`) starts clean.
 */
/**
 * User-message sources whose text the owner did not write: a note recording a
 * message Ruby sent on its own (`notification`) and the continuation after an
 * approval (`approval`, which embeds a model-composed summary). URLs in them
 * are never the owner's.
 */
const NOT_OWNER_SOURCES = new Set(['notification', 'approval']);

export function sessionTaint(events: readonly SessionEvent[]): SessionTaint {
  const sources: string[] = [];
  const ownerUrls = new Set<string>();
  const seenUrls = new Set<string>();
  // A user message followed by an inherited taint was written by a tainted
  // parent (or carries an untrusted payload), not by the owner.
  const notOwner = new Set<number>();
  for (let i = 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'tainted' && e.inherited && events[i - 1]!.type === 'user_message') notOwner.add(events[i - 1]!.seq);
  }
  for (const e of events) {
    if (e.type === 'tainted') {
      if (!sources.includes(e.source)) sources.push(e.source);
    } else if (e.type === 'user_message' && !notOwner.has(e.seq) && !NOT_OWNER_SOURCES.has(e.source)) {
      for (const u of urlsInText(textOf(e.message))) ownerUrls.add(u);
    } else if (e.type === 'tool_finished' && e.result.untrusted?.links) {
      for (const link of e.result.untrusted.links) {
        const u = normalizeUrl(link);
        if (u) seenUrls.add(u);
      }
    }
  }
  return { sources, ownerUrls, seenUrls };
}

/** An untainted session's taint, for callers that have no events. */
export const CLEAN: SessionTaint = { sources: [], ownerUrls: new Set(), seenUrls: new Set() };
