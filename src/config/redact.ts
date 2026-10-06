const SECRET_KEY = /(key|token|secret|password|authorization|cookie)/i;
// Common credential shapes: provider keys, bearer tokens, Telegram bot tokens.
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{16,}|ruby_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}|\d{6,}:[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/g;

/** Deep-copies a value with secret-looking fields and strings replaced. Use for logs and diagnostics. */
export function redact<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    // `apiKeyEnv` names an environment variable; it is not itself a secret.
    if (key && SECRET_KEY.test(key) && !key.endsWith('Env')) return '[redacted]';
    return value.replace(SECRET_VALUE, '[redacted]');
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}
