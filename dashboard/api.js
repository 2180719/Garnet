// All network access. Sends the bearer key, normalizes errors, parses the chat SSE stream.
const KEY = 'garnet-key';
const MINTED = 'garnet-key-minted';
let key = null;
try { key = sessionStorage.getItem(KEY); } catch { /* storage blocked: key lives in memory only */ }

export const session = {
  get key() { return key; },
  /** `minted`: the dashboard created this key from a login link, so signing out revokes it. */
  set(k, minted = false) {
    key = k;
    try { sessionStorage.setItem(KEY, k); if (minted) sessionStorage.setItem(MINTED, '1'); else sessionStorage.removeItem(MINTED); } catch { /* ignore */ }
  },
  clear() { key = null; try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(MINTED); } catch { /* ignore */ } },
  get minted() { try { return sessionStorage.getItem(MINTED) === '1'; } catch { return false; } },
  /** The id part of garnet_<id>_<secret>, to recognise "this session's" key in lists. */
  get id() { return key ? key.split('_')[1] : null; },
};

export class ApiError extends Error {
  constructor(status, message, retryAfter) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export const hooks = { unauthorized: () => {} };

async function fail(res, signOutOn401 = true) {
  let msg = `Request failed (${res.status}).`;
  try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
  const retry = Number(res.headers.get('Retry-After')) || 0;
  if (res.status === 401) { if (signOutOn401) hooks.unauthorized(); return new ApiError(401, 'Your API key was rejected. Please sign in again.'); }
  if (res.status === 403) return new ApiError(403, `${msg} Create a key with the needed scope (read, chat or admin) from the API keys page, or run \`garnet dashboard\`.`);
  if (res.status === 429) return new ApiError(429, `Too many requests. Try again in ${retry || 'a few'} seconds.`, retry);
  return new ApiError(res.status, msg);
}

async function send(path, init, k = key) {
  try {
    return await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${k}` } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Cannot reach Garnet. Is it running? The dashboard will retry when you try again.');
  }
}

export async function request(method, path, body) {
  return requestAs(key, method, path, body, true);
}

/** A request with an explicit key (login links). A 401 here does not sign the tab out. */
export async function requestAs(k, method, path, body, signOutOn401 = false) {
  const init = { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await send(path, init, k);
  if (!res.ok) throw await fail(res, signOutOn401);
  return res.json();
}
export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
};
export const enc = encodeURIComponent;

/** Streams an assistant reply. Garnet keeps history server-side, so only the newest message is sent. */
export async function streamChat({ conversation, text, signal, onText }) {
  const res = await send('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Garnet-Conversation': conversation },
    body: JSON.stringify({ model: 'garnet', stream: true, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw await fail(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) onText(delta);
        } catch { /* ignore malformed chunk */ }
      }
    }
  }
}
