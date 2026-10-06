// `garnet skills|connectors list|enable|disable|reset|effective [--channel <scope>]`:
// the optional built-ins, globally or per channel / conversation scope. Edits
// config.json only (validated before it is written); a running service picks
// changes up after a restart, and each conversation keeps the set it started with.
import { parseArgs } from 'node:util';
import {
  BUILTIN_SKILLS,
  CONNECTORS,
  SCOPE_HELP,
  SCOPE_RE,
  loadConfig,
  parseConfig,
  resolveToggles,
  setToggle,
  writeConfig,
  type Effective,
  type GarnetConfig,
  type Toggles,
} from '../config/index.ts';
import { CONNECTOR_INFO } from '../connectors/index.ts';
import { scopesForConversation } from '../gateway/index.ts';
import { openSecretStore } from '../secrets/index.ts';
import { BuiltinSkills } from '../skills/index.ts';
import type { Io } from './main.ts';

export type Kind = 'skills' | 'connectors';

/** Subcommands of `garnet skills` that belong to the built-ins (the rest are about learned skills). */
export const BUILTIN_SKILL_SUBCOMMANDS: ReadonlySet<string> = new Set(['enable', 'disable', 'reset', 'effective', 'builtin']);

const USAGE: Record<Kind, string> = {
  skills: `Usage: garnet skills builtin [--channel <scope>]          Built-in optional skills and their state
       garnet skills enable|disable <name> [--channel <scope>]
       garnet skills reset <name> --channel <scope>       Drop a scope's override (inherit again)
       garnet skills effective [--channel <scope>]        What a conversation in that scope gets
  (learned skills: garnet skills list|show|proposal|accept|reject|archive|stale)
  <scope> is ${SCOPE_HELP}.
`,
  connectors: `Usage: garnet connectors list [--channel <scope>]
       garnet connectors enable|disable <name> [--channel <scope>]
       garnet connectors reset <name> --channel <scope>   Drop a scope's override (inherit again)
       garnet connectors effective [--channel <scope>]    What a conversation in that scope gets
  <scope> is ${SCOPE_HELP}.
`,
};

const NAMES: Record<Kind, readonly string[]> = { skills: BUILTIN_SKILLS, connectors: CONNECTORS };

/**
 * The scopes a conversation in `scope` resolves through, broadest first: the
 * same chain the runtime uses (`scopesForConversation`).
 */
export function scopeChain(scope: string | undefined, config: GarnetConfig): string[] {
  if (scope === undefined) return [];
  if (scope === 'cli') return ['cli'];
  const [head, ...rest] = scope.split(':');
  const id = rest.join(':');
  if (!id) return [head!];
  switch (head) {
    case 'route':
    case 'job':
      return scopesForConversation(scope, config.routes);
    case 'api':
      return scopesForConversation(`api:${id}:x`, config.routes);
    default:
      // telegram:<chatId> → the conversation of that chat (the account does not change the scopes).
      return scopesForConversation(`${head}:default:${id}`, config.routes);
  }
}

function describe(e: Effective): string {
  if (e.from === 'default') return 'off (default)';
  if (e.from === 'global') return 'on (global)';
  return `${e.on ? 'on' : 'off'} (${e.from} override)`;
}

/** Where a secret name is set, without reading its value when the environment has it. */
function secretStatus(name: string, home: string, env: NodeJS.ProcessEnv): string {
  if (env[name]) return 'set (environment)';
  try {
    const store = openSecretStore(home, env);
    if (!store.exists()) return 'not set';
    return store.names().includes(name) ? 'set (encrypted store)' : 'not set';
  } catch {
    return 'unknown (encrypted store locked)';
  }
}

