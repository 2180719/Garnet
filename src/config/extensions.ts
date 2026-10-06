// Optional built-ins: which built-in skills and connectors are on, globally and
// per channel or conversation scope. Pure functions over config; the runtime
// resolves a session's set once (see src/runtime) and the CLI edits config with
// `setToggle`.

/** Built-in optional skills shipped in src/skills/builtin (a test keeps this list and the folders in sync). */
export const BUILTIN_SKILLS = ['daily-briefing', 'github-triage', 'web-research'] as const;
export type BuiltinSkillName = (typeof BUILTIN_SKILLS)[number];

/** Built-in connectors in src/connectors. */
export const CONNECTORS = ['calendar', 'github', 'weather'] as const;
export type ConnectorName = (typeof CONNECTORS)[number];

/**
 * A scope an override can name, from broad to narrow:
 * - a channel or surface: `telegram`, `discord`, `signal`, `api` (HTTP API and dashboard), `cli` (terminal chat), `job` (scheduled runs);
 * - one chat on a channel: `telegram:<chatId>` (Signal groups: `signal:group:<id>`);
 * - one API key: `api:<keyId>`; one scheduled job: `job:<id>`;
 * - a shared conversation from `routes`: `route:<name>`.
 */
export const SCOPE_RE = /^(?:(?:telegram|discord|signal):[^\s]{1,200}|telegram|discord|signal|api(?::[A-Za-z0-9_-]{1,64})?|cli|job(?::[a-z0-9-]{1,40})?|route:[a-z0-9-]{1,40})$/;

export const SCOPE_HELP =
  'a channel (telegram, discord, signal, api, cli, job), one chat (telegram:<chatId>), one API key (api:<keyId>), one job (job:<id>) or a shared conversation from routes (route:<name>)';

export type Override = { enable: string[]; disable: string[] };
/** The config shape shared by `skills` and `connectors`. */
export type Toggles = { enabled: string[]; channels: Record<string, Override> };

/** One item's effective state in a scope, and which setting decided it. */
export type Effective = { name: string; on: boolean; from: 'default' | 'global' | string };

/**
 * Effective state of every name for a session whose scopes are `scopes`
 * (broadest first, e.g. `['telegram', 'telegram:42']`). Start from the global
 * list; each scope's override then turns names off (`disable`) or on
 * (`enable`), the narrowest scope winning. Unknown scopes have no override.
 */
export function resolveToggles(names: readonly string[], toggles: Toggles, scopes: readonly string[]): Effective[] {
  return names.map((name) => {
    let state: Effective = toggles.enabled.includes(name) ? { name, on: true, from: 'global' } : { name, on: false, from: 'default' };
    for (const scope of scopes) {
      const o = toggles.channels[scope];
      if (!o) continue;
      if (o.disable.includes(name)) state = { name, on: false, from: scope };
      else if (o.enable.includes(name)) state = { name, on: true, from: scope };
    }
    return state;
  });
}

/** The names that are on for these scopes, sorted. */
export function activeNames(names: readonly string[], toggles: Toggles, scopes: readonly string[]): string[] {
  return resolveToggles(names, toggles, scopes)
    .filter((e) => e.on)
    .map((e) => e.name)
    .sort();
}

/** Names that are on anywhere: globally or in any scope's `enable`. */
export function enabledAnywhere(toggles: Toggles): string[] {
  return [...new Set([...toggles.enabled, ...Object.values(toggles.channels).flatMap((o) => o.enable)])].sort();
}

/**
 * Returns new toggles with `name` switched on (`true`), off (`false`) or back
 * to inheriting (`null`), globally or in one scope. A scope entry left with no
 * overrides is removed. Never mutates its input.
 */
export function setToggle(toggles: Toggles, name: string, on: boolean | null, scope?: string): Toggles {
  const without = (list: readonly string[]) => list.filter((n) => n !== name);
  const withName = (list: readonly string[]) => [...new Set([...list, name])].sort();
  if (scope === undefined) {
    return { enabled: on ? withName(toggles.enabled) : without(toggles.enabled), channels: { ...toggles.channels } };
  }
  const current = toggles.channels[scope] ?? { enable: [], disable: [] };
  const next: Override =
    on === null
      ? { enable: without(current.enable), disable: without(current.disable) }
      : on
        ? { enable: withName(current.enable), disable: without(current.disable) }
        : { enable: without(current.enable), disable: withName(current.disable) };
  const channels = { ...toggles.channels };
  if (next.enable.length || next.disable.length) channels[scope] = next;
  else delete channels[scope];
  return { enabled: [...toggles.enabled], channels };
}
