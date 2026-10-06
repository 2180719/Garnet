import { api, enc } from '../api.js';
import { ago, busy, confirmDialog, empty, errorBox, fill, fmtDate, h, link, num, pageHead, pager, pill, table, toast } from '../ui.js';

const LIMIT = 25;

/** Conversation keys are channel:account:chatId for chats; the others are routes, jobs, API or dashboard. */
const kind = (key) => ({ route: 'shared route', job: 'scheduled job', api: 'API', dashboard: 'dashboard' })[key.split(':')[0]] || 'chat';

export default async function mount(root) {
  const out = h('div', { class: 'stack' });
  let offset = 0;
  const load = async (to = offset) => {
    try {
      const d = await api.get(`/api/routing?limit=${LIMIT}&offset=${to}`);
      offset = to;
      const unlink = (c) => h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'aria-label': `Unlink ${c.key}`, onclick: async (ev) => {
        const btn = ev.currentTarget;
        if (!(await confirmDialog({ title: 'Unlink this conversation?', body: `The next message to ${c.key} starts a fresh session. The old session and its log are kept.`, confirm: 'Unlink', danger: true }))) return;
        await busy(btn, async () => { await api.del(`/api/conversations/${enc(c.key)}`); toast('Unlinked', 'ok'); await load(); });
      } }, 'Unlink');
      fill(out,
        h('section', { class: 'stack', 'aria-labelledby': 'h-routes' }, h('h2', { id: 'h-routes' }, 'Routes'),
          h('p', { class: 'muted' }, 'Routes send several chats into one shared conversation. They are set in the "routes" section of ', link('#/settings', 'Settings'), '. Without a route every chat is its own conversation.'),
          d.routes.length ? table(['Channel', 'Chat', 'Conversation'], d.routes.map((r) => [r.match.channel, r.match.chatId || 'every chat', h('code', null, `route:${r.conversation}`)]))
            : empty('No routes', 'Each chat has its own conversation.')),
        h('section', { class: 'stack', 'aria-labelledby': 'h-conv' }, h('h2', { id: 'h-conv' }, 'Linked conversations'),
          h('p', { class: 'muted' }, 'Which session each chat, route, job or API conversation continues. /new in a chat rebinds it to a fresh session.'),
          d.conversations.items.length ? h('div', { class: 'list' }, d.conversations.items.map((c) => h('div', { class: 'card item' },
            h('div', { class: 'meta' }, h('span', { class: 'title' }, c.key), h('span', { class: 'small muted' }, `Active ${ago(c.updatedAt)} · ${num(c.events)} events · `, link(`#/sessions/${enc(c.sessionId)}`, 'open session log'))),
            h('div', { class: 'row' }, pill(kind(c.key), 'accent'), unlink(c)))))
            : empty('No linked conversations', 'They appear after the first message.'),
          d.conversations.total > LIMIT ? pager({ offset, limit: LIMIT, total: d.conversations.total, go: load }) : null),
        h('section', { class: 'stack', 'aria-labelledby': 'h-pend' }, h('h2', { id: 'h-pend' }, 'Pending pairing requests'),
          d.pending.length ? h('div', { class: 'list' }, d.pending.map((x) => h('div', { class: 'card item' },
            h('div', { class: 'meta' }, h('span', { class: 'title' }, `${x.senderName || x.senderId} on ${x.channel}`), h('span', { class: 'small muted' }, `Requested ${fmtDate(x.createdAt)} · expires ${fmtDate(x.expiresAt)}`)),
            h('div', { class: 'row' }, h('code', null, x.code),
              h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await api.post(`/api/pairing/${enc(x.code)}/approve`); toast('Paired', 'ok'); await load(); }) }, 'Approve'),
              h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: (ev) => busy(ev.currentTarget, async () => { await api.del(`/api/pairing/${enc(x.code)}`); toast('Request denied', 'ok'); await load(); }) }, 'Deny')))))
            : empty('No pending requests', 'Unknown senders get a code when they message Garnet.')),
        h('section', { class: 'stack', 'aria-labelledby': 'h-id' }, h('h2', { id: 'h-id' }, 'Paired identities'),
          d.identities.length ? h('div', { class: 'list' }, d.identities.map((i) => h('div', { class: 'card item' },
            h('div', { class: 'meta' }, h('span', { class: 'title' }, i.displayName || i.senderId), h('span', { class: 'small muted' }, `${i.channel} · ${i.senderId} · paired ${fmtDate(i.createdAt)}`)),
            h('div', { class: 'row' }, pill(i.role, 'accent'), h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async (ev) => {
              const btn = ev.currentTarget;
              if (!(await confirmDialog({ title: 'Revoke this identity?', body: `${i.displayName || i.senderId} on ${i.channel} will no longer be able to talk to Garnet.`, confirm: 'Revoke', danger: true }))) return;
              await busy(btn, async () => { await api.del(`/api/identities/${enc(i.channel)}/${enc(i.senderId)}`); toast('Revoked', 'ok'); await load(); });
            } }, 'Revoke')))))
            : empty('Nobody is paired yet', 'Message your Garnet bot to start pairing.')));
    } catch (e) { out.replaceChildren(errorBox(e, () => load())); }
  };
  root.append(pageHead('Routing', 'How chats map to conversations, and who may talk to Garnet.'), out);
  await load(0);
}