/** The built-in skills table (also printed under `garnet skills list`). */
export function builtinSkillsReport(config: GarnetConfig, scope?: string, shadowed: (name: string) => boolean = () => false): string {
  const skills = new BuiltinSkills();
  const states = resolveToggles(BUILTIN_SKILLS, config.skills, scopeChain(scope, config));
  const lines = [`Built-in skills${scope ? ` for ${scope}` : ''} (off unless enabled; \`garnet skills enable <name> [--channel <scope>]\`):`];
  for (const e of states) {
    const s = skills.get(e.name);
    lines.push(`  ${e.name.padEnd(18)} ${describe(e).padEnd(30)} ${s?.description ?? ''}`);
    if (shadowed(e.name)) lines.push(`  ${''.padEnd(18)} ! a skill of the same name in your skills folder takes precedence`);
  }
  return `${lines.join('\n')}\n`;
}

function connectorsReport(config: GarnetConfig, home: string, env: NodeJS.ProcessEnv, scope?: string): string {
  const states = resolveToggles(CONNECTORS, config.connectors, scopeChain(scope, config));
  const lines = [`Connectors${scope ? ` for ${scope}` : ''} (off unless enabled; \`garnet connectors enable <name> [--channel <scope>]\`):`];
  for (const e of states) {
    const info = CONNECTOR_INFO[e.name as keyof typeof CONNECTOR_INFO];
    lines.push(`  ${e.name.padEnd(12)} ${describe(e).padEnd(30)} ${info.summary}`);
    const secrets = info.secrets(config.connectors).map((s) => `${s.name} ${secretStatus(s.name, home, env)}`);
    lines.push(`  ${''.padEnd(12)} tool ${info.tool}; needs ${info.needs(config.connectors).join(' + ')}; hosts ${info.hosts(config.connectors).join(', ')}${secrets.length ? `; secret ${secrets.join(', ')}` : ''}`);
  }
  if (config.permissions['net.fetch'] === 'deny') lines.push('  ! permissions.net.fetch is deny, so no connector is available until it is ask or allow.');
  return `${lines.join('\n')}\n`;
}

function effectiveReport(config: GarnetConfig, scope?: string): string {
  const show = (label: string, scopes: string[]): string[] => {
    const skills = resolveToggles(BUILTIN_SKILLS, config.skills, scopes).filter((e) => e.on).map((e) => e.name);
    const connectors = resolveToggles(CONNECTORS, config.connectors, scopes).filter((e) => e.on).map((e) => e.name);
    const off = config.permissions['net.fetch'] === 'deny' && connectors.length ? ' (unavailable: net.fetch is deny)' : '';
    return [`${label}${scopes.length ? ` [${scopes.join(' > ')}]` : ''}:`, `  skills:     ${skills.join(', ') || 'none'}`, `  connectors: ${connectors.join(', ') || 'none'}${off}`];
  };
  if (scope !== undefined) return `${show(`A new conversation in ${scope} gets`, scopeChain(scope, config)).join('\n')}\n`;
  const scopes = [...new Set([...Object.keys(config.skills.channels), ...Object.keys(config.connectors.channels)])].sort();
  const lines = show('Everywhere without an override', []);
  for (const s of scopes) lines.push(...show(s, scopeChain(s, config)));
  return `${lines.join('\n')}\n`;
}

/** A scope the CLI was given: validated against the same pattern config uses. */
function checkScope(scope: string | undefined): string | null {
  if (scope === undefined || SCOPE_RE.test(scope)) return null;
  return `"${scope}" is not a scope. Use ${SCOPE_HELP}.`;
}

