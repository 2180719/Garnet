import { api, enc } from '../api.js';
import { ago, empty, errorBox, field, fill, fmtDate, h, link, num, pageHead, pager, pill } from '../ui.js';

const LIMIT = 25;
const EVENTS = 100;
const STATUS = { completed: 'ok', failed: 'err', budget_exhausted: 'warn', running: 'accent', waiting_for_approval: 'warn', waiting_for_user: 'warn', cancelled: '' };
const label = (s) => s.replaceAll('_', ' ');

/** Input (cache included) and output tokens; "tokens unknown" when no provider reported any. */
function tokens(u) {
  if (u.inputTokens === null && u.outputTokens === null) return 'tokens unknown';
  const input = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  return `${num(input)} in · ${num(u.outputTokens ?? 0)} out`;
}

function row(s) {
  const name = s.conversation || s.title || s.id;
  return h('a', { class: 'card sess', href: `#/sessions/${enc(s.id)}`, 'aria-label': `${name}, open event log` },
    h('div', { class: 'meta stack' },
      h('span', { class: 'title' }, name),
      h('span', { class: 'small muted' }, `Created ${fmtDate(s.createdAt)} · last activity ${ago(s.updatedAt)} · ${num(s.events)} events · ${num(s.tasks)} task${s.tasks === 1 ? '' : 's'}`),
      h('span', { class: 'small muted mono' }, s.id)),
    h('div', { class: 'badges' }, s.taskStatus ? pill(label(s.taskStatus), STATUS[s.taskStatus] ?? '') : pill('no tasks'), s.bound ? null : pill('not linked', 'warn'), s.tainted ? pill('read untrusted content', 'warn') : null, pill(tokens(s.usage))));
}

async function list(root) {
  const out = h('div', { class: 'stack focus-target', tabindex: '-1' });
  const q = h('input', { type: 'search', maxlength: '200', autocomplete: 'off', placeholder: 'Conversation, title or id' });
  let offset = 0;
  const load = async (to = offset, focus = false) => {
    try {
      const term = q.value.trim();
      const d = await api.get(`/api/log/sessions?limit=${LIMIT}&offset=${to}&q=${enc(term)}`);
      offset = to;
      fill(out,
        d.items.length ? h('div', { class: 'list' }, d.items.map(row)) : empty(term ? 'No matching sessions' : 'No sessions yet', term ? 'Try a shorter search.' : 'A session starts with the first message to Garnet.'),
        d.total > LIMIT ? pager({ offset, limit: LIMIT, total: d.total, go: (o) => load(o, true) }) : null);
      if (focus) out.focus({ preventScroll: true });
    } catch (e) { out.replaceChildren(errorBox(e, () => load())); }
  };
  const form = h('form', { class: 'filters', role: 'search', 'aria-label': 'Filter sessions' }, field('Search', q, null, 'sq'), h('button', { class: 'btn btn-ghost', type: 'submit' }, 'Search'));
  form.addEventListener('submit', (e) => { e.preventDefault(); load(0); });
  root.append(pageHead('Sessions', 'Every conversation Garnet has had. Open one to read its event log; nothing here can be changed.'), form, out);
  await load(0);
}

const json = (v) => JSON.stringify(v, null, 2);
const head = (e, kind, extra) => h('div', { class: 'ev-head' }, h('strong', null, kind), h('span', null, `#${e.seq}`), h('time', { datetime: e.at }, fmtDate(e.at)), extra || null);
const details = (title, body) => h('details', null, h('summary', null, title), h('pre', null, body));

