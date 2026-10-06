/** URL helpers shared by policy (host scopes, taint exemptions) and the runtime (taint derivation). */

/** The canonical form used for exact URL comparison, or null for anything that is not an http(s) URL. */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** http(s) URLs written in free text, normalized. Trailing punctuation and unbalanced closing brackets are dropped. */
export function urlsInText(text: string, limit = 500): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_IN_TEXT)) {
    let u = m[0].replace(/[.,;:!?*_~]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (u.endsWith(close) && count(u, close) > count(u, open)) u = u.slice(0, -1);
    }
    const n = normalizeUrl(u);
    if (n) out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * True when `host` matches an allow-list pattern: an exact host name
 * (`example.com`) or a wildcard for subdomains only (`*.example.com`, which
 * does not match `example.com` itself). Comparison ignores case and a
 * trailing dot.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/\.$/, '');
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

/** The host of an http(s) URL target, or null. */
export function hostOf(target: string): string | null {
  const n = normalizeUrl(target);
  return n ? new URL(n).hostname.replace(/^\[|\]$/g, '') : null;
}
