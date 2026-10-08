// How the config browser presents each top-level section: a plain title, a one-line blurb and a live summary
// of its current state, in the order a new owner is likely to want them. Sections the schema gains later and
// that are not listed here still appear (after these, titled by their key), so this table is polish, not a gate.
import type { GarnetConfig } from '../../config/index.ts';
import { GENERAL } from './config-fields.ts';

export type SectionInfo = {
  title: string;
  blurb: string;
  /** One line about the current state; omitted sections show their setting count. */
  summary?: (c: GarnetConfig) => string;
};

const list = (xs: readonly string[]): string => (xs.length ? xs.join(', ') : 'none');
const onOff = (b: boolean): string => (b ? 'on' : 'off');

const permissionCounts = (c: GarnetConfig): string => {
  const v = Object.values(c.permissions);
  return (['allow', 'ask', 'deny'] as const).map((k) => `${v.filter((x) => x === k).length} ${k}`).join(' · ');
};

export const SECTION_INFO: Record<string, SectionInfo> = {
  [GENERAL]: {
    title: 'General',
    blurb: 'Your time zone, the workspace folder, the provider in use, extra standing instructions, jobs and routes.',
    summary: (c) => `${c.timezone ?? 'host time zone'} · provider ${c.activeProvider}`,
  },
  model: {
    title: 'Model',
    blurb: 'The main model: which provider, which model, its key by name, price and limits.',
    summary: (c) => `${c.model.provider} · ${c.model.name}`,
  },
  permissions: {
    title: 'Permissions',
    blurb: 'What Garnet may do: allow, ask you first, or deny, for each kind of action.',
    summary: permissionCounts,
  },
  containment: {
    title: 'Safety',
    blurb: 'After Garnet reads untrusted content, risky actions ask first even where they are allowed.',
    summary: (c) => `containment ${onOff(c.containment.enabled)}`,
  },
  web: { title: 'Web', blurb: 'Web search backend, hosts that need no approval and fetch limits.', summary: (c) => `search: ${c.web.search.backend} · ${c.web.allowHosts.length} allowed host${c.web.allowHosts.length === 1 ? '' : 's'}` },
  connectors: { title: 'Connectors', blurb: 'Calendar, GitHub and weather: which are on and how they are set up.', summary: (c) => list(c.connectors.enabled) },
  skills: { title: 'Skills', blurb: 'Built-in skills that are switched on.', summary: (c) => list(c.skills.enabled) },
  channels: {
    title: 'Channels',
    blurb: 'Telegram, Discord and Signal: which are connected, and the names of their tokens.',
    summary: (c) => list((['telegram', 'discord', 'signal'] as const).filter((n) => c.channels[n].enabled)),
  },
  media: { title: 'Files and voice', blurb: 'Photos, documents and voice notes: size limits and speech to text.', summary: (c) => `voice notes ${c.media.transcription.backend === 'none' ? 'off' : c.media.transcription.backend}` },
  sandbox: { title: 'Command sandbox', blurb: 'Where shell commands run: Docker, another machine over ssh, or this machine.', summary: (c) => c.sandbox.backend },
  budgets: {
    title: 'Limits and budgets',
    blurb: 'Per-task limits on model calls, tokens and time, and an optional daily spending cap.',
    summary: (c) => (c.budgets.dailyUsd === undefined ? 'no daily cap' : `$${c.budgets.dailyUsd} a day`),
  },
  api: { title: 'HTTP API', blurb: 'The opt-in API server: address, rate limits and the public demo.', summary: (c) => (c.api.enabled ? `${c.api.host}:${c.api.port}` : 'off') },
  dashboard: { title: 'Dashboard', blurb: 'The web dashboard, served by the API.', summary: (c) => onOff(c.dashboard.enabled) },
  scheduler: { title: 'Scheduler', blurb: 'The switch and pace for scheduled jobs.', summary: (c) => `scheduler ${onOff(c.scheduler.enabled)} · ${c.jobs.length} job${c.jobs.length === 1 ? '' : 's'}` },
  context: { title: 'Context', blurb: 'When older turns are summarized to save tokens.' },
  memory: { title: 'Memory', blurb: 'Size caps for MEMORY.md and USER.md.' },
  gateway: { title: 'Gateway', blurb: 'How many tasks run at once, pairing codes and proactive message limits.' },
  retention: { title: 'Retention', blurb: 'How long finished operational records are kept.' },
  chat: { title: 'Terminal chat', blurb: 'Fullscreen and mouse behavior of `garnet chat`.' },
};

/** Sections in the order shown: the table's order first, then any others in schema order. */
export function orderSections(found: readonly string[]): string[] {
  const known = Object.keys(SECTION_INFO).filter((k) => found.includes(k));
  return [...known, ...found.filter((k) => !known.includes(k))];
}

export const sectionTitle = (key: string): string => SECTION_INFO[key]?.title ?? key;
