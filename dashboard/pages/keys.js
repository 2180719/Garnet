import { api, enc, session } from '../api.js';
import { busy, confirmDialog, copyText, empty, errorBox, field, fmtDate, h, ago, pageHead, pill, table, toast } from '../ui.js';

const SCOPES = [['chat', 'Chat: talk to Garnet through /v1/chat/completions'], ['read', 'Read: view status, memory, skills, jobs, usage'], ['admin', 'Admin: change anything, including keys and config']];

function state(k) {
  if (k.revokedAt) return pill('revoked', 'err');
  if (k.expiresAt && new Date(k.expiresAt) < new Date()) return pill('expired', 'warn');
  return pill('active', 'ok');
}

export default async function mount(root) {
  const shown = h('div', { role: 'status' });
  const list = h('div');
  const load = async () => {
    try {
      const { keys } = await api.get('/api/keys');
      list.replaceChildren(keys.length ? table(['Name', 'Id', 'Scopes', 'State', 'Expires', 'Last used', ''], keys.map((k) => [
        h('span', null, k.name, k.id === session.id ? [' ', pill('this session', 'accent')] : null), h('code', null, k.id), k.scopes.join(', '), state(k), k.expiresAt ? fmtDate(k.expiresAt) : 'never', k.lastUsedAt ? ago(k.lastUsedAt) : 'never',
        k.revokedAt ? '' : h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async (ev) => {
          const btn = ev.currentTarget;
          const self = k.id === session.id;
          if (!(await confirmDialog({ title: `Revoke "${k.name}"?`, body: self ? 'This is the key you are signed in with. You will be signed out.' : 'Anything using this key will stop working immediately.', confirm: 'Revoke', danger: true }))) return;
          await busy(btn, async () => {
            await api.del(`/api/keys/${enc(k.id)}`);
            toast('Key revoked', 'ok');
            if (self) { session.clear(); location.reload(); return; }
            await load();
          });
        } }, 'Revoke')])) : empty('No keys', 'Create one below.'));
    } catch (e) { list.replaceChildren(errorBox(e, load)); }
  };

  const name = h('input', { required: true, maxlength: '64', autocomplete: 'off', placeholder: 'e.g. my-phone' });
  const days = h('input', { type: 'number', min: '1', max: '3650', placeholder: 'never' });
  const boxes = SCOPES.map(([s, label]) => ({ s, input: h('input', { type: 'checkbox', checked: s === 'chat', value: s }), label }));
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create key');
  const form = h('form', { class: 'card stack', 'aria-labelledby': 'new-h' }, h('h2', { id: 'new-h' }, 'Create a key'),
    field('Name', name, null, 'kname'),
    h('fieldset', { class: 'stack' }, h('legend', { class: 'small' }, 'Scopes'), boxes.map((b) => h('label', { class: 'check' }, b.input, h('span', null, b.label)))),
    field('Expires in (days, optional)', days, 'Leave empty for a key that never expires.', 'kdays'), submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const scopes = boxes.filter((b) => b.input.checked).map((b) => b.s);
    if (!scopes.length) { toast('Pick at least one scope.', 'error'); return; }
    busy(submit, async () => {
      const k = await api.post('/api/keys', { name: name.value.trim(), scopes, ...(days.value ? { expiresInDays: Number(days.value) } : {}) });
      shown.replaceChildren(h('div', { class: 'banner warn stack' }, h('strong', null, `Key "${k.name}" created. Copy it now: it is shown only once and cannot be recovered.`),
        h('div', { class: 'secret' }, h('code', null, k.key), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => copyText(k.key) }, 'Copy')),
        h('span', { class: 'small' }, `Scopes: ${k.scopes.join(', ')}${k.expiresAt ? ` · expires ${fmtDate(k.expiresAt)}` : ''}`)));
      name.value = ''; days.value = '';
      await load();
    });
  });
  root.append(pageHead('API keys', 'Keys let apps and this dashboard talk to Garnet. Only a hash is stored on the host.'), shown, list, form);
  await load();
}
