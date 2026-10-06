import { api, enc } from '../api.js';
import { lineDiff } from '../diff.js';
import { fill, busy, confirmDialog, empty, errorBox, field, fmtDate, h, ago, link, num, pageHead, pill, toast } from '../ui.js';

function badges(s) {
  return h('div', { class: 'badges' }, pill(s.provenance, s.provenance === 'agent' ? 'accent' : ''), s.locked ? pill('locked', 'warn') : null,
    s.hasProposal || s.proposal ? pill('proposal', 'err') : null, pill(`${num(s.uses)} use${s.uses === 1 ? '' : 's'}`));
}

/** Strips the --- frontmatter --- block from a skill file so bodies compare cleanly. */
const bodyOf = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^\n/, '');

export function diffView(a, b) {
  const rows = lineDiff(a, b);
  if (!rows.some((r) => r.t !== 'same')) return h('p', { class: 'muted' }, 'No differences.');
  return h('div', { class: 'diff', role: 'group', 'aria-label': 'Line differences' }, rows.map((r) =>
    h('div', { class: r.t === 'same' ? '' : r.t }, h('span', { 'aria-hidden': 'true' }, r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '), h('span', null, r.s || ' '),
      r.t === 'same' ? null : h('span', { class: 'sr' }, r.t === 'add' ? ' (added)' : ' (removed)'))));
}

async function detail(root, name) {
  const body = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const s = await api.get(`/api/skills/${enc(name)}`);
      const act = (verb, label, cls, confirm) => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (ev) => {
          const btn = ev.currentTarget;
        if (confirm && !(await confirmDialog({ title: confirm.title, body: confirm.body, confirm: label }))) return;
        await busy(btn, async () => {
          await api.post(`/api/skills/${enc(name)}/${verb}`);
          if (verb === 'archive') {
            toast(`Archived ${name}`, 'ok', { action: { label: 'Undo', run: () => api.post(`/api/skills/${enc(name)}/unarchive`).then(() => toast('Restored', 'ok')).catch((x) => toast(x.message, 'error')) } });
            location.hash = '#/skills';
          } else { toast(`${label}: done`, 'ok'); await load(); }
        });
      } }, label);
      const prop = s.proposal ? bodyOf(s.proposal) : null;
      body.replaceChildren(
        h('div', { class: 'card stack' }, h('div', { class: 'item' }, h('h2', null, s.name), badges(s)), h('p', null, s.description),
          h('dl', { class: 'kv' }, h('dt', null, 'Last used'), h('dd', null, s.lastUsedAt ? `${ago(s.lastUsedAt)} (${fmtDate(s.lastUsedAt)})` : 'never')),
          s.locked ? h('p', { class: 'hint' }, 'Locked: Ruby cannot overwrite this skill directly. It can only propose changes for you to review.') : null,
          h('div', { class: 'row' }, act('archive', 'Archive', 'btn-ghost', { title: `Archive ${name}?`, body: 'Ruby will stop seeing this skill. You can restore it later.' }))),
        prop !== null ? h('section', { class: 'card stack', 'aria-labelledby': 'prop-h' }, h('h2', { id: 'prop-h' }, 'Proposed change'),
          h('p', { class: 'muted' }, 'Ruby proposed an update. Red lines are removed, green lines are added.'), diffView(s.body, prop),
          h('div', { class: 'row' }, act('accept', 'Accept', 'btn-primary'), act('reject', 'Reject', 'btn-danger'))) : null,
        h('section', { class: 'card stack', 'aria-labelledby': 'body-h' }, h('h2', { id: 'body-h' }, 'Current instructions'), h('pre', null, s.body)));
    } catch (e) { body.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead(name, 'Skill details', link('#/skills', '← All skills', 'btn btn-ghost')), body);
  await load();
}

export default async function mount(root, ctx) {
  if (ctx.arg) return detail(root, ctx.arg);
  const out = h('div', { class: 'stack' });
  const nameIn = h('input', { placeholder: 'skill-name', autocomplete: 'off', maxlength: '64' });
  const restore = h('form', { class: 'row' }, field('Restore an archived skill', nameIn, 'Archived skills are hidden from the list; enter the name to bring one back.', 'unarch'), h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Unarchive'));
  restore.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = nameIn.value.trim();
    if (!n) return;
    await busy(restore.querySelector('button'), async () => { await api.post(`/api/skills/${enc(n)}/unarchive`); toast(`Restored ${n}`, 'ok'); nameIn.value = ''; await load(); });
  });
  const load = async () => {
    try {
      const d = await api.get('/api/skills');
      const stale = new Set(d.stale);
      fill(out,
        d.skills.length ? h('div', { class: 'grid wide' }, d.skills.map((s) => h('a', { class: 'card stack', href: `#/skills/${enc(s.name)}`, 'aria-label': `${s.name}, open details` },
          h('h3', null, s.name), h('p', { class: 'muted small' }, s.description), badges(s), stale.has(s.name) ? pill('stale', 'warn') : null)))
          : empty('No skills yet', 'Ruby writes a skill when it learns a repeatable procedure. You can also add your own.'),
        d.stale.length ? h('section', { class: 'card stack', 'aria-labelledby': 'st-h' }, h('h2', { id: 'st-h' }, 'Stale skills'),
          h('p', { class: 'muted' }, 'Agent-written skills that have not been used for a while. Never deleted automatically; archive them if you do not need them.'),
          h('div', { class: 'badges' }, d.stale.map((n) => link(`#/skills/${enc(n)}`, n, 'pill warn')))) : null,
        d.problems.length ? h('section', { class: 'card stack' }, h('h2', null, 'Skipped files'), d.problems.map((p) => h('p', { class: 'small' }, h('strong', null, p.name), `: ${p.problem}`))) : null,
        h('div', { class: 'card' }, restore));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Skills', 'Reusable procedures Ruby has learned or you gave it. Locked skills change only when you accept a proposal.'), out);
  await load();
}
