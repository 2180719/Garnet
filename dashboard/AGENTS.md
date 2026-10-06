# dashboard

The opt-in web dashboard. Static files served by the gateway (`src/gateway/static.ts`) at `/` when `dashboard.enabled = true`. No build step, no framework, no dependencies, no external requests. Keep the whole directory well under 100 KB.

## Hard rules

- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:`. No inline `<script>`, no `style="..."` in markup, no `eval`/`new Function`, no CDN, font or analytics. Set dynamic sizes with `el.style.x = ...` or `el.style.setProperty(...)` from JS (allowed); style everything else in `styles.css`.
- **Untrusted data** (memory, skills, chat, job output, names, errors) is rendered with `h()` / `textContent` only. Never `innerHTML`. `node.replaceChildren(null)` prints "null": use `fill()` from `ui.js` when children may be null.
- **Auth:** `ruby dashboard` prints a one-time link, `#login=<key>`, holding an admin key that expires in 15 minutes. On load the dashboard removes the fragment from the address bar first, trades that key for a session key (admin, 1 day; `login.js`) and revokes it, so the link works once and a copy left in browser history is useless. `#key=<key>` (a key you made yourself) is used as is. The key lives only in this tab's `sessionStorage` (`api.js` `session`), never in `localStorage`, a cookie or a URL the server sees. Every request goes through `api.js`, which sends `Authorization: Bearer` (no cookies, so no CSRF surface). Sign out revokes a session key the dashboard minted. 401 signs out, 403/429/network errors become readable `ApiError`s.
- **Storage** (`localStorage`/`sessionStorage`) is always wrapped in try/catch; the UI must work without it.
- Accessible by default: landmarks, labels on every control, visible focus, `aria-live` toasts, `prefers-reduced-motion` respected (CSS and `achv.js`).

## Layout

| File | Role |
| --- | --- |
| `index.html` | Shell: skip link, `#root`, `#toasts` live region, loads `theme.js` and `app.js`. |
| `theme.js` | Classic script: applies the saved theme before first paint. |
| `app.js` | Auth (login screen, `#login=`/`#key=` capture), shell, hash router, theme toggle, gem-click and Konami wiring. |
| `api.js` | `api.get/post/put/del`, `requestAs` (an explicit key), `streamChat` (SSE), `session`, `ApiError`, `hooks.unauthorized`. |
| `login.js` | One-time login links: `credentialIn`, `exchangeLoginKey`. No DOM; tested from Node in `test/dashboard-login.test.ts`. |
| `ui.js` | `h()` element builder, `fill`, icons, the gem, toasts, `confirmDialog`, `busy`, formatters, `table`, `pill`, `field`. |
| `diff.js` | `lineDiff` (LCS) for skill proposals and `pathDiff` for config review. |
| `achv.js` | Achievement toasts (diffed against `sessionStorage`), sparkle, easter eggs, daily quote. |
| `styles.css` | All styling. Tokens mirror `site/styles.css` (ruby palette, serif/sans/mono stacks, light/dark). |
| `pages/*.js` | One module per route; see below. |

## Adding a page

1. Create `pages/<id>.js` with `export default async function mount(root, ctx)`. Append nodes to `root`; throw to show an error box.
   - `ctx.arg`: text after the page id in the hash (`#/skills/foo` gives `foo`).
   - `ctx.every(ms, fn)`: poll while the tab is visible; cleaned up on navigation.
   - `ctx.cleanup(fn)`: register your own teardown. `ctx.setBadge(n)`: update the approvals count.
2. Add `[id, 'Label']` to `NAV` in `app.js` and an icon path to `ICONS` in `ui.js` (key = id).
3. Use `api` for calls, `busy(button, fn)` for actions (it disables the button and toasts failures), `confirmDialog` before destructive actions, `errorBox(e, retry)` for load failures. Capture `e.currentTarget` in a variable before the first `await`.
4. Reuse existing CSS classes (`card`, `grid`, `stack`, `item`, `pill`, `banner`, `tablewrap`, `btn btn-*`) before adding new ones.

## Pages and API routes

overview (`/api/overview`, `/api/achievements`), chat (`POST /v1/chat/completions`, `stream:true`, `X-Ruby-Conversation`), approvals, memory, skills, schedules (`/api/jobs`), channels (`/api/pairing`, identities), sessions (`/api/log/sessions`, read-only event log paged with `after`/`limit`; thinking and the frozen prompt are never sent, secrets are redacted server-side; sessions that read untrusted content carry `tainted` and show a pill, `tainted` events render as their own entry), approvals show the runtime's untrusted-content warning as a banner, logs (`/api/log/audit`, `/api/log/failures`, offset paging), routing (`/api/routing`, `DELETE /api/conversations/:key`, `DELETE /api/pairing/:code`), keys, usage, settings (`GET/PUT /api/config`, form generated from the JSON Schema; arrays and free-form objects fall back to a validated JSON textarea), achievements. Routes and scopes are defined in `src/gateway/admin.ts`.

## Verifying

Run a real server with the fake model (`model.provider = "fake"`, `api.enabled`, `dashboard.enabled`), open the link from `ruby dashboard` in Chromium via Playwright, visit every page at 1280x800 and 375x812 in light and dark, and assert there are no `console`/`pageerror` events (CSP violations are console errors) and no horizontal overflow.
- Session events render attachment blocks (kind, name, type, size) with any transcript or extracted text in a `<details>`; the bytes are never sent to the dashboard.
