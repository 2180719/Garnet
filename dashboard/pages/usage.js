import { api } from '../api.js';
import { empty, errorBox, field, h, num, pageHead, table } from '../ui.js';

const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

function chart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.cacheReadTokens + r.outputTokens));
  const bars = rows.map((r) => {
    const total = r.inputTokens + r.cacheReadTokens + r.outputTokens;
    const b = h('div', { class: 'bar', role: 'img', 'aria-label': `${r.day}: ${num(r.inputTokens)} input, ${num(r.cacheReadTokens)} cached, ${num(r.outputTokens)} output tokens`, title: `${r.day}: ${num(total)} tokens` });
    for (const [cls, v] of [['s3', r.outputTokens], ['s2', r.cacheReadTokens], ['s1', r.inputTokens]]) {
      const seg = h('i', { class: cls });
      seg.style.height = `${(v / max) * 100}%`;
      b.append(seg);
    }
    return b;
  });
  return h('figure', { class: 'card stack' },
    h('figcaption', { class: 'row' }, h('strong', null, 'Tokens per day'), h('span', { class: 'muted small' }, `(tallest day: ${num(max)})`)),
    h('div', { class: 'legend', 'aria-hidden': 'true' }, [['Input', 'var(--c1)'], ['Cached (read)', 'var(--c2)'], ['Output', 'var(--c3)']].map(([t, c]) => {
      const s = h('span', null, t); s.style.setProperty('--sw', c); return s;
    })),
    h('div', null, h('div', { class: 'chart' }, bars), h('div', { class: 'xlabels', 'aria-hidden': 'true' }, rows.map((r) => h('span', null, r.day.slice(5))))));
}

export default async function mount(root) {
  const out = h('div', { class: 'stack' });
  const sel = h('select', null, [7, 14, 30, 90, 365].map((d) => h('option', { value: d, selected: d === 30 }, `Last ${d} days`)));
  const load = async () => {
    try {
      const { days } = await api.get(`/api/usage?days=${sel.value}`);
      if (!days.length) { out.replaceChildren(empty('No usage yet', 'Token counts appear after Ruby completes its first task.')); return; }
      out.replaceChildren(
        h('div', { class: 'grid' }, [['Tasks', sum(days, 'tasks')], ['Input tokens', sum(days, 'inputTokens')], ['Cached (read)', sum(days, 'cacheReadTokens')], ['Output tokens', sum(days, 'outputTokens')]]
          .map(([l, v]) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, l), h('div', { class: 'value' }, num(v))))),
        chart(days),
        table(['Day (UTC)', 'Tasks', 'Input', 'Cached read', 'Cache write', 'Output', 'Unknown'], [...days].reverse().map((r) => [r.day, num(r.tasks), num(r.inputTokens), num(r.cacheReadTokens), num(r.cacheWriteTokens), num(r.outputTokens), num(r.unknown)]), [1, 2, 3, 4, 5, 6]),
        h('p', { class: 'muted small' }, '"Unknown" counts tasks where the model provider did not report token usage; they add nothing to the totals above.'));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  sel.addEventListener('change', load);
  root.append(pageHead('Usage', 'Token use per day, from the tasks Ruby has run.', field('Range', sel, null, 'range')), out);
  await load();
}
