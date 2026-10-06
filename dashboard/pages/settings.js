// Settings: a form generated from the config's JSON Schema, with a diff review before saving.
import { api } from '../api.js';
import { pathDiff } from '../diff.js';
import { busy, confirmDialog, errorBox, h, pageHead, table, toast } from '../ui.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const typeOf = (s) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);
const show = (v) => (v === undefined ? '(unset)' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
const isGroup = (s) => typeOf(s) === 'object' && s.properties && !s.anyOf && !s.oneOf;

function getAt(o, p) { return p.reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), o); }
function setAt(o, p, v) {
  let cur = o;
  for (const k of p.slice(0, -1)) { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k]; }
  if (v === undefined) delete cur[p.at(-1)]; else cur[p.at(-1)] = v;
}

export default async function mount(root) {
  let data;
  try { data = await api.get('/api/config'); } catch (e) { root.append(pageHead('Settings'), errorBox(e)); return; }
  const { schema } = data;
  // Server-enforced: these cannot be saved over the API, so render them read-only. Mirrors src/config/protected.ts.
  const protectedPats = (data.protectedPaths || []).map((p) => p.split('.'));
  const isProtected = (path) => protectedPats.some((pat) => (pat.length === 1 && pat[0].startsWith('*') && pat[0] !== '*')
    ? path.some((k) => k.endsWith(pat[0].slice(1)))
    : pat.length <= path.length && pat.every((seg, i) => seg === '*' || (seg.startsWith('*') ? path[i].endsWith(seg.slice(1)) : seg === path[i])));
  let saved = clone(data.config);
  const draft = clone(data.config);
  const invalid = new Map();
  const bar = h('div', { class: 'savebar' });
  const result = h('div', { role: 'status', 'aria-live': 'polite' });
  let uid = 0;

  const changes = () => pathDiff(saved, draft);
  const refresh = () => {
    const n = changes().length;
    const bad = invalid.size;
    bar.replaceChildren(
      h('span', null, bad ? `${bad} field${bad > 1 ? 's have' : ' has'} invalid JSON. Fix ${bad > 1 ? 'them' : 'it'} to save.` : n ? `${n} unsaved change${n > 1 ? 's' : ''}` : 'No unsaved changes'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', type: 'button', disabled: !n, onclick: discard }, 'Discard'),
        h('button', { class: 'btn btn-primary', type: 'button', disabled: !n || !!bad, onclick: review }, 'Review changes')));
  };
  const commit = (path, v) => { setAt(draft, path, v); refresh(); };

  function label(path, s, node) {
    const id = `f${++uid}`;
    const name = path.at(-1);
    const def = s.default;
    const hint = [s.description, def !== undefined && typeof def !== 'object' ? `Default: ${show(def)}` : null, s.enum ? null : null].filter(Boolean).join(' ');
    node.id = id;
    if (hint) node.setAttribute('aria-describedby', `${id}-h`);
    return h('div', { class: 'field-row' }, h('label', { for: id }, h('span', { class: 'mono' }, name)), node, hint ? h('span', { class: 'hint', id: `${id}-h` }, hint) : null);
  }

  function leaf(s, path) {
    const cur = getAt(draft, path);
    if (isProtected(path)) {
      const ro = h('input', { value: cur === undefined ? '' : typeof cur === 'string' ? cur : JSON.stringify(cur), readonly: true, disabled: true });
      const n = label(path, s, ro);
      n.append(h('span', { class: 'hint' }, 'Read-only here. Edit config.json on the host to change it.'));
      return n;
    }
    const t = typeOf(s);
    if (s.const !== undefined) return label(path, s, h('input', { value: String(s.const), readonly: true, disabled: true }));
    if (s.enum) {
      const sel = h('select', null, cur === undefined ? h('option', { value: '' }, '(unset)') : null, s.enum.map((e) => h('option', { value: e, selected: e === cur }, e)));
      sel.addEventListener('change', () => commit(path, sel.value === '' ? undefined : sel.value));
      return label(path, s, sel);
    }
    if (t === 'boolean') {
      const box = h('input', { type: 'checkbox', role: 'switch', checked: cur === true });
      box.addEventListener('change', () => commit(path, box.checked));
      const id = `f${++uid}`;
      box.id = id;
      return h('div', { class: 'field-row' }, h('label', { class: 'switch', for: id }, box, h('span', { class: 'mono' }, path.at(-1))),
        s.description ? h('span', { class: 'hint' }, `${s.description}${s.default !== undefined ? ` Default: ${show(s.default)}.` : ''}`) : null);
    }
    if (t === 'number' || t === 'integer') {
      const min = s.minimum ?? (s.exclusiveMinimum !== undefined ? (t === 'integer' ? s.exclusiveMinimum + 1 : s.exclusiveMinimum) : undefined);
      const max = s.maximum !== undefined && s.maximum < 1e15 ? s.maximum : undefined;
      const inp = h('input', { type: 'number', value: cur ?? '', min, max, step: t === 'integer' ? '1' : 'any' });
      inp.addEventListener('input', () => commit(path, inp.value === '' ? undefined : Number(inp.value)));
      return label(path, s, inp);
    }
    if (t === 'string' && !s.anyOf) {
      const inp = h('input', { type: 'text', value: cur ?? '', autocomplete: 'off', spellcheck: 'false' });
      inp.addEventListener('input', () => commit(path, inp.value === '' ? undefined : inp.value));
      return label(path, s, inp);
    }
    return json(s, path, cur);
  }

  function json(s, path, cur) {
    const key = path.join('.');
    const area = h('textarea', { class: 'code', spellcheck: 'false', rows: String(Math.min(14, Math.max(3, JSON.stringify(cur, null, 2)?.split('\n').length || 3))) });
    area.value = cur === undefined ? '' : JSON.stringify(cur, null, 2);
    const msg = h('span', { class: 'err-text', 'aria-live': 'polite' });
    area.addEventListener('input', () => {
      const t = area.value.trim();
      try {
        const v = t === '' ? undefined : JSON.parse(t);
        invalid.delete(key); msg.textContent = ''; area.removeAttribute('aria-invalid');
        commit(path, v);
      } catch (e) {
        invalid.set(key, e.message); msg.textContent = `Invalid JSON: ${e.message}`; area.setAttribute('aria-invalid', 'true'); refresh();
      }
    });
    const node = label(path, s, area);
    node.append(msg, h('span', { class: 'hint' }, 'JSON'));
    return node;
  }

  function fields(s, path) {
    const box = h('div', { class: 'fields' });
    for (const [k, sub] of Object.entries(s.properties)) {
      const p = [...path, k];
      if (isGroup(sub)) {
        box.append(h('div', { class: 'field-row' }, h('strong', { class: 'mono' }, k), sub.description ? h('span', { class: 'hint' }, sub.description) : null, fields(sub, p)));
      } else box.append(leaf(sub, p));
    }
    return box;
  }

  function discard() {
    for (const k of Object.keys(draft)) delete draft[k];
    Object.assign(draft, clone(saved));
    invalid.clear();
    build();
  }

  async function review() {
    const diff = changes();
    const ok = await confirmDialog({ title: `Review ${diff.length} change${diff.length > 1 ? 's' : ''}`, big: true, confirm: 'Save to config',
      body: 'Compare before and after. Nothing is written until you confirm.', content: h('div', { class: 'changes' }, table(['Setting', 'Before', 'After'], diff.map((d) => [h('code', null, d.path || '(root)'), show(d.before), show(d.after)]))) });
    if (!ok) return;
    result.replaceChildren();
    const btn = bar.querySelector('.btn-primary');
    await busy(btn, async () => {
      try {
        const r = await api.put('/api/config', draft);
        saved = clone(draft);
        result.replaceChildren(h('div', { class: 'banner ok' }, h('strong', null, r.restartRequired ? 'Saved. Restart Garnet to apply.' : 'Saved.')));
        toast(r.restartRequired ? 'Saved. Restart Garnet to apply.' : 'Saved', 'ok');
        refresh();
      } catch (e) {
        if (e.status === 401) return;
        const [head, ...lines] = String(e.message).split('\n').map((l) => l.trim()).filter(Boolean);
        result.replaceChildren(h('div', { class: 'banner err', role: 'alert' }, h('strong', null, head || 'The config was rejected.'),
          lines.length ? h('ul', null, lines.map((l) => { const i = l.indexOf(': '); return h('li', null, i > 0 ? [h('code', null, l.slice(0, i)), ` ${l.slice(i + 2)}`] : l); })) : null,
          h('p', null, 'Nothing was written. Fix the fields above and review again.')));
        result.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  const sections = h('div', { class: 'stack' });
  function build() {
    sections.replaceChildren();
    const general = [];
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!isGroup(s)) { general.push([k, s]); continue; }
      sections.append(h('details', { class: 'card', open: k === 'model' }, h('summary', null, k), s.description ? h('p', { class: 'muted small' }, s.description) : null, fields(s, [k])));
    }
    for (const [k, s] of general) {
      sections.append(h('details', { class: 'card' }, h('summary', null, k), s.description ? h('p', { class: 'muted small' }, s.description) : null, h('div', { class: 'fields' }, leaf(s, [k]))));
    }
    refresh();
  }
  root.append(pageHead('Settings', 'Every Garnet setting, validated by the same schema the server uses. Review changes before they are written; most take effect after a restart.'), result, sections, bar);
  build();
}
