import { api, enc } from '../api.js';
import { fill, busy, confirmDialog, empty, errorBox, field, fmtDate, h, link, num, pageHead, pill, table, toast } from '../ui.js';

const KIND = { completed: 'ok', skipped_unchanged: '', failed: 'err', interrupted: 'err', missed: 'warn', budget_exhausted: 'warn', skipped_budget: 'warn', running: 'accent', waiting_for_approval: 'warn', waiting_for_user: 'warn', cancelled: '' };
const ORIGIN = { config: 'config.json', agent: 'made in chat', owner: 'added by you' };
const what = (j) => (j.message !== undefined ? ['Message', j.message] : j.script ? ['Command', j.script.command] : ['Instructions', j.instructions]);
const target = (j) => (j.notify ? j.notifyLabel || `${j.notify.channel} chat ${j.notify.chatId}` : 'run history only');

async function edit(j, reload) {
  const when = h('input', { type: 'text', placeholder: 'e.g. every weekday at 9am, tomorrow 8:30' });
  const [label, current] = what(j);
  const text = j.script ? null : h('textarea', { rows: 4 });
  if (text) text.value = current || '';
  const ok = await confirmDialog({
    title: `Edit ${j.id}`,
    confirm: 'Save',
    content: h('div', { class: 'stack' },
      field('New schedule', when, `Now: ${j.schedule}. Leave empty to keep it.`, 'job-when'),
      text ? field(label, text, null, 'job-text') : h('p', { class: 'muted small' }, 'Script commands are changed from chat or the CLI, where the owner approves the exact command.')),
  });
  if (!ok) return;
  const body = {};
  if (when.value.trim()) body.when = when.value.trim();
  if (text && text.value.trim() && text.value.trim() !== current) body[j.message !== undefined ? 'message' : 'instructions'] = text.value.trim();
  if (!Object.keys(body).length) return;
  try {
    const r = await api.put(`/api/jobs/${enc(j.id)}`, body);
    toast(`Saved ${j.id}${r.nextText ? `; next ${r.nextText}` : ''}`, 'ok');
    await reload();
  } catch (e) { toast(e.message, 'error'); }
}

function job(j, reload) {
  const paused = j.state?.paused;
  const stored = j.origin?.by !== 'config';
  const act = (verb, label, cls) => h('button', { class: `btn btn-sm ${cls}`, type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
    const r = await api.post(`/api/jobs/${enc(j.id)}/${verb}`);
    toast(verb === 'run' ? `Ran ${j.id}: ${r.last ? r.last.status.replaceAll('_', ' ') : 'no result'}` : `${verb === 'pause' ? 'Paused' : 'Resumed'} ${j.id}`, 'ok');
    await reload();
  }) }, label);
  const del = h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog({ title: `Delete ${j.id}?`, body: 'The job stops (a run in progress is cancelled). Its run history is kept.', confirm: 'Delete', danger: true }))) return;
    await busy(btn, async () => { await api.del(`/api/jobs/${enc(j.id)}`); toast(`Deleted ${j.id}`, 'ok'); await reload(); });
  } }, 'Delete');
  const [label, text] = what(j);
  return h('article', { class: 'card stack' },
    h('div', { class: 'item' }, h('h3', null, j.id), h('div', { class: 'badges' }, pill(ORIGIN[j.origin?.by] || 'config.json'), pill(j.kind), pill(j.enabled ? 'enabled' : 'disabled', j.enabled ? 'ok' : ''), paused ? pill('paused', 'err') : null, j.done ? pill('done') : null)),
    h('dl', { class: 'kv' }, h('dt', null, 'Schedule'), h('dd', null, `${j.schedule} (${j.zone})`), h('dt', null, 'Next run'), h('dd', null, j.nextText || (j.done ? 'done' : paused ? 'paused' : 'none')),
      h('dt', null, label), h('dd', null, text), h('dt', null, 'Sends to'), h('dd', null, `${target(j)}${j.notifyWhen === 'on_change' ? ', only when there is something new' : ''}`),
      j.origin?.by === 'agent' ? [h('dt', null, 'Created'), h('dd', null, `${fmtDate(j.origin.at)}${j.origin.conversation ? ` in ${j.origin.conversation}` : ''}`)] : null,
      j.state?.consecutiveFailures ? [h('dt', null, 'Failures'), h('dd', null, `${j.state.consecutiveFailures} in a row`)] : null),
    h('div', { class: 'row' }, act('run', 'Run now', 'btn-primary'), paused ? act('resume', 'Resume', 'btn-ghost') : act('pause', 'Pause', 'btn-ghost'),
      stored ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => edit(j, reload) }, 'Edit') : null, stored ? del : null),
    j.runs.length ? table(['When', 'Status', 'Tokens', 'Note'], j.runs.map((r) => [fmtDate(r.startedAt), pill(r.status.replaceAll('_', ' '), KIND[r.status] ?? ''), num(r.tokens), r.note || '']), [2])
      : h('p', { class: 'muted small' }, 'No runs yet.'));
}

export default async function mount(root) {
  const out = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const d = await api.get('/api/jobs');
      fill(out, d.enabled ? null : h('div', { class: 'banner warn' }, 'The scheduler is switched off, so nothing runs on its own. "Run now" still works.'),
        ...(d.problems || []).map((p) => h('div', { class: 'banner warn' }, `${p.id}: ${p.problem}`)),
        ...(d.jobs.length ? d.jobs.map((j) => job(j, load)) : [empty('No jobs yet', 'Ask Garnet in chat ("remind me tomorrow at 9 to…"), run `garnet jobs add`, or add jobs in Settings.')]));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Schedules', h('span', null, 'Reminders, cron jobs, heartbeats and script jobs. Jobs made in chat can be edited here; jobs in config.json are edited under ', link('#/settings', 'Settings'), '.')), out);
  await load();
}
