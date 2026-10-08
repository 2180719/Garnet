// Connectors (calendar, GitHub, weather) and the optional built-in skills. Each connector is one entry in
// CONNECTOR_STEPS: its questions, and the secret it needs by name. Keys and feed addresses go through
// `secretStep`, so they end up in the encrypted store or <home>/env and never in config.
import { BUILTIN_SKILLS, CONFIG_VERSION, CONNECTORS, parseConfig, type BuiltinSkillName, type ConnectorName, type GarnetConfig } from '../../config/index.ts';
import { CONNECTOR_INFO } from '../../connectors/index.ts';
import type { Io } from '../main.ts';
import type { Prompter } from './prompt.ts';
import { secretStep } from './secrets.ts';
import { heading, type SetupDeps, type State } from './shared.ts';

type Connectors = GarnetConfig['connectors'];

type ConnectorSpec = {
  label: string;
  /** Asks this connector's questions and returns its settings; secrets are collected on the way. */
  setup: (p: Prompter, io: Io, deps: SetupDeps, st: State) => Promise<Connectors>;
};

const CONNECTOR_STEPS: Record<ConnectorName, ConnectorSpec> = {
  calendar: {
    label: 'Calendar',
    setup: async (p, io, deps, st) => {
      const c = st.config.connectors;
      io.out('  Garnet reads your calendar from its private feed address (read-only).\n  Google Calendar: Settings → your calendar → Integrate calendar → "Secret address in iCal format".\n  iCloud, Fastmail, Outlook and Nextcloud have the same kind of link.\n');
      await secretStep(p, io, deps, st, { id: 'calendar-url', name: c.calendar.urlEnv, label: 'calendar feed address', help: 'It looks like https://…/basic.ics and works like a password, so it is stored like a key.', required: true }, false);
      return c;
    },
  },
  github: {
    label: 'GitHub',
    setup: async (p, io, deps, st) => {
      const c = st.config.connectors;
      io.out('  A fine-grained token with read access to issues and pull requests works best: https://github.com/settings/personal-access-tokens\n  Public repositories need no token.\n');
      await secretStep(p, io, deps, st, { id: 'github-token', name: c.github.tokenEnv, label: 'GitHub token', help: 'Press Enter to skip it and use public repositories only.', required: false }, false);
      const repos = await p.text({
        id: 'github-repos',
        message: 'Which repositories may Garnet look at? (owner/name, or owner/*, separated by commas)',
        help: 'Leave empty to allow any repository the token can reach.',
        default: c.github.repos.join(', '),
        auto: c.github.repos.join(', '),
        validate: (v) => {
          const bad = splitList(v).find((r) => !/^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/.test(r));
          return bad ? `"${bad}" is not owner/name or owner/*.` : null;
        },
      });
      const write = await p.confirm({
        id: 'github-write',
        message: 'May Garnet comment on issues and pull requests?',
        help: 'Commenting needs permission to send messages, and asks first unless you allowed that.',
        default: c.github.write,
        auto: c.github.write,
      });
      return { ...c, github: { ...c.github, repos: splitList(repos), write } };
    },
  },
  weather: {
    label: 'Weather',
    setup: async (p, io, deps, st) => {
      const c = st.config.connectors;
      const location = await p.text({
        id: 'weather-location',
        message: 'Where should forecasts be for, by default?',
        help: 'A town or city, like "Lisbon". It is sent to Open-Meteo to look up. Leave empty to be asked each time.',
        default: c.weather.location ?? '',
        auto: c.weather.location ?? '',
        validate: (v) => (v.length <= 100 ? null : 'Keep it under 100 characters.'),
      });
      const units = await p.select({
        id: 'weather-units',
        message: 'Which units?',
        choices: [
          { value: 'metric', label: 'Metric', hint: '°C, km/h, mm' },
          { value: 'imperial', label: 'Imperial', hint: '°F, mph, inch' },
        ],
        default: c.weather.units,
        auto: c.weather.units,
      });
      const { location: _old, ...rest } = c.weather;
      return { ...c, weather: { ...rest, units, ...(location ? { location } : {}) } };
    },
  },
};

