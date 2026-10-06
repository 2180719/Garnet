// Login links. No DOM here, so test/dashboard-login.test.ts can run it in Node.
//
// `garnet dashboard` prints a link whose fragment holds a short-lived (15 minute)
// admin key: `#login=garnet_…`. Fragments are never sent to the server or in a
// Referer, but the opened URL can stay in browser history, so the dashboard
// trades that key for a fresh session key on first use and revokes it: the
// link works once. The session key lives only in this tab's sessionStorage.

/** How long a dashboard session key stays valid on the server. */
export const SESSION_DAYS = 1;

const CREDENTIAL = /(?:^#|&)(login|key)=(garnet_[A-Za-z0-9]+_[A-Za-z0-9]+)/;

/**
 * Finds a credential in a URL fragment: `login` (a one-time link from
 * `garnet dashboard`) or `key` (a key you created yourself; used as is).
 */
export function credentialIn(hash) {
  const m = CREDENTIAL.exec(hash || '');
  return m ? { kind: m[1], key: m[2] } : null;
}

/**
 * Trades a one-time login key for a new admin session key, then revokes the
 * login key. `request(key, method, path, body)` resolves with the JSON body or
 * rejects with an error carrying `status`. Returns the session key.
 */
export async function exchangeLoginKey(loginKey, request, now = new Date()) {
  const loginId = loginKey.split('_')[1];
  const created = await request(loginKey, 'POST', '/api/keys', {
    name: `dashboard session ${now.toISOString().slice(0, 10)}`,
    scopes: ['admin'],
    expiresInDays: SESSION_DAYS,
  });
  // Revoke with the new key, so a failure here still leaves a working session; the login key expires soon anyway.
  await request(created.key, 'DELETE', `/api/keys/${encodeURIComponent(loginId)}`).catch(() => {});
  return created.key;
}
