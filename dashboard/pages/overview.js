import { api } from '../api.js';
import { fetchAchievements } from '../achv.js';
import { ago, errorBox, fmtDate, h, link, num, pageHead, pill, uptime } from '../ui.js';

const stat = (label, value, sub) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);

function channelState(c) {
  if (c.ok) return ['ok', 'OK'];
  return c.lastError ? ['err', 'Error'] : ['warn', 'Stale'];
}

function render(o) {
  const out = o.health.outbox;
  const issues = (out.failed || 0) + (out.uncertain || 0);
  const c = o.counts;
  const cards = h('div', { class: 'grid' },
    stat('Version', o.version, `API ${o.api.host}:${o.api.port}`),
    stat('Model', o.model),
    stat('Uptime', uptime(o.startedAt), `since ${fmtDate(o.startedAt)}`),
    h('a', { class: 'card stat', href: '#/approvals' }, h('div', { class: 'label' }, 'Pending approvals'),
      h('div', { class: 'value' }, num(o.pendingApprovals)), h('div', { class: 'sub' }, o.pendingApprovals ? 'Waiting for you. Review them' : 'Nothing waiting')),
    stat('Tasks', `${num(c.tasksCompleted)} done`, `${num(c.tasksTotal)} total · ${num(c.toolCalls)} tool calls · ${num(c.sessions)} sessions`),
    stat('Outbox', issues ? `${issues} issue${issues === 1 ? '' : 's'}` : 'Healthy',
      `${out.pending || 0} pending · ${out.failed || 0} failed · ${out.uncertain || 0} uncertain`),
    h('a', { class: 'card stat', href: '#/schedules' }, h('div', { class: 'label' }, 'Scheduler'),
      h('div', { class: 'value' }, o.scheduler.enabled ? 'On' : 'Off'), h('div', { class: 'sub' }, `${o.scheduler.jobs} job${o.scheduler.jobs === 1 ? '' : 's'} configured`)));
  const channels = o.health.channels.length
    ? h('div', { class: 'grid wide' }, o.health.channels.map((ch) => {
      const [kind, label] = channelState(ch);
      return h('div', { class: 'card' }, h('div', { class: 'item' }, h('h3', null, `${ch.channel} · ${ch.account}`), pill(label, kind)),
        h('dl', { class: 'kv' }, h('dt', null, 'Last success'), h('dd', null, ch.lastSuccessAt ? `${ago(ch.lastSuccessAt)} (${fmtDate(ch.lastSuccessAt)})` : 'never'),
          ch.lastError ? [h('dt', null, 'Last error'), h('dd', null, ch.lastError)] : null));
    }))
    : h('p', { class: 'muted' }, 'No chat channels are running. Enable Telegram, Signal or Discord in ', link('#/settings', 'Settings'), '.');
  return [cards, h('section', { class: 'stack', 'aria-labelledby': 'ch-h' }, h('h2', { id: 'ch-h' }, 'Channel health'), channels)];
}

export default async function mount(root, ctx) {
  root.append(pageHead('Overview', 'Live status of this Garnet. Refreshes every 10 seconds while the tab is visible.'));
  const body = h('div', { class: 'page' });
  root.append(body);
  const load = async () => {
    try {
      const o = await api.get('/api/overview');
      body.replaceChildren(...render(o));
      ctx.setBadge(o.pendingApprovals);
      fetchAchievements().catch(() => {});
    } catch (e) {
      body.replaceChildren(errorBox(e, load));
    }
  };
  await load();
  ctx.every(10_000, load);
}