const SKILL_HINTS: Record<BuiltinSkillName, string> = {
  'daily-briefing': 'a short morning summary · uses calendar and weather',
  'github-triage': 'what needs your attention on GitHub · needs the GitHub connector',
  'web-research': 'sourced answers to questions that need current facts · needs web access',
};

/** The names of `all` that appear in `xs` (config stores the toggle lists as plain strings). */
const only = <T extends string>(all: readonly T[], xs: readonly string[]): T[] => all.filter((a) => xs.includes(a));

const splitList = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Connectors need to fetch over the network. When the owner switched web access off, a person is asked whether
 * to turn it back on (to `ask`); a script never raises a permission, it only says what is missing.
 */
async function allowFetching(p: Prompter, io: Io, deps: SetupDeps, st: State, label: string): Promise<void> {
  if (st.config.permissions['net.fetch'] !== 'deny') return;
  const s = deps.style;
  if (p.interactive && (await p.confirm({ id: 'connector-web', message: `${label} needs web access, which is off. Turn it back on? (it asks first)`, default: true }))) {
    st.config = { ...st.config, permissions: { ...st.config.permissions, 'net.fetch': 'ask' } };
    return;
  }
  io.out(`  ${s.warn('!')} ${label} needs web access, which is off.\n`);
  st.todo.push(`${label} will not work until web access is on (permissions.net.fetch is deny).`);
}

export async function integrationsStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  heading(io, s, 'Connections and skills');
  io.out(`  ${s.muted('Connectors give Garnet one more tool each. They are off until you tick them.')}\n`);
  const picked = await p.multiselect<ConnectorName>({
    id: 'connectors',
    message: 'Which services should Garnet be connected to?',
    help: 'Pick as many as you like, or none.',
    choices: CONNECTORS.map((n) => ({ value: n, label: CONNECTOR_STEPS[n].label, hint: CONNECTOR_INFO[n].summary.replace(/\.$/, '') })),
    default: only(CONNECTORS, st.config.connectors.enabled),
  });
  const dropped = st.config.connectors.enabled.filter((n) => !(picked as string[]).includes(n));
  st.config = { ...st.config, connectors: { ...st.config.connectors, enabled: [...picked] } };
  if (dropped.length) io.out(`  ${s.muted(`Turned off ${dropped.join(', ')}. Its secret stays where it is.`)}\n`);
  for (const [i, name] of picked.entries()) {
    if (picked.length > 1) io.out(`\n${s.bold(`${CONNECTOR_STEPS[name].label} (${i + 1} of ${picked.length})`)}\n`);
    await allowFetching(p, io, deps, st, CONNECTOR_STEPS[name].label);
    st.config = { ...st.config, connectors: await CONNECTOR_STEPS[name].setup(p, io, deps, st) };
  }

  const skills = await p.multiselect<BuiltinSkillName>({
    id: 'skills',
    message: 'Which built-in skills do you want?',
    help: 'Skills are instructions for a kind of task. Garnet also writes its own, which are always on.',
    choices: BUILTIN_SKILLS.map((n) => ({ value: n, label: n, hint: SKILL_HINTS[n] })),
    default: only(BUILTIN_SKILLS, st.config.skills.enabled),
  });
  st.config = { ...st.config, skills: { ...st.config.skills, enabled: [...skills] } };
  if (skills.includes('github-triage') && !picked.includes('github')) io.out(`  ${s.warn('!')} github-triage needs the GitHub connector, which is off.\n`);
  if (skills.includes('web-research') && st.config.permissions['net.fetch'] === 'deny') io.out(`  ${s.warn('!')} web-research needs web access, which is off.\n`);
  st.config = parseConfig({ ...st.config, version: CONFIG_VERSION });
}

/** Summary lines: the connectors and skills that are on. */
export function integrationsSummary(c: GarnetConfig): { connectors: string; skills: string } {
  return { connectors: c.connectors.enabled.join(', ') || 'none', skills: c.skills.enabled.join(', ') || 'none' };
}