function renderEvent(e, names) {
  const blocks = (content) => content.map((b) => {
    if (b.type === 'text') return b.text ? h('div', { class: 'ev-text' }, b.text) : null;
    if (b.type === 'tool_call') { names.set(b.id, b.name); return details(`Tool call: ${b.name}`, json(b.input)); }
    if (b.type === 'tool_result') return details(`Tool result${b.isError ? ' (error)' : ''}`, b.content);
    if (b.type === 'provider') return h('p', { class: 'small muted' }, `Reasoning from ${b.provider} is hidden.`);
    if (b.type === 'attachment') {
      const a = b.attachment || {};
      const kb = typeof a.size === 'number' ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : '';
      const title = `${a.kind || 'file'}: ${a.name || a.id} (${a.mimeType}${kb})`;
      const body = [b.note ? `(${b.note})` : '', b.text || ''].filter(Boolean).join('\n\n');
      return body ? details(`Attachment ${title}`, body) : h('p', { class: 'small muted' }, `Attachment ${title}`);
    }
    return null;
  });
  switch (e.type) {
    case 'user_message':
      return h('li', { class: 'ev user' }, head(e, 'User', h('span', null, e.source)), blocks(e.content));
    case 'assistant_message':
      return h('li', { class: 'ev assistant' }, head(e, 'Garnet', h('span', null, `${e.model} · ${e.stopReason} · ${tokens(e.usage)}`)), blocks(e.content));
    case 'tool_started':
      names.set(e.call.id, e.call.name);
      return h('li', { class: 'ev tool' }, head(e, 'Tool started'), details(e.call.name, json(e.call.input)));
    case 'tool_finished': {
      const r = e.result;
      const name = names.get(e.callId) || e.callId;
      const meta = [r.untrusted ? 'untrusted content' : null, r.truncated ? 'truncated' : null, r.repairs?.length ? `repaired: ${r.repairs.join(', ')}` : null, r.artifactId ? `artifact ${r.artifactId}` : null].filter(Boolean).join(' · ');
      return h('li', { class: `ev tool${r.status === 'error' ? ' bad' : ''}` },
        head(e, 'Tool result', h('span', null, `${r.status === 'error' ? `error (${r.category})` : 'ok'} · ${num(r.durationMs)} ms`)),
        details(`${name}${meta ? ` (${meta})` : ''}`, r.content));
    }
    case 'task_status':
      return h('li', { class: `ev${e.status === 'failed' ? ' bad' : ''}` }, head(e, 'Task', pill(label(e.status), STATUS[e.status] ?? '')), e.reason ? h('div', { class: 'ev-text small' }, e.reason) : null);
    case 'model_error':
      return h('li', { class: 'ev bad' }, head(e, 'Model error', h('span', null, e.category)), h('div', { class: 'ev-text' }, e.message));
    case 'tainted':
      return h('li', { class: 'ev mark' }, head(e, 'Untrusted content', h('span', null, e.inherited ? 'inherited with the task' : 'read by a tool')),
        h('div', { class: 'ev-text' }, `${e.source}. From here on, actions set to allow ask first (see containment in settings); /new starts a clean conversation.`));
    case 'checkpoint':
      return h('li', { class: 'ev mark' }, head(e, 'Compaction checkpoint', h('span', null, `covers events up to #${e.throughSeq}`)), details('Summary kept in place of the earlier events', e.summary));
    case 'context_frozen':
      return h('li', { class: 'ev' }, head(e, 'System prompt frozen'), h('p', { class: 'small muted' }, `${num(e.chars)} characters. Not shown, because it embeds memory.`));
    default:
      return h('li', { class: 'ev' }, head(e, e.type), details('Raw event', json(e)));
  }
}

async function detail(root, id) {
  const log = h('ol', { class: 'evlog', 'aria-label': 'Events' });
  const info = h('div', { class: 'stack' });
  const foot = h('div', { class: 'row' });
  const names = new Map();
  let next = 0;
  const fetchMore = async (after, reset) => {
    const d = await api.get(`/api/log/sessions/${enc(id)}/events?after=${after}&limit=${EVENTS}`);
    if (reset) {
      names.clear();
      fill(log);
      fill(info,
        h('dl', { class: 'kv card' }, h('dt', null, 'Conversation'), h('dd', null, d.session.conversation || 'not linked'), h('dt', null, 'Created'), h('dd', null, fmtDate(d.session.createdAt)),
          h('dt', null, 'Last activity'), h('dd', null, `${ago(d.session.updatedAt)} (${fmtDate(d.session.updatedAt)})`), h('dt', null, 'Events'), h('dd', null, num(d.lastSeq))),
        h('p', { class: 'muted small' }, 'Secrets are redacted, long values are cut, and the model’s reasoning is never shown.'));
    }
    for (const e of d.events) log.append(renderEvent(e, names));
    if (reset && !d.events.length) log.append(h('li', null, empty('No events', 'This session has not recorded anything yet.')));
    next = d.nextAfter;
    fill(foot,
      reset && after > 0 ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => run(0, true) }, 'Show from the beginning') : null,
      next !== null ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: (ev) => more(ev.currentTarget) }, `Load ${Math.min(EVENTS, d.lastSeq - next)} more`) : null,
      next !== null ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => run(Math.max(0, d.lastSeq - EVENTS), true) }, 'Jump to latest') : null,
      h('span', { class: 'muted small', role: 'status' }, next === null ? 'End of log.' : `Showing events up to #${next} of ${num(d.lastSeq)}.`));
  };
  const run = async (after, reset) => {
    try { await fetchMore(after, reset); } catch (e) { fill(info, errorBox(e, () => run(after, reset))); }
  };
  const more = async (btn) => {
    btn.disabled = true;
    try { await fetchMore(next, false); } catch (e) { btn.disabled = false; fill(info, errorBox(e, () => more(btn))); }
  };
  root.append(pageHead('Session log', id, link('#/sessions', '← All sessions', 'btn btn-ghost')), info, log, foot);
  await run(0, true);
}

export default async function mount(root, ctx) {
  if (ctx.arg) return detail(root, ctx.arg);
  return list(root);
}
