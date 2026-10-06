import { api, enc } from '../api.js';
import { busy, confirmDialog, empty, errorBox, field, fmtDate, h, pageHead, toast } from '../ui.js';

const NS = /^[a-z0-9-]{1,40}$/;

function editor(ns, f, reload) {
  const area = h('textarea', { class: 'code', rows: '10', spellcheck: 'false', 'aria-describedby': `c-${f.file}` });
  area.value = f.content;
  const counter = h('span', { class: 'counter', id: `c-${f.file}` });
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
  const update = () => {
    const n = area.value.length;
    counter.textContent = `${n.toLocaleString()} / ${f.limit.toLocaleString()} characters`;
    counter.className = `counter${n > f.limit ? ' over' : n > f.limit * 0.9 ? ' warn' : ''}`;
    save.disabled = n > f.limit;
  };
  area.addEventListener('input', update);
  update();
  save.addEventListener('click', () => busy(save, async () => {
    await api.put(`/api/memory/${f.file}?ns=${enc(ns)}`, { content: area.value });
    toast(`${f.name} saved`, 'ok');
    await reload();
  }));
  const hist = f.history.length
    ? h('div', { class: 'list' }, f.history.map((v) => h('div', { class: 'item' }, h('span', { class: 'small' }, `${fmtDate(v.at)} · ${v.chars.toLocaleString()} chars`),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async (ev) => {
          const btn = ev.currentTarget;
        if (!(await confirmDialog({ title: `Roll back ${f.name}?`, body: `Restore the version from ${fmtDate(v.at)}. The current content is saved first, so this can be undone.`, confirm: 'Roll back' }))) return;
        await busy(btn, async () => { await api.post(`/api/memory/${f.file}/rollback?ns=${enc(ns)}`, { id: v.id }); toast('Rolled back', 'ok'); await reload(); });
      } }, 'Roll back'))))
    : h('p', { class: 'muted small' }, 'No earlier versions yet.');
  return h('section', { class: 'card stack', 'aria-labelledby': `h-${f.file}` },
    h('div', { class: 'editor-meta' }, h('h2', { id: `h-${f.file}` }, f.name), counter), area,
    h('div', { class: 'row' }, save, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { area.value = f.content; update(); } }, 'Discard edits')),
    h('details', null, h('summary', { class: 'small muted' }, `History (${f.history.length})`), hist));
}

export default async function mount(root) {
  let ns = 'default';
  const out = h('div', { class: 'page' });
  const nsInput = h('input', { value: 'default', maxlength: '40', autocomplete: 'off', 'aria-describedby': 'ns-hint' });
  const load = async () => {
    try {
      const d = await api.get(`/api/memory?ns=${enc(ns)}`);
      out.replaceChildren(h('div', { class: 'sbs two' }, d.files.map((f) => editor(ns, f, load))));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  const form = h('form', { class: 'row' }, field('Namespace', nsInput, 'a-z, 0-9 and "-". "default" is what Ruby uses day to day.', 'ns'),
    h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Load'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = nsInput.value.trim();
    if (!NS.test(v)) { toast('Namespace must be 1 to 40 characters of a-z, 0-9 and "-".', 'error'); return; }
    ns = v; load();
  });
  root.append(pageHead('Memory', 'The small, bounded notes Ruby sees at the start of every session. Edits are versioned and can be rolled back.'), form, out);
  await load();
}
