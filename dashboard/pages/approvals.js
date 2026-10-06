import { api, enc } from '../api.js';
import { busy, empty, errorBox, fmtDate, h, ago, pageHead, pill, toast } from '../ui.js';

/** The operation, then (when present) the untrusted-content warning the runtime appended, as a banner. */
function summary(text) {
  const at = text.indexOf('\n⚠ ');
  if (at === -1) return [h('p', null, text)];
  return [h('p', null, text.slice(0, at)), h('div', { class: 'banner warn', role: 'note' }, text.slice(at + 1))];
}

function card(a, reload) {
  const result = h('div', { role: 'status' });
  const decide = (verb) => async (e) => {
    const btns = e.currentTarget.parentNode.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    const r = await busy(e.currentTarget, () => api.post(`/api/approvals/${enc(a.code)}/${verb}`));
    if (!r) { btns.forEach((b) => { b.disabled = false; }); return; }
    toast(verb === 'approve' ? 'Approved' : 'Denied', 'ok');
    result.replaceChildren(h('div', { class: `banner ${verb === 'approve' ? 'ok' : ''}` }, h('strong', null, `${verb === 'approve' ? 'Approved' : 'Denied'}. Task status: ${r.status}`), r.text ? h('p', null, r.text) : null));
    setTimeout(reload, 1500);
  };
  return h('article', { class: 'card stack' },
    h('div', { class: 'item' }, h('h3', null, a.tool), h('div', { class: 'badges' }, pill(a.capability, 'accent'), h('code', null, a.code))),
    ...summary(a.summary),
    h('dl', { class: 'kv' }, h('dt', null, 'Requested'), h('dd', null, `${fmtDate(a.createdAt)} (${ago(a.createdAt)})`),
      h('dt', null, 'Expires'), h('dd', null, `${fmtDate(a.expiresAt)} (${ago(a.expiresAt)})`), h('dt', null, 'Session'), h('dd', { class: 'mono small' }, a.sessionId)),
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: decide('approve') }, 'Approve'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: decide('deny') }, 'Deny')),
    result);
}

export default async function mount(root, ctx) {
  const list = h('div', { class: 'list' });
  const load = async () => {
    try {
      const { pending } = await api.get('/api/approvals');
      ctx.setBadge(pending.length);
      list.replaceChildren(...(pending.length ? pending.map((a) => card(a, load)) : [empty('Nothing to approve', 'When Garnet wants to do something that needs your say-so, it shows up here and in your chats.')]));
    } catch (e) { list.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Approvals', 'Actions Garnet paused on until you decide. An approval is a single-use grant for exactly that tool and input.',
    h('button', { class: 'btn btn-ghost', type: 'button', onclick: load }, 'Refresh')), list);
  await load();
  ctx.every(15_000, () => { if (!list.querySelector('button:disabled')) load(); });
}