function notes(kind: Kind, name: string, config: GarnetConfig, home: string, env: NodeJS.ProcessEnv, scope: string | undefined): string[] {
  const out: string[] = [];
  if (scope) {
    const channel = scope.split(':')[0]!;
    if ((channel === 'telegram' || channel === 'discord' || channel === 'signal') && !config.channels[channel].enabled) out.push(`Note: channels.${channel} is not enabled, so this override has no effect yet.`);
    if (channel === 'api' && !config.api.enabled) out.push('Note: the API is not enabled (`garnet api enable`), so this override has no effect yet.');
    if (channel === 'route' && !config.routes.some((r) => `route:${r.conversation}` === scope)) out.push(`Note: no route in config.json uses the conversation "${scope.slice(6)}".`);
  }
  if (kind === 'connectors') {
    const info = CONNECTOR_INFO[name as keyof typeof CONNECTOR_INFO];
    if (config.permissions['net.fetch'] === 'deny') out.push('Warning: permissions.net.fetch is deny, so connectors are not available. Set it to ask (or allow) in config.json.');
    for (const s of info.secrets(config.connectors)) {
      const status = secretStatus(s.name, home, env);
      if (status === 'not set') out.push(`${s.required ? 'Warning' : 'Note'}: ${s.name} is not set (${s.why}). Store it with \`garnet secrets set ${s.name}\`.`);
    }
    if (info.needs(config.connectors).includes('message.send') && config.permissions['message.send'] === 'deny') out.push('Note: permissions.message.send is deny, so GitHub comments will be refused.');
    if (config.permissions['net.fetch'] === 'ask') out.push(`Each call asks for approval while net.fetch is ask; add ${info.hosts(config.connectors).join(' and ')} to web.allowHosts to skip that (conversations that read untrusted content still ask).`);
  }
  return out;
}

export async function extensionsCommand(kind: Kind, args: string[], io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values, positionals } = parseArgs({ args, options: { channel: { type: 'string' } }, allowPositionals: true });
  const [sub = 'list', name, extra] = positionals;
  const scope = values.channel;
  const bad = checkScope(scope);
  if (bad) {
    io.err(`${bad}\n`);
    return 2;
  }
  const { config, paths } = loadConfig();
  switch (sub) {
    case 'list':
    case 'builtin':
      if (name) break;
      io.out(kind === 'skills' ? builtinSkillsReport(config, scope) : connectorsReport(config, paths.home, env, scope));
      return 0;
    case 'effective':
      if (name) break;
      io.out(effectiveReport(config, scope));
      return 0;
    case 'enable':
    case 'disable':
    case 'reset': {
      if (!name || extra) break;
      if (!NAMES[kind].includes(name)) {
        io.err(`No built-in ${kind === 'skills' ? 'skill' : 'connector'} named "${name}". Available: ${NAMES[kind].join(', ')}.\n`);
        return 2;
      }
      if (sub === 'reset' && scope === undefined) {
        io.err(`reset drops a scope's override: give --channel <scope>. To turn ${name} off everywhere, use \`garnet ${kind} disable ${name}\`.\n`);
        return 2;
      }
      const before: Toggles = config[kind];
      const after = setToggle(before, name, sub === 'reset' ? null : sub === 'enable', scope);
      // Validated like any config before it is written: nothing invalid ever reaches config.json.
      const next = parseConfig(JSON.parse(JSON.stringify({ ...config, [kind]: { ...config[kind], ...after } })));
      writeConfig(paths.home, next);
      const state = resolveToggles(NAMES[kind], next[kind], scopeChain(scope, next)).find((e) => e.name === name)!;
      const where = scope ? `for ${scope}` : 'globally';
      const verb = sub === 'reset' ? `Removed the ${scope} override for ${name}` : `${sub === 'enable' ? 'Enabled' : 'Disabled'} ${name} ${where}`;
      io.out(`${verb}. ${scope ? `In ${scope} it is now ${describe(state)}.` : `It is now ${describe(state)} where no override says otherwise.`}\n`);
      if (sub === 'enable') for (const n of notes(kind, name, next, paths.home, env, scope)) io.out(`${n}\n`);
      io.out('Running Garnet picks this up after a restart (`garnet service restart`); each conversation keeps the set it started with until /new.\n');
      return 0;
    }
  }
  io.err(USAGE[kind]);
  return 2;
}
