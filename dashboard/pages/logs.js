import { api, enc } from '../api.js';
import { empty, errorBox, field, fill, fmtDate, h, link, pageHead, pager, pill, table } from '../ui.js';

const LIMIT = 50;
const select = (opts) => h('select', null, opts.map(([v, t]) => h('option', { value: v }, t)));
const statusKind = (n) => (n >= 500 ? 'err' : n >= 400 ? 'warn' : n >= 200 && n < 300 ? 'ok' : '');

/** A filter form, a results container and a pager. `view.render(data)` builds the results. */
function panel(filters, view) {
  const out = h('div', { class: 'stack focus-target', tabindex: '-1' });
  let offset = 0;
  const load = async (to = offset, focus = false) => {
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(to) });
      for (const [k, input] of Object.entries(filters)) if (input.value.trim()) params.set(k, input.value.trim());
      const d = await api.get(`${view.path}?${params}`);
      offset = to;
      fill(out, d.total ? view.render(d) : empty(view.none[0], view.none[1]), d.total > LIMIT ? pager({ offset, limit: LIMIT, total: d.total, go: (o) => load(o, true) }) : null);
      if (focus) out.focus({ preventScroll: true });
    } catch (e) { out.replaceChildren(errorBox(e, () => load())); }
  };
  const form = h('form', { class: 'filters', role: 'search', 'aria-label': view.aria },
    Object.entries(filters).map(([k, input]) => field(view.labels[k], input, null, `f-${k}`)), h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Apply'));
  form.addEventListener('submit', (e) => { e.preventDefault(); load(0); });
  for (const input of Object.values(filters)) if (input.tagName === 'SELECT') input.addEventListener('change', () => load(0));
  return { nodes: [form, out], load };
}

function audit() {
  return panel({
    status: select([['', 'Any status'], ['2xx', '2xx success'], ['4xx', '4xx client error'], ['5xx', '5xx server error'], ['401', '401'], ['403', '403'], ['429', '429']]),
    method: select([['', 'Any method'], ['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['DELETE', 'DELETE']]),
    keyId: h('input', { maxlength: '64', autocomplete: 'off', placeholder: 'key id' }),
    q: h('input', { maxlength: '200', autocomplete: 'off', placeholder: '/api/…' }),
  }, {
    path: '/api/log/audit', aria: 'Filter audit log', none: ['No matching requests', 'Every API request is recorded here, except /health.'],
    labels: { status: 'Status', method: 'Method', keyId: 'Key id', q: 'Path contains' },
    render: (d) => table(['When', 'Method', 'Path', 'Status', 'Key', 'IP'], d.entries.map((e) => [
      h('time', { datetime: e.at }, fmtDate(e.at)), h('code', null, e.method), h('span', { class: 'mono' }, e.path), pill(String(e.status), statusKind(e.status)), e.keyId ? h('code', null, e.keyId) : 'none', e.ip || ''])),
  });
}

function failures() {
  return panel({
    kind: select([['', 'Tasks and deliveries'], ['task', 'Tasks only'], ['outbox', 'Deliveries only']]),
    status: select([['', 'Any status'], ['failed', 'failed'], ['budget_exhausted', 'budget exhausted'], ['uncertain', 'uncertain (delivery)']]),
  }, {
    path: '/api/log/failures', aria: 'Filter failures', none: ['No failures', 'Failed tasks and undelivered replies show up here.'],
    labels: { kind: 'Kind', status: 'Status' },
    render: (d) => h('div', { class: 'stack' }, table(['When', 'Kind', 'Status', 'Where', 'Detail'], d.items.map((f) => [
      h('time', { datetime: f.at }, fmtDate(f.at)), f.kind === 'task' ? 'Task' : 'Delivery', pill(f.status.replaceAll('_', ' '), f.status === 'budget_exhausted' || f.status === 'uncertain' ? 'warn' : 'err'),
      f.kind === 'task' && f.ref ? link(`#/sessions/${enc(f.ref)}`, 'Open session') : h('span', { class: 'mono' }, f.ref || ''), f.detail || h('span', { class: 'muted' }, 'No detail recorded')])),
    h('p', { class: 'muted small' }, '"Uncertain" deliveries were interrupted mid-send. Garnet never resends them blindly, so check the chat yourself.')),
  });
}

export default async function mount(root, ctx) {
  const which = ctx.arg === 'failures' ? 'failures' : 'audit';
  const tab = (id, text) => h('a', { class: 'btn btn-ghost btn-sm', href: `#/logs/${id}`, 'aria-current': which === id ? 'page' : false }, text);
  const p = which === 'audit' ? audit() : failures();
  root.append(pageHead('Logs', which === 'audit' ? 'Every authenticated API request, newest first.' : 'Tasks that failed and replies that could not be delivered.'),
    h('nav', { class: 'tabs', 'aria-label': 'Log type' }, tab('audit', 'API audit'), tab('failures', 'Failures')), ...p.nodes);
  await p.load(0);
}
