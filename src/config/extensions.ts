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

/**
 * The scopes a conversation resolves through. A chat, API key, job or the
 * terminal has one chain, broadest first (`scopes`). A shared conversation
 * from `routes` has its own scope (`scopes: ['route:<name>']`) and `feeds`:
 * the chain of every chat or channel linked into it (`['telegram',
 * 'telegram:42']`, or just `['telegram']` for a channel-wide route).
 */
export type ConversationScopes = { scopes: readonly string[]; feeds?: readonly (readonly string[])[] };

/**
 * Effective state of every name for a conversation: the one resolver the
 * runtime and the CLI share. One chain resolves like `resolveToggles` (the
 * narrowest scope wins). A shared conversation (`feeds` set) is safe by
 * default, because several chats read and drive it:
 * 1. a `disable` in any scope that feeds it (a channel or chat linked into the
 *    route) or in the route's own scope turns the name off;
 * 2. otherwise the route's own `enable` turns it on;
 * 3. otherwise it is on only when it is on for every feeding chain (global
 *    list, then that chain's channel and chat enables).
 */
export function resolveScopes(names: readonly string[], toggles: Toggles, scopes: ConversationScopes | readonly string[]): Effective[] {
  const cs = asScopes(scopes);
  if (!cs.feeds) return resolveToggles(names, toggles, cs.scopes);
  const feeds = cs.feeds.length ? cs.feeds : [[]];
  const all = [...feeds.flat(), ...cs.scopes];
  const perFeed = feeds.map((chain) => resolveToggles(names, toggles, chain));
  return names.map((name, i) => {
    const disabledBy = all.find((s) => toggles.channels[s]?.disable.includes(name));
    if (disabledBy) return { name, on: false, from: disabledBy };
    const enabledBy = cs.scopes.find((s) => toggles.channels[s]?.enable.includes(name));
    if (enabledBy) return { name, on: true, from: enabledBy };
    const states = perFeed.map((r) => r[i]!);
    return states.find((e) => !e.on) ?? states[0]!;
  });
}

/** A plain chain (broadest first) as `ConversationScopes`. */
export function asScopes(scopes: ConversationScopes | readonly string[]): ConversationScopes {
  return isChain(scopes) ? { scopes } : scopes;
}

function isChain(scopes: ConversationScopes | readonly string[]): scopes is readonly string[] {
  return Array.isArray(scopes);
}

/** How a conversation's scopes read in CLI output: `telegram > telegram:42`, or for a route its own scope and what feeds it. */
export function describeScopes(cs: ConversationScopes): string {
  const own = cs.scopes.join(' > ');
  if (!cs.feeds) return own;
  return `${own}, fed by ${cs.feeds.length ? cs.feeds.map((f) => f.join(' > ')).join('; ') : 'no chat'}`;
}

/** The names that are on for these scopes, sorted. */
export function activeNames(names: readonly string[], toggles: Toggles, scopes: ConversationScopes | readonly string[]): string[] {
  return resolveScopes(names, toggles, scopes)
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
