import { api, enc } from '../api.js';
import { ago, busy, confirmDialog, empty, errorBox, fmtDate, h, pageHead, pill, toast } from '../ui.js';

export default async function mount(root) {
  const out = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const [p, o] = await Promise.all([api.get('/api/pairing'), api.get('/api/overview')]);
      out.replaceChildren(
        h('section', { class: 'stack', 'aria-labelledby': 'h-health' }, h('h2', { id: 'h-health' }, 'Channels'),
          o.health.channels.length ? h('div', { class: 'grid' }, o.health.channels.map((c) => h('div', { class: 'card pad-sm' }, h('div', { class: 'item' }, h('strong', null, `${c.channel} · ${c.account}`),
            pill(c.ok ? 'ok' : c.lastError ? 'error' : 'stale', c.ok ? 'ok' : c.lastError ? 'err' : 'warn')),
          h('p', { class: 'muted small' }, c.lastError || (c.lastSuccessAt ? `Last success ${ago(c.lastSuccessAt)}` : 'No activity yet')))))
            : h('p', { class: 'muted' }, 'No channels are running.')),
        h('section', { class: 'stack', 'aria-labelledby': 'h-pend' }, h('h2', { id: 'h-pend' }, 'Pending pairing requests'),
          h('p', { class: 'muted' }, 'Someone messaged Garnet from a chat it does not know. Approve only people you recognise; they get full owner access.'),
          p.pending.length ? h('div', { class: 'list' }, p.pending.map((x) => h('div', { class: 'card item' }, h('div', { class: 'meta' },
            h('span', { class: 'title' }, `${x.senderName || x.senderId} on ${x.channel}`), h('span', { class: 'small muted' }, `Sender ${x.senderId} · requested ${fmtDate(x.createdAt)} · expires ${fmtDate(x.expiresAt)}`)),
          h('div', { class: 'row' }, h('code', null, x.code), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
            await api.post(`/api/pairing/${enc(x.code)}/approve`); toast('Paired', 'ok'); await load();
          }) }, 'Approve')))))
            : empty('No pending requests', 'When an unknown chat messages Garnet, its pairing code appears here.')),
        h('section', { class: 'stack', 'aria-labelledby': 'h-id' }, h('h2', { id: 'h-id' }, 'Paired identities'),
          p.identities.length ? h('div', { class: 'list' }, p.identities.map((i) => h('div', { class: 'card item' }, h('div', { class: 'meta' },
            h('span', { class: 'title' }, i.displayName || i.senderId), h('span', { class: 'small muted' }, `${i.channel} · ${i.senderId} · paired ${fmtDate(i.createdAt)}`)),
          h('div', { class: 'row' }, pill(i.role, 'accent'), h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async (ev) => {
          const btn = ev.currentTarget;
            if (!(await confirmDialog({ title: 'Revoke this identity?', body: `${i.displayName || i.senderId} on ${i.channel} will no longer be able to talk to Garnet.`, confirm: 'Revoke', danger: true }))) return;
            await busy(btn, async () => { await api.del(`/api/identities/${enc(i.channel)}/${enc(i.senderId)}`); toast('Revoked', 'ok'); await load(); });
          } }, 'Revoke')))))
            : empty('Nobody is paired yet', 'Message your Garnet bot to start pairing.')));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Channels & pairing', 'Who can reach Garnet, and through which chats.'), out);
  await load();
}
