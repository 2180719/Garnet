// The tools step: what Garnet is able to do at all (each ability maps to one permission), then the details
// of the abilities that were switched on: where web searches go, where commands run, how approvals work.
// Abilities that stay on keep their current setting (allow or ask); a newly enabled one starts at `ask`.
import { CONFIG_VERSION, parseConfig, type GarnetConfig } from '../../config/index.ts';
import type { Io } from '../main.ts';
import { approvalsStep } from './approvals.ts';
import type { Choice, Prompter } from './prompt.ts';
import { sandboxStep } from './sandbox.ts';
import { secretStep } from './secrets.ts';
import { heading, validUrl, type SetupDeps, type State } from './shared.ts';

type Permissions = GarnetConfig['permissions'];
export type Ability = 'web' | 'files' | 'memory' | 'reminders' | 'messages' | 'commands';

export const ABILITIES: { id: Ability; capability: keyof Permissions; label: string; hint: string }[] = [
  { id: 'web', capability: 'net.fetch', label: 'Look things up on the web', hint: 'web_search, web_fetch' },
  { id: 'files', capability: 'fs.write', label: 'Create and change files', hint: 'write_file, in its own workspace folder' },
  { id: 'memory', capability: 'memory.write', label: 'Remember things between chats', hint: 'memory: notes about you and its own notes' },
  { id: 'reminders', capability: 'schedule.edit', label: 'Set reminders and scheduled jobs', hint: 'schedule: it can wake itself up later' },
  { id: 'messages', capability: 'message.send', label: 'Message you on its own', hint: 'send_message, only to chats you have paired' },
  { id: 'commands', capability: 'exec', label: 'Run shell commands', hint: 'run_command, in a sandbox · off unless you tick it' },
];

/** Which abilities a permissions block turns on (anything but `deny`). */
export const enabledAbilities = (perms: Permissions): Ability[] => ABILITIES.filter((a) => perms[a.capability] !== 'deny').map((a) => a.id);

/** Ticked abilities stay as they are (or start at `ask`); unticked ones are denied. */
export function applyAbilities(perms: Permissions, picked: readonly Ability[]): Permissions {
  const next = { ...perms };
  for (const a of ABILITIES) {
    if (!picked.includes(a.id)) next[a.capability] = 'deny';
    else if (next[a.capability] === 'deny') next[a.capability] = 'ask';
  }
  return next;
}

const SEARCH_BACKENDS: (Choice<GarnetConfig['web']['search']['backend']> & { keyEnv?: string; keyHelp?: string })[] = [
  { value: 'duckduckgo', label: 'DuckDuckGo', hint: 'no key; reads its results page, so it can be rate limited' },
  { value: 'brave', label: 'Brave Search', hint: 'API key · api.search.brave.com', keyEnv: 'BRAVE_API_KEY', keyHelp: 'Create one at https://api-dashboard.search.brave.com/' },
  { value: 'tavily', label: 'Tavily', hint: 'API key · tavily.com', keyEnv: 'TAVILY_API_KEY', keyHelp: 'Create one at https://app.tavily.com/' },
  { value: 'searxng', label: 'My own SearXNG', hint: 'an instance you run; it must allow format=json' },
  { value: 'none', label: 'No web search', hint: 'Garnet can still read pages you give it' },
];

async function searchStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const cur = st.config.web.search;
  const backend = await p.select({
    id: 'web-search',
    message: 'Where should web searches go?',
    choices: SEARCH_BACKENDS,
    default: cur.backend,
    auto: cur.backend,
  });
  const search = { ...cur, backend };
  const spec = SEARCH_BACKENDS.find((c) => c.value === backend);
  if (backend === 'searxng') {
    search.searxngUrl = await p.text({ id: 'searxng-url', message: 'Address of your SearXNG instance', help: 'For example http://127.0.0.1:8888', ...(cur.searxngUrl ? { default: cur.searxngUrl } : {}), validate: validUrl });
  }
  if (spec?.keyEnv) {
    const name = cur.apiKeyEnv ?? spec.keyEnv;
    search.apiKeyEnv = name;
    await secretStep(p, io, deps, st, { id: 'web-search-key', name, label: `${spec.label} API key`, help: spec.keyHelp ?? '', required: true }, false);
  }
  st.config = { ...st.config, web: { ...st.config.web, search } };
}

export async function toolsStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  heading(io, s, 'Tools');
  io.out(`  ${s.muted('Switch on what Garnet may do. Anything you tick still asks first, until you say otherwise.')}\n`);
  const current = enabledAbilities(st.config.permissions);
  const picked = await p.multiselect<Ability>({
    id: 'tools',
    message: 'What should Garnet be able to do?',
    help: 'Unticked things are switched off completely. You can turn them on later with `garnet setup`.',
    choices: ABILITIES.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
    default: current,
  });
  const wasOn = current;
  st.config = { ...st.config, permissions: applyAbilities(st.config.permissions, picked) };
  if (picked.includes('web')) await searchStep(p, io, deps, st);
  if (picked.includes('commands')) {
    if (!wasOn.includes('commands')) io.out(`  ${s.muted('Commands stay in a sandbox. Docker needs to be installed; `garnet sandbox check` tests it.')}\n`);
    st.config = { ...st.config, sandbox: await sandboxStep(p, st.config.sandbox) };
  }
  await approvalsStep(p, io, deps, st);
  // A change to the permissions must still be a valid config.
  st.config = parseConfig({ ...st.config, version: CONFIG_VERSION });
}

/** One line for the summary: the abilities that are on, with their setting, and a note when commands are off. */
export function toolsSummary(c: GarnetConfig): string {
  const on = ABILITIES.filter((a) => c.permissions[a.capability] !== 'deny').map((a) => `${a.id} (${c.permissions[a.capability]}${a.id === 'commands' ? `, ${c.sandbox.backend}` : ''})`);
  return on.length ? on.join(', ') : 'nothing: every tool is off';
}

