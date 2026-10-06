// Optional live checks for `ruby setup`. Each makes one cheap request that
// costs no tokens, and only runs when the owner agreed to it. Results never
// contain the key or token: it is scrubbed from every message.
import type { RubyConfig } from '../../config/index.ts';

/** `warn`: it works, but something deserves a look (for example the model is not listed). */
export type CheckResult = { ok: boolean; detail: string; warn?: boolean };
export type FetchFn = typeof fetch;

const TIMEOUT_MS = 10_000;

function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit, secret?: string): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON; the status says enough.
    }
    return { status: res.status, body };
  } catch (e) {
    const c = (e as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } }).cause;
    const cause = c?.code ?? c?.errors?.find((x) => x.code)?.code ?? c?.message;
    const name = (e as Error).name;
    const why = name === 'TimeoutError' ? 'timed out' : (cause ?? (e as Error).message);
    return { error: scrub(`could not reach ${new URL(url).host}: ${why}`, secret) };
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Checks a model provider's key (and that the server answers) by listing models. */
export async function checkModel(model: RubyConfig['model'], key: string | undefined, fetchFn: FetchFn = fetch): Promise<CheckResult> {
  if (model.provider === 'fake') return { ok: true, detail: 'the offline model needs no key' };
  if (model.provider === 'anthropic') {
    if (!key) return { ok: false, detail: 'no key to check' };
    const base = trimSlash(model.baseUrl ?? 'https://api.anthropic.com');
    const r = await request(fetchFn, `${base}/v1/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }, key);
    if ('error' in r) return { ok: false, detail: r.error };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: 'Anthropic rejected the key (HTTP ' + r.status + ')' };
    if (r.status !== 200) return { ok: false, detail: `unexpected HTTP ${r.status} from ${new URL(base).host}` };
    const ids = ((r.body as { data?: { id?: string }[] } | null)?.data ?? []).map((m) => m.id);
    const known = ids.includes(model.name);
    if (ids.length && !known) return { ok: true, warn: true, detail: `key accepted, but "${model.name}" was not among the ${ids.length} models listed; check the model ID` };
    return { ok: true, detail: 'key accepted' };
  }
  const base = trimSlash(model.baseUrl ?? '');
  if (!base) return { ok: false, detail: 'no base URL' };
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  // OpenRouter lists models without a key, so ask about the key itself.
  const openrouter = new URL(base).host === 'openrouter.ai';
  const r = await request(fetchFn, openrouter ? `${base}/key` : `${base}/models`, { headers }, key);
  if ('error' in r) return { ok: false, detail: r.error };
  if (r.status === 401 || r.status === 403) return { ok: false, detail: `the server rejected the key (HTTP ${r.status})` };
  if (r.status !== 200) return { ok: false, detail: `unexpected HTTP ${r.status} from ${new URL(base).host}` };
  if (openrouter) return { ok: true, detail: 'OpenRouter accepted the key' };
  const ids = ((r.body as { data?: { id?: string }[] } | null)?.data ?? []).map((m) => m.id).filter(Boolean);
  if (ids.length && !ids.includes(model.name)) return { ok: true, warn: true, detail: `server answered, but "${model.name}" is not among its models (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})` };
  return { ok: true, detail: 'server answered' };
}

/** Telegram `getMe`: returns the bot's @username so the owner knows whom to message. */
export async function checkTelegram(token: string, fetchFn: FetchFn = fetch): Promise<CheckResult & { username?: string }> {
  const r = await request(fetchFn, `https://api.telegram.org/bot${token}/getMe`, {}, token);
  if ('error' in r) return { ok: false, detail: r.error };
  const body = r.body as { ok?: boolean; result?: { username?: string } } | null;
  if (r.status === 401 || r.status === 404) return { ok: false, detail: 'Telegram rejected the token' };
  if (!body?.ok || !body.result?.username) return { ok: false, detail: `unexpected HTTP ${r.status} from Telegram` };
  return { ok: true, detail: `connected to @${body.result.username}`, username: body.result.username };
}

/** Discord `GET /users/@me` with the bot token. */
export async function checkDiscord(token: string, fetchFn: FetchFn = fetch): Promise<CheckResult & { username?: string }> {
  const r = await request(fetchFn, 'https://discord.com/api/v10/users/@me', { headers: { authorization: `Bot ${token}` } }, token);
  if ('error' in r) return { ok: false, detail: r.error };
  if (r.status === 401) return { ok: false, detail: 'Discord rejected the token' };
  const name = (r.body as { username?: string } | null)?.username;
  if (r.status !== 200 || !name) return { ok: false, detail: `unexpected HTTP ${r.status} from Discord` };
  return { ok: true, detail: `connected as ${name}`, username: name };
}

/** signal-cli daemon `GET /api/v1/check` (local, no secret involved). */
export async function checkSignal(baseUrl: string, fetchFn: FetchFn = fetch): Promise<CheckResult> {
  const r = await request(fetchFn, `${trimSlash(baseUrl)}/api/v1/check`, {});
  if ('error' in r) return { ok: false, detail: `${r.error} (is \`signal-cli daemon --http\` running?)` };
  return r.status === 200 ? { ok: true, detail: 'signal-cli daemon answered' } : { ok: false, detail: `unexpected HTTP ${r.status} from signal-cli` };
}
