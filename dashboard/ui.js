// Tiny DOM toolkit. Everything untrusted goes through textContent / text nodes, never innerHTML.
const SVG = 'http://www.w3.org/2000/svg';

/** h('div', {class:'x', onclick: fn, 'aria-label': 'y'}, 'text', childNode, ...) */
export function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  add(node, kids);
  return node;
}
function add(node, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    node.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
/** Replaces a node's children, skipping null/false (replaceChildren would print "null"). */
export function fill(node, ...kids) {
  node.replaceChildren();
  add(node, kids);
}
export const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

const ICONS = {
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z',
  chat: 'M4 5h16v11H9l-5 4z',
  approvals: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  memory: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  skills: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  schedules: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 2',
  channels: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  keys: 'M14.5 9.5a4 4 0 1 0-3.7 2.7L4 19v2h3v-2h2v-2h2l1.8-1.8a4 4 0 0 0 1.7-5.7zM16 8h.01',
  usage: 'M5 20V10M12 20V4M19 20v-7',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  achievements: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8.5 20h7',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  out: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
};
export function icon(name, cls = '') {
  const s = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls });
  s.append(svg('path', { d: ICONS[name] || ICONS.overview }));
  return s;
}
export function sun() {
  const s = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true', class: 'i-sun' });
  s.append(svg('circle', { cx: 12, cy: 12, r: 4 }), svg('path', { d: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5' }));
  return s;
}
export function moon() {
  const s = icon('moon', 'i-moon');
  return s;
}

const GEM = [
  ['var(--accent)', 1, 'M17 7h30l15 17-30 35L2 24z'], ['#fff', 0.38, 'M17 7h30l-7 17H24z'], ['#fff', 0.16, 'M17 7l7 17H2z'],
  ['#000', 0.12, 'M47 7l15 17H40z'], ['#000', 0.22, 'M2 24h22l8 35z'], ['#000', 0.38, 'M40 24h22L32 59z'], ['#fff', 0.1, 'M24 24h16L32 59z'],
];
/** The Ruby gem, the same faceted mark as the public site. */
export function gem(cls = 'gem-ico') {
  const s = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true', class: cls });
  for (const [fill, op, d] of GEM) s.append(svg('path', { fill, 'fill-opacity': op, d }));
  return s;
}

export function toast(msg, kind = 'info', opts = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: `toast ${kind}` }, h('span', null, msg));
  const close = () => t.remove();
  if (opts.action) t.append(h('button', { type: 'button', onclick: () => { close(); opts.action.run(); } }, opts.action.label));
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(close, opts.ms || (kind === 'error' ? 8000 : 4500));
}

export function confirmDialog({ title, body, confirm = 'Confirm', danger = false, big = false, content }) {
  return new Promise((resolve) => {
    const d = h('dialog', { class: big ? 'big' : '', 'aria-labelledby': 'dlg-title' });
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.append(h('h2', { id: 'dlg-title' }, title), body ? h('p', { class: 'muted' }, body) : null, content || null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => done(true) }, confirm)));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(d);
    d.showModal();
  });
}

export const pill = (text, kind = '') => h('span', { class: `pill ${kind}` }, text);
export const empty = (title, sub) => h('div', { class: 'empty' }, h('strong', null, title), sub || null);
export const loading = (text = 'Loading') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), text);
export function errorBox(e, retry) {
  return h('div', { class: 'banner err', role: 'alert' }, h('pre', null, (e && e.message) || String(e)),
    retry ? h('p', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: retry }, 'Try again')) : null);
}
export function pageHead(title, sub, ...actions) {
  return h('header', { class: 'page-head' }, h('div', null, h('h1', { tabindex: '-1' }, title), sub ? h('p', null, sub) : null), actions.length ? h('div', { class: 'row' }, actions) : null);
}
export function field(label, input, hint, id) {
  const wrap = h('div', { class: 'field' });
  if (id) input.id = id;
  wrap.append(h('label', { for: id }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
  return wrap;
}

/** Disables a button while an async action runs; failures become toasts. */
export async function busy(btn, fn) {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'ok');
  } catch {
    toast('Copy failed. Select the text and copy it manually.', 'error');
  }
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '');
export const num = (n) => (typeof n === 'number' ? n.toLocaleString() : String(n ?? 0));
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return `in ${dur(-s)}`;
  return s < 45 ? 'just now' : `${dur(s)} ago`;
}
export function dur(s) {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export function uptime(iso) {
  let s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const hh = Math.floor(s / 3600); s %= 3600;
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export const link = (href, text, cls = '') => h('a', { href, class: cls }, text);

/** A table from header names and row arrays (cells may be strings or nodes). */
export function table(heads, rows, numCols = []) {
  const t = h('table', null, h('thead', null, h('tr', null, heads.map((x, i) => h('th', { class: numCols.includes(i) ? 'num' : '', scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'num' : '' }, c))))));
  return h('div', { class: 'tablewrap' }, t);
}
