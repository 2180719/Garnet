import { api, enc } from '../api.js';
import { fill, busy, empty, errorBox, fmtDate, h, link, num, pageHead, pill, table, toast } from '../ui.js';

const KIND = { completed: 'ok', skipped_unchanged: '', failed: 'err', interrupted: 'err', missed: 'warn', budget_exhausted: 'warn', skipped_budget: 'warn', running: 'accent', waiting_for_approval: 'warn', waiting_for_user: 'warn', cancelled: '' };
const when = (j) => (j.kind === 'cron' ? `cron ${j.cron || '?'}` : `every ${j.everyMinutes || '?'} min`);

function job(j, reload) {
  const paused = j.state?.paused;
  const act = (verb, label, cls) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
    const r = await api.post(`/api/jobs/${enc(j.id)}/${verb}`);
    toast(verb === 'run' ? `Ran ${j.id}: ${r.last ? r.last.status.replaceAll('_', ' ') : 'no result'}` : `Resumed ${j.id}`, 'ok');
    await reload();
  }) }, label);
  return h('article', { class: 'card stack' },
    h('div', { class: 'item' }, h('h3', null, j.id), h('div', { class: 'badges' }, pill(j.kind), pill(j.enabled ? 'enabled' : 'disabled', j.enabled ? 'ok' : ''), paused ? pill('paused', 'err') : null)),
    h('dl', { class: 'kv' }, h('dt', null, 'Schedule'), h('dd', null, when(j)), h('dt', null, 'Time zone'), h('dd', null, j.timezone || 'host default'),
      h('dt', null, 'Instructions'), h('dd', null, j.instructions), h('dt', null, 'Last slot'), h('dd', null, j.state?.lastScheduledFor ? fmtDate(j.state.lastScheduledFor) : 'never'),
      j.state?.consecutiveFailures ? [h('dt', null, 'Failures'), h('dd', null, `${j.state.consecutiveFailures} in a row`)] : null),
    h('div', { class: 'row' }, act('run', 'Run now', 'btn-primary'), paused ? act('resume', 'Resume', 'btn-ghost') : null),
    j.runs.length ? table(['When', 'Status', 'Tokens', 'Note'], j.runs.map((r) => [fmtDate(r.startedAt), pill(r.status.replaceAll('_', ' '), KIND[r.status] ?? ''), num(r.tokens), r.note || '']), [2])
      : h('p', { class: 'muted small' }, 'No runs yet.'));
}

export default async function mount(root) {
  const out = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const d = await api.get('/api/jobs');
      fill(out, d.enabled ? null : h('div', { class: 'banner warn' }, 'The scheduler is switched off, so nothing runs on its own. "Run now" still works.'),
        ...(d.jobs.length ? d.jobs.map((j) => job(j, load)) : [empty('No jobs configured', 'Add cron jobs or heartbeats in Settings.')]));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Schedules', h('span', null, 'Cron jobs and heartbeats. Jobs are edited under ', link('#/settings', 'Settings'), ' (the "jobs" section of the config); here you can run or resume them.')), out);
  await load();
}
