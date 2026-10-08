// The small settings people want on day one: their time zone, a daily spending cap and the web dashboard.
import { CONFIG_VERSION, activeProvider, parseConfig, validTimeZone, type GarnetConfig } from '../../config/index.ts';
import type { Io } from '../main.ts';
import type { Prompter } from './prompt.ts';
import { heading, type SetupDeps, type State } from './shared.ts';

const hostZone = (deps: SetupDeps): string => {
  try {
    return deps.hostTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
};

/** Asked right after the persona basics (the wake-up chat asks it itself). Empty keeps the host's zone. */
export async function timezoneStep(p: Prompter, st: State, deps: SetupDeps): Promise<void> {
  const zone = await p.text({
    id: 'timezone',
    message: 'Which time zone are you in?',
    help: 'Garnet shows when each message was sent and runs reminders in it. Use a name like Europe/London; empty uses this machine’s zone.',
    default: st.config.timezone ?? hostZone(deps),
    auto: st.config.timezone ?? '',
    validate: (v) => (v === '' || validTimeZone(v) ? null : 'That is not a time zone name (try Europe/London or America/New_York).'),
  });
  const next = { ...st.config };
  if (zone) next.timezone = zone;
  else delete next.timezone;
  st.config = next;
}

const money = (n: number): string => `$${n}`;

export async function preferencesStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  heading(io, deps.style, 'Limits and dashboard');
  const c = st.config;
  const provider = activeProvider(c).model.provider;
  // A demo model costs nothing and a local server rarely bills; the cap is for hosted providers.
  if (provider !== 'fake' && !isLocal(c)) {
    const cap = await p.text({
      id: 'daily-limit',
      message: 'Most you want Garnet to spend in a day, in US dollars? (empty for no cap)',
      help: 'Once today’s known cost reaches it, new chat turns and agent jobs are refused until tomorrow.',
      default: c.budgets.dailyUsd === undefined ? '' : String(c.budgets.dailyUsd),
      auto: c.budgets.dailyUsd === undefined ? '' : String(c.budgets.dailyUsd),
      validate: (v) => (v === '' || (Number.isFinite(Number(v)) && Number(v) > 0) ? null : 'Enter a positive number, like 5.'),
    });
    const budgets = { ...c.budgets };
    if (cap === '') delete budgets.dailyUsd;
    else budgets.dailyUsd = Number(cap);
    st.config = { ...st.config, budgets };
  }
  const on = st.config.api.enabled && st.config.dashboard.enabled;
  const dash = await p.confirm({
    id: 'dashboard',
    message: 'Turn on the web dashboard?',
    help: 'Sessions, usage and settings in a browser. It stays on this machine (loopback). `garnet dashboard` prints a one-time login link.',
    default: on,
    auto: on,
  });
  if (dash) st.config = { ...st.config, api: { ...st.config.api, enabled: true }, dashboard: { enabled: true } };
  else if (on) st.config = { ...st.config, dashboard: { enabled: false } };
  st.config = parseConfig({ ...st.config, version: CONFIG_VERSION });
}

function isLocal(c: GarnetConfig): boolean {
  const m = activeProvider(c).model;
  return m.provider === 'openai-compatible' && Boolean(m.baseUrl) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(m.baseUrl!).hostname);
}

export const preferencesSummary = (c: GarnetConfig): string =>
  [c.budgets.dailyUsd === undefined ? 'no daily cap' : `${money(c.budgets.dailyUsd)} a day`, c.api.enabled && c.dashboard.enabled ? 'dashboard on' : 'dashboard off'].join(' · ');
