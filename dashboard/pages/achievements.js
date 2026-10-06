import { fetchAchievements } from '../achv.js';
import { errorBox, fmtDay, gem, h, pageHead } from '../ui.js';

export default async function mount(root, ctx) {
  const out = h('div', { class: 'stack' });
  const load = async () => {
    try {
      const list = await fetchAchievements();
      const got = list.filter((a) => a.unlockedAt).length;
      out.replaceChildren(
        h('div', { class: 'card stack' }, h('strong', { id: 'prog' }, `${got} of ${list.length} unlocked`),
          (() => { const p = h('div', { class: 'progress', role: 'progressbar', 'aria-labelledby': 'prog', 'aria-valuemin': '0', 'aria-valuemax': String(list.length), 'aria-valuenow': String(got) }, h('i')); p.firstChild.style.width = `${(got / list.length) * 100}%`; return p; })()),
        h('div', { class: 'grid wide' }, list.map((a) => h('article', { class: `card trophy${a.unlockedAt ? '' : ' locked'}` }, gem(),
          h('div', null, h('h3', null, a.title), h('p', null, a.description), h('p', { class: 'small' }, a.unlockedAt ? `Unlocked ${fmtDay(a.unlockedAt)}` : 'Locked'))))));
    } catch (e) { out.replaceChildren(errorBox(e, load)); }
  };
  root.append(pageHead('Achievements', 'A trophy room for real milestones. Stored on this machine only; nothing phones home.'), out);
  await load();
  ctx.every(15_000, load);
}
