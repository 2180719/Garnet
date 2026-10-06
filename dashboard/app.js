// Entry point: auth, shell, hash router, theme, easter eggs.
import { api, hooks, session } from './api.js';
import { dailyQuote, easterEgg, watchKonami } from './achv.js';
import { gem, h, icon, loading, moon, errorBox, sun } from './ui.js';

const NAV = [
  ['overview', 'Overview'], ['chat', 'Chat'], ['approvals', 'Approvals'], ['memory', 'Memory'], ['skills', 'Skills'],
  ['sessions', 'Sessions'], ['schedules', 'Schedules'], ['channels', 'Channels'], ['routing', 'Routing'], ['logs', 'Logs'], ['keys', 'API keys'], ['usage', 'Usage'],
  ['settings', 'Settings'], ['achievements', 'Achievements'],
];
const root = document.getElementById('root');
let shell = null;
let cleanups = [];
let notice = '';

// ---- auth ----
function takeKeyFromHash() {
  const m = /(?:^#|&)key=(ruby_[A-Za-z0-9_]+)/.exec(location.hash);
  if (!m) return;
  session.set(m[1]);
  history.replaceState(null, '', `${location.pathname}${location.search}#/overview`);
}

function signOut(message = '') {
  session.clear();
  notice = message;
  runCleanups();
  nav++;
  shell = null;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  showLogin();
}
hooks.unauthorized = () => { if (shell) signOut('Your API key was rejected or has expired. Sign in with a fresh key.'); };

function showLogin() {
  document.title = 'Sign in · Ruby';
  const input = h('input', { id: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'ruby_…', required: true, 'aria-describedby': 'key-help' });
  const msg = h('div', { role: 'alert' }, notice ? h('p', { class: 'banner err' }, notice) : null);
  notice = '';
  const go = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { for: 'key' }, 'API key'), input,
      h('span', { class: 'hint', id: 'key-help' }, 'On the machine running Ruby, run ', h('code', null, 'ruby dashboard'), ' and open the link it prints. Or paste a key here.')),
    go, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = input.value.trim();
    msg.replaceChildren();
    if (!/^ruby_[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(k)) { msg.append(h('p', { class: 'banner err' }, 'That does not look like a Ruby key (ruby_<id>_<secret>).')); return; }
    go.disabled = true;
    session.set(k);
    try {
      await api.get('/api/overview');
      location.hash = '#/overview';
      showShell();
    } catch (err) {
      session.clear();
      msg.append(h('p', { class: 'banner err' }, err.status === 403 ? 'This key needs at least the "read" scope.' : err.message));
    } finally { go.disabled = false; }
  });
  root.replaceChildren(h('main', { class: 'login', id: 'main' }, h('div', { class: 'card' },
    gem(), h('div', null, h('h1', null, 'Ruby'), h('p', { class: 'muted' }, 'Sign in to your dashboard. Keys stay in this tab and are never sent anywhere but your Ruby.')), form)));
  input.focus();
}

// ---- shell ----
function runCleanups() { for (const f of cleanups.splice(0)) try { f(); } catch { /* ignore */ } }

function toggleTheme() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ruby-theme', next); } catch { /* ignore */ }
}

function showShell() {
  let clicks = 0, last = 0;
  const onGem = () => {
    const now = Date.now();
    clicks = now - last < 1500 ? clicks + 1 : 1;
    last = now;
    if (clicks >= 7) { clicks = 0; easterEgg('gem-polisher', 'Gem Polisher'); }
  };
  const gemBtn = () => h('button', { class: 'gem-btn', type: 'button', 'aria-label': 'Ruby gem', onclick: onGem }, gem());
  const themeBtn = () => h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Toggle light or dark theme', onclick: toggleTheme }, moon(), sun());
  const menu = h('button', { class: 'icon-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'side', 'aria-label': 'Menu' }, icon('menu'));
  const nav = h('nav', { class: 'nav', 'aria-label': 'Dashboard' }, NAV.map(([id, label]) =>
    h('a', { href: `#/${id}`, 'data-page': id }, icon(id), h('span', null, label), id === 'approvals' ? h('span', { class: 'count', id: 'badge', hidden: true }) : null)));
  const side = h('aside', { class: 'side', id: 'side', 'aria-label': 'Sidebar' },
    h('div', { class: 'brand' }, gemBtn(), h('a', { href: '#/overview' }, 'Ruby')), nav,
    h('div', { class: 'side-foot' }, h('p', { class: 'quote' }, `“${dailyQuote()}”`),
      h('div', { class: 'who' }, themeBtn(), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => signOut('You have been signed out.') }, icon('out'), 'Sign out'))));
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const top = h('header', { class: 'top' }, h('div', { class: 'brand' }, h('a', { href: '#/overview' }, 'Ruby'), gemBtn()), h('div', { class: 'tools' }, themeBtn(), menu));
  menu.addEventListener('click', () => {
    const open = side.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });
  shell = { main, nav, side, menu };
  root.replaceChildren(h('div', { class: 'app' }, top, side, main));
  hashChange();
  const poll = () => { if (document.visibilityState === 'visible') api.get('/api/approvals').then((d) => setBadge(d.pending.length), () => {}); };
  const timer = setInterval(poll, 30_000);
  cleanups.push(() => clearInterval(timer));
  poll();
}

function setBadge(n) {
  const b = document.getElementById('badge');
  if (!b) return;
  b.hidden = !n;
  b.textContent = String(n);
}

// ---- router ----
let nav = 0;
async function hashChange() {
  if (!shell) return;
  const [, page = 'overview', ...rest] = location.hash.split('/');
  const id = NAV.some(([n]) => n === page) ? page : 'overview';
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';
  const mine = ++nav;
  runCleanups();
  shell.side.classList.remove('open');
  shell.menu.setAttribute('aria-expanded', 'false');
  for (const a of shell.nav.children) {
    if (a.dataset.page === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const label = NAV.find(([n]) => n === id)[1];
  document.title = `${label} · Ruby`;
  const page$ = h('div', { class: 'page' }, loading());
  shell.main.replaceChildren(page$);
  const ctx = {
    arg,
    setBadge,
    cleanup: (f) => cleanups.push(f),
    every(ms, fn) {
      const t = setInterval(() => { if (document.visibilityState === 'visible') fn(); }, ms);
      const vis = () => { if (document.visibilityState === 'visible') fn(); };
      document.addEventListener('visibilitychange', vis);
      cleanups.push(() => { clearInterval(t); document.removeEventListener('visibilitychange', vis); });
    },
  };
  try {
    const mod = await import(`./pages/${id}.js`);
    const view = h('div', { class: 'page' });
    await mod.default(view, ctx);
    if (mine !== nav || !shell) return;
    shell.main.replaceChildren(view);
    (view.querySelector('h1') || shell.main).focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    if (mine === nav && shell) shell.main.replaceChildren(h('div', { class: 'page' }, errorBox(e, hashChange)));
  }
}
addEventListener('hashchange', () => {
  if (/(?:^#|&)key=ruby_/.test(location.hash)) { // a login link opened in a tab that is already showing the dashboard
    takeKeyFromHash();
    if (shell) signOut();
    showShell();
    return;
  }
  hashChange();
});

document.querySelector('.skip').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('main')?.focus(); });
takeKeyFromHash();
watchKonami();
if (session.key) showShell();
else showLogin();
