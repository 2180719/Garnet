import { streamChat } from '../api.js';
import { field, h, pageHead, toast } from '../ui.js';

// Kept at module level so the transcript survives navigating away and back (page lifetime only).
const convs = new Map([['dashboard', []]]);
let current = 'dashboard';
let running = null; // {controller, conv}
const NAME = /^[a-z0-9-]{1,40}$/;

function bubble(m) {
  const node = h('div', { class: `msg msg-${m.role}` });
  m.node = node;
  paint(m);
  return node;
}
function paint(m) {
  const n = m.node;
  if (!n || !n.isConnected) return;
  n.className = `msg msg-${m.role}${m.live ? ' typing' : ''}`;
  n.textContent = m.text || (m.live ? 'Thinking' : '');
  const log = n.parentNode;
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 140) log.scrollTop = log.scrollHeight;
}

export default function mount(root) {
  const select = h('select');
  const fresh = h('input', { id: 'newconv', placeholder: 'new-conversation', maxlength: '40', 'aria-label': 'New conversation name', autocomplete: 'off' });
  const log = h('div', { class: 'log', role: 'log', tabindex: '0', 'aria-label': 'Conversation with Ruby' });
  const status = h('div', { class: 'sr', role: 'status' });
  const input = h('textarea', { id: 'msg', rows: '1', placeholder: 'Message Ruby (Enter to send, Shift+Enter for a new line)', 'aria-label': 'Message' });
  const send = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send');
  const stop = h('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, 'Stop');

  const fillSelect = () => select.replaceChildren(...[...convs.keys()].map((k) => h('option', { value: k, selected: k === current }, k)));
  const showLog = () => {
    log.replaceChildren();
    const t = convs.get(current);
    if (!t.length) log.append(h('p', { class: 'muted' }, 'Say hello. Ruby remembers earlier turns of a conversation on the server, so you can pick up where you left off even after a reload.'));
    for (const m of t) log.append(bubble(m));
    log.scrollTop = log.scrollHeight;
  };
  const sync = () => { const busy = !!running; send.hidden = busy; stop.hidden = !busy; input.disabled = false; };

  select.addEventListener('change', () => { current = select.value; showLog(); });
  const create = () => {
    const n = fresh.value.trim().toLowerCase();
    if (!NAME.test(n)) { toast('Use 1 to 40 characters: a-z, 0-9 and "-".', 'error'); fresh.focus(); return; }
    if (!convs.has(n)) convs.set(n, []);
    current = n; fresh.value = ''; fillSelect(); showLog(); input.focus();
  };
  fresh.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  stop.addEventListener('click', () => running?.controller.abort());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; });

  const form = h('form', { class: 'composer' }, input, send, stop);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || running) return;
    const conv = current, t = convs.get(conv);
    const user = { role: 'user', text }, reply = { role: 'ruby', text: '', live: true };
    t.push(user, reply);
    if (log.firstChild && !log.firstChild.classList.contains('msg')) log.replaceChildren();
    log.append(bubble(user), bubble(reply));
    log.scrollTop = log.scrollHeight;
    input.value = ''; input.style.height = 'auto';
    const controller = new AbortController();
    running = { controller, conv };
    sync();
    status.textContent = 'Ruby is replying';
    try {
      await streamChat({ conversation: conv, text, signal: controller.signal, onText: (d) => { reply.text += d; paint(reply); } });
      if (!reply.text) reply.text = '(no reply)';
    } catch (err) {
      if (err.name === 'AbortError') reply.text = `${reply.text}${reply.text ? ' ' : ''}(stopped)`;
      else { reply.role = 'error'; reply.text = err.message; }
    } finally {
      reply.live = false;
      running = null;
      paint(reply);
      sync();
      status.textContent = 'Ruby finished replying';
      if (input.isConnected) input.focus();
    }
  });

  root.append(pageHead('Chat', 'Talk to Ruby through the same API your own apps use. Only your newest message is sent; Ruby keeps the history.'),
    h('div', { class: 'row' }, field('Conversation', select, null, 'conv'), h('div', { class: 'field' }, h('label', { for: 'newconv' }, 'New conversation (a-z, 0-9, -)'),
      h('div', { class: 'row' }, fresh, h('button', { class: 'btn btn-ghost', type: 'button', onclick: create }, 'Create')))),
    status, h('div', { class: 'chat' }, log, form));
  fillSelect();
  showLog();
  sync();
}
