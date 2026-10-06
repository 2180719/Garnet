/**
 * Config paths that the HTTP/dashboard admin API must not change.
 *
 * An `admin` API key is a bearer token that may live in a dashboard link, so a
 * leak must not become host compromise. These fields decide where secrets are
 * read from and sent, what runs on the host, and who can reach Ruby, so editing
 * them stays with someone who has shell access (editing config.json).
 * A `*` matches one path segment; a leading `*` in a segment (`*Env`) matches
 * any key ending in that suffix.
 */
export const PROTECTED_CONFIG_PATHS: readonly string[] = [
  'permissions.*',
  'sandbox.*',
  'model.provider',
  'model.apiKeyEnv',
  'model.baseUrl',
  'api.host',
  'api.port',
  'api.trustProxy',
  'api.demo.allowedOrigins',
  'channels.*.tokenEnv',
  'channels.signal.baseUrl',
  'workspace',
  '*Env', // any environment-variable / stored-secret name, at any depth
];

function segmentMatches(pattern: string, key: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*')) return key.endsWith(pattern.slice(1));
  return pattern === key;
}

/** True when `path` (dot-separated) is protected. Longer paths under a protected prefix are protected too. */
export function isProtectedConfigPath(path: string): boolean {
  const keys = path.split('.');
  return PROTECTED_CONFIG_PATHS.some((p) => {
    const pat = p.split('.');
    if (pat.length === 1 && pat[0]!.startsWith('*') && pat[0] !== '*') return keys.some((k) => segmentMatches(pat[0]!, k));
    return pat.length <= keys.length && pat.every((s, i) => segmentMatches(s, keys[i]!));
  });
}

function leaves(v: unknown, prefix: string, out: Map<string, string>): void {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
    for (const [k, x] of Object.entries(v)) leaves(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, JSON.stringify(v) ?? 'undefined');
}

/** Protected paths whose value differs between two parsed configs. */
export function changedProtectedPaths(before: unknown, after: unknown): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  leaves(before, '', a);
  leaves(after, '', b);
  const changed = new Set<string>();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(k) !== b.get(k) && isProtectedConfigPath(k)) changed.add(k);
  }
  return [...changed].sort();
}
