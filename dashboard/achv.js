// Achievement bookkeeping, easter eggs and the sparkle. Nothing here leaves the host.
import { api, enc, session } from './api.js';
import { toast } from './ui.js';

const SEEN = 'garnet-seen-ach';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Compares against what this tab has already seen; toasts anything new. First sight is silent. */
export function noteAchievements(list) {
  const now = list.filter((a) => a.unlockedAt).map((a) => a.id);
  let seen = null;
  try { seen = JSON.parse(sessionStorage.getItem(SEEN) || 'null'); } catch { /* ignore */ }
  if (seen) {
    for (const id of now.filter((x) => !seen.includes(x))) {
      const a = list.find((x) => x.id === id);
      toast(`Achievement unlocked: ${a.title}`, 'ok');
    }
  }
  try { sessionStorage.setItem(SEEN, JSON.stringify(now)); } catch { /* ignore */ }
}

export async function fetchAchievements() {
  const { achievements } = await api.get('/api/achievements');
  noteAchievements(achievements);
  return achievements;
}

export function sparkle() {
  const target = document.querySelector('.gem-btn:not([hidden])') || document.body;
  const btn = [...document.querySelectorAll('.gem-btn')].find((b) => b.offsetParent !== null) || target;
  btn.classList.add('pulse');
  setTimeout(() => btn.classList.remove('pulse'), 700);
  if (reduced()) return;
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const glow = document.createElement('div');
  glow.className = 'glow';
  glow.style.left = `${cx}px`; glow.style.top = `${cy}px`;
  document.body.append(glow);
  setTimeout(() => glow.remove(), 1000);
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('div');
    const ang = (i / 14) * Math.PI * 2, dist = 36 + (i % 3) * 20;
    s.className = 'spark';
    s.style.left = `${cx}px`; s.style.top = `${cy}px`;
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    s.style.animationDelay = `${(i % 4) * 40}ms`;
    document.body.append(s);
    setTimeout(() => s.remove(), 1200);
  }
}

/** Asks the host to record an easter egg; always celebrates, only toasts "unlocked" the first time. */
export async function easterEgg(id, title) {
  if (!session.key) return;
  sparkle();
  try {
    const { unlocked } = await api.post(`/api/achievements/${enc(id)}/unlock`);
    if (unlocked) {
      toast(`Achievement unlocked: ${title}`, 'ok');
      try {
        const seen = JSON.parse(sessionStorage.getItem(SEEN) || 'null');
        if (seen && !seen.includes(id)) sessionStorage.setItem(SEEN, JSON.stringify([...seen, id]));
      } catch { /* ignore */ }
    } else toast('The gem remembers. Already unlocked.');
  } catch (e) {
    toast(e.message, 'error');
  }
}

const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
export function watchKonami() {
  let at = 0;
  document.addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    at = k === CODE[at] ? at + 1 : k === CODE[0] ? 1 : 0;
    if (at === CODE.length) { at = 0; easterEgg('konami', '↑↑↓↓←→←→BA'); }
  });
}

const QUOTES = [
  'Small enough to read, sharp enough to trust.',
  'A gem is just coal that kept its appointments.',
  'Automate the boring; keep the judgment.',
  'Measure twice, spend tokens once.',
  'The best agent is the one you can audit.',
  'Quiet heartbeats are good heartbeats.',
  'Good defaults are a form of kindness.',
  'Write it down, then forget it safely.',
  'Fast is fine. Reversible is better.',
  'Polish the facets that you actually touch.',
  'Trust, but verify. Then approve.',
  'Done beats perfect, but logged beats done.',
  'Every great system was once a tidy script.',
  'Be the red in the stack trace of life.',
];
export const dailyQuote = () => QUOTES[Math.floor(Date.now() / 86_400_000) % QUOTES.length];
