// planImport: a pure read of an OpenClaw or Hermes Agent home directory. Nothing is written or executed;
// all text read from the source is treated as untrusted data. The OpenClaw state database is opened read-only.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { validTimeZone } from '../config/index.ts';
import { DEFAULT_LIMITS, MAX_ENTRY_CHARS, injectionReason } from '../memory/index.ts';
import { MAX_BODY, MAX_DESCRIPTION, NAME_RE } from '../skills/index.ts';
import { hermesJobs, openclawJobs, type DeliveryHints } from './jobs.ts';
import { isRecord, tryJson5 } from './json5.ts';
import { readOpenClawState } from './openclaw-state.ts';
import { makeScanner, type Scanner } from './safefs.ts';
import { emptyRequirements, frontmatterRequirements, hermesDirHash, missingTools, onPath, rewriteBaseDir, usesShell } from './skillreq.ts';
import type { ImportPlan, MemoryAction, PairingAction, PersonaAction, PlanOptions, SkillAction, Source } from './types.ts';

export const PERSONA_MAX = 4000;
/** The schema's upper bound for memory.memoryChars and memory.userChars. */
export const MEMORY_CAP_MAX = 20_000;
const MAX_SKILL_DEPTH = 4;
const CHANNELS = ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'matrix', 'msteams', 'googlechat', 'irc', 'line', 'email'];
const RUBY_CHANNELS = ['telegram', 'discord', 'signal'] as const;
type RubyChannel = (typeof RUBY_CHANNELS)[number];
/** Tools Ruby registers by default (used when the caller does not pass the live list). */
const DEFAULT_TOOLS = ['list_files', 'read_file', 'write_file', 'memory', 'skill_view', 'skill_create', 'skill_update', 'read_artifact'];
/** Hermes .env keys whose values are IDs, not secrets: read so senders can be paired and jobs delivered. */
const ID_KEY = /^([A-Z]+)_(ALLOWED_USERS|HOME_CHANNEL)$/;

/**
 * Default source home for a source (`--from` overrides). Honors OPENCLAW_STATE_DIR / OPENCLAW_PROFILE
 * (`~/.openclaw-<profile>`) and HERMES_HOME, as the tools themselves do.
 */
export function defaultSourceDir(source: Source, home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  if (source === 'hermes') return env.HERMES_HOME?.trim() ? expandHome(env.HERMES_HOME.trim(), home) : join(home, '.hermes');
  if (env.OPENCLAW_STATE_DIR?.trim()) return expandHome(env.OPENCLAW_STATE_DIR.trim(), home);
  const profile = env.OPENCLAW_PROFILE?.trim();
  return join(home, profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw');
}

function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

// eslint-disable-next-line no-control-regex
const stripControl = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/** Lowercase, hyphenate, and cut to Ruby's skill-name rules. Returns null if nothing usable remains. */
export function normalizeSkillName(raw: string): string | null {
  const n = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return NAME_RE.test(n) ? n : null;
}

/** Per-plan context shared by the helpers. */
type Ctx = {
  plan: ImportPlan;
  /** The source home. */
  sc: Scanner;
  /** Where workspace content is read from: `sc`, or its own scanner when the workspace lives elsewhere. */
  ws: Scanner;
  opts: PlanOptions;
  /** Where each memory action was read from (for archiving the full original). */
  memSources: Map<MemoryAction, { scanner: Scanner; abs: string }>;
};

export function planImport(source: Source, fromDir: string, opts: PlanOptions = {}): ImportPlan {
  if (source !== 'openclaw' && source !== 'hermes') throw new Error(`Unknown source "${String(source)}": use openclaw or hermes.`);
  let sc: Scanner;
  try {
    sc = makeScanner(fromDir);
  } catch {
    throw new Error(`Source directory not found: ${fromDir}`);
  }
  if (!sc.isDir(sc.root)) throw new Error(`Source is not a directory: ${fromDir}`);
  const ctx: Ctx = { plan: emptyPlan(source, fromDir), sc, ws: sc, opts, memSources: new Map() };
  if (source === 'openclaw') planOpenClaw(ctx);
  else planHermes(ctx);
  finish(ctx);
  return ctx.plan;
}

// ---- OpenClaw ----

function planOpenClaw(ctx: Ctx): void {
  const { plan, sc } = ctx;
  const env = ctx.opts.env ?? {};
  const cfgText = sc.readText(join(sc.root, 'openclaw.json'));
  const cfg = cfgText === null ? null : tryJson5(cfgText);
  if (cfgText !== null && !isRecord(cfg)) plan.warnings.push('openclaw.json could not be parsed; channel allowlists and the workspace setting in it were not read.');
  const conf = isRecord(cfg) ? cfg : {};

  // Workspace: OPENCLAW_WORKSPACE_DIR, then agents.defaults.workspace, then <home>/workspace, else --from itself.
  const agents = isRecord(conf.agents) ? conf.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const configured = env.OPENCLAW_WORKSPACE_DIR?.trim()
    ? { path: expandHome(env.OPENCLAW_WORKSPACE_DIR.trim()), why: 'OPENCLAW_WORKSPACE_DIR' }
    : typeof defaults.workspace === 'string' && defaults.workspace.trim()
      ? { path: expandHome(defaults.workspace.trim()), why: 'agents.defaults.workspace in openclaw.json' }
      : null;
  let content = sc.isDir(join(sc.root, 'workspace')) ? join(sc.root, 'workspace') : sc.root;
  if (configured) {
    const inside = isAbsolute(configured.path) ? configured.path : join(sc.root, configured.path);
    try {
      const ws = makeScanner(inside);
      if (!ws.isDir(ws.root)) throw new Error('not a directory');
      if (ws.root === sc.root || ws.root.startsWith(`${sc.root}/`)) content = ws.root;
      else {
        ctx.ws = ws;
        content = ws.root;
      }
      if (content !== join(sc.root, 'workspace')) plan.warnings.push(`Using the workspace from ${configured.why}: ${content}`);
    } catch {
      plan.warnings.push(`The workspace set by ${configured.why} (${configured.path}) was not found; reading ${content} instead. Use --from to point at the right place.`);
    }
  }
  plan.contentDir = content;
  const ws = ctx.ws;
  const r = (name: string) => join(content, name);
  const text = (name: string) => ws.readText(r(name));

  const mem = text('MEMORY.md');
  if (mem !== null) plan.memory.push(memoryAction(ctx, 'memory', ws, r('MEMORY.md'), parseMarkdownEntries(mem)));
  const usr = text('USER.md');
  if (usr !== null) plan.memory.push(memoryAction(ctx, 'user', ws, r('USER.md'), parseMarkdownEntries(usr)));

  const identity = text('IDENTITY.md');
  if (identity !== null) plan.name = identityName(identity);
  const personaParts: { file: string; label: string; text: string; optional: boolean }[] = [];
  for (const [file, label, optional] of [['SOUL.md', 'Soul', false], ['IDENTITY.md', 'Identity', false], ['AGENTS.md', 'Operating instructions', true]] as const) {
    const t = text(file);
    if (t !== null && t.trim()) personaParts.push({ file: relOf(ctx, ws, r(file)), label, text: t, optional });
  }
  plan.persona = buildPersona(personaParts, 'openclaw', plan.name);
  // Persona sources are always archived: the persona may be truncated or merged now or later.
  for (const file of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md']) if (text(file) !== null) addCopy(ctx, ws, r(file), 'persona source kept in full');

  for (const [file, why] of [
    ['HEARTBEAT.md', 'heartbeat checklist from an older OpenClaw (see the imported heartbeat job, if any)'],
    ['TOOLS.md', 'tool notes have no Ruby equivalent'],
    ['BOOTSTRAP.md', 'first-run script has no Ruby equivalent'],
  ] as const) {
    if (text(file) !== null) addCopy(ctx, ws, r(file), why);
  }
  const daily = join(content, 'memory');
  for (const e of ws.list(daily)) {
    if (!e.dir && e.name.endsWith('.md') && ws.readBuffer(join(daily, e.name)) !== null) addCopy(ctx, ws, join(daily, e.name), 'daily memory note (Ruby has no daily notes)');
  }
  for (const e of sc.list(sc.root)) {
    if (e.dir && /^workspace-.+/.test(e.name)) plan.warnings.push(`Found another agent workspace "${e.name}"; only the default workspace is imported. Run again with --from ${join(plan.fromDir, e.name)} to import it.`);
  }
  if (Array.isArray(agents.list)) {
    for (const a of agents.list) {
      if (isRecord(a) && typeof a.workspace === 'string' && a.workspace.trim() && expandHome(a.workspace.trim()) !== content) {
        plan.warnings.push(`Agent "${typeof a.id === 'string' ? a.id : '?'}" has its own workspace (${a.workspace}); only one agent is imported per Ruby home. Import it separately with --from ${expandHome(a.workspace.trim())} into another RUBY_HOME.`);
      }
    }
  }
  const userHome = join(sc.root, '..');
  if (env.OPENCLAW_PROFILE === undefined) {
    for (const e of safeList(userHome)) {
      if (/^\.openclaw-.+/.test(e) && join(userHome, e) !== sc.root) plan.warnings.push(`Found another OpenClaw profile at ${join(userHome, e)}; import it with --from ${join(userHome, e)} (into its own RUBY_HOME if it is a separate agent).`);
    }
  }

  // Skills: workspace skills win over managed ones in ~/.openclaw/skills.
  collectSkills(ctx, [{ scanner: ws, root: join(content, 'skills') }, ...(content !== sc.root ? [{ scanner: sc, root: join(sc.root, 'skills') }] : [])], new Map());

  scanSecrets(ctx, [join(sc.root, '.env'), ...(ws === sc ? [join(content, '.env')] : [])]);
  if (ws !== sc) scanSecretsWith(ctx, ws, [join(content, '.env')]);

  // Channels, allowlists and the owner's DM.
  const hints: DeliveryHints = { homeChannels: {}, ownerChats: {} };
  if (cfgText !== null) {
    for (const m of cfgText.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) addEnv(plan, m[1]!);
    const channels = isRecord(conf.channels) ? conf.channels : null;
    if (channels) {
      for (const c of Object.keys(channels)) if (CHANNELS.includes(c.toLowerCase())) addChannel(plan, c.toLowerCase());
    } else {
      for (const c of CHANNELS) if (new RegExp(`["']?${c}["']?\\s*:\\s*\\{`, 'i').test(cfgText)) addChannel(plan, c);
    }
    openclawAllowlists(ctx, conf, hints);
    plan.notImported.push({ what: 'openclaw.json', why: 'models, provider settings, API keys, tool policies and channel tokens are not imported; configure Ruby with `ruby setup` (keys go in the encrypted store or ~/.ruby/env)' });
    if (/"?(apiKey|token|botToken|secret)"?\s*:\s*["'][^"'$]/i.test(cfgText)) {
      plan.notImported.push({ what: 'inline secrets in openclaw.json', why: 'never imported or copied; store the ones you still need with `ruby secrets set <NAME>`' });
    }
  }

  // OpenClaw 2026.9.x keeps automations, heartbeat checklists and pairings in a shared SQLite database.
  const dbFile = join(sc.root, 'state', 'openclaw.sqlite');
  if (sc.exists(dbFile)) {
    const state = readOpenClawState(dbFile);
    for (const p of state.problems) plan.warnings.push(`state/openclaw.sqlite: ${p}. Automations and pairings in it were not imported; list them with \`openclaw cron list --all\` and recreate them under "jobs" in config.json.`);
    plan.jobs.push(...openclawJobs(state.jobs, { hints, taken: new Set<string>() }));
    for (const a of state.allow) addAllow(ctx, a.channel, a.entry, `approved pairing (state/openclaw.sqlite${a.account && a.account !== 'default' ? `, account ${a.account}` : ''})`);
  } else if (sc.exists(join(sc.root, 'cron', 'jobs.json'))) {
    plan.notImported.push({ what: 'cron/jobs.json', why: 'this OpenClaw store is older than 2026.9 (retired format); upgrade OpenClaw through 2026.9.7 and run `openclaw doctor --fix`, then import again' });
  }
  const creds = join(sc.root, 'credentials');
  const legacy = sc.list(creds).filter((e) => !e.dir && /-allowFrom\.json$|-pairing\.json$/.test(e.name));
  if (legacy.length) plan.warnings.push(`Found ${legacy.length} legacy pairing file(s) in credentials/ (pre-2026.9). They are not read; run \`openclaw doctor --fix\` to move them into state/openclaw.sqlite, then import again.`);
}

/** `- **Name:** Molty` (IDENTITY.md template), ignoring unfilled placeholders. */
export function identityName(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:[-*+]\s*)?[*_]{0,2}name[*_]{0,2}\s*:\s*[*_]{0,2}\s*(.*)$/i.exec(line);
    if (!m) continue;
    const v = stripControl(m[1]!).replace(/[*_`]/g, '').trim();
    if (!v || v.startsWith('(') || v.length > 40 || v.includes('<!--') || v.includes('-->')) return null;
    return v;
  }
  return null;
}

function openclawAllowlists(ctx: Ctx, conf: Record<string, unknown>, hints: DeliveryHints): void {
  const groups = isRecord(conf.accessGroups) ? conf.accessGroups : {};
  const expand = (channel: string, entries: unknown, from: string): void => {
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const e = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
      const g = /^accessGroup:(.+)$/.exec(e);
      if (g) {
        const group = groups[g[1]!];
        const members = isRecord(group) && isRecord(group.members) ? group.members : {};
        expand(channel, members[channel], `${from} via access group ${g[1]}`);
        continue;
      }
      addAllow(ctx, channel, e, from);
    }
  };
  const channels = isRecord(conf.channels) ? conf.channels : {};
  for (const [name, c] of Object.entries(channels)) {
    if (!isRecord(c)) continue;
    const channel = name.toLowerCase();
    expand(channel, c.allowFrom, `channels.${name}.allowFrom in openclaw.json`);
    if (isRecord(c.accounts)) for (const [acct, a] of Object.entries(c.accounts)) if (isRecord(a)) expand(channel, a.allowFrom, `channels.${name}.accounts.${acct}.allowFrom in openclaw.json`);
  }
  const commands = isRecord(conf.commands) ? conf.commands : {};
  if (Array.isArray(commands.ownerAllowFrom)) {
    for (const raw of commands.ownerAllowFrom) {
      const m = /^([a-z]+):(.+)$/i.exec(typeof raw === 'string' ? raw.trim() : '');
      if (!m) continue;
      const channel = m[1]!.toLowerCase();
      addAllow(ctx, channel, m[2]!, 'commands.ownerAllowFrom in openclaw.json');
      if (!hints.ownerChats[channel] && validSender(channel, m[2]!)) hints.ownerChats[channel] = cleanSender(channel, m[2]!);
    }
  }
  // Heartbeat target "owner" falls back to the first concrete allowFrom entry.
  for (const p of ctx.plan.pairings) if (!hints.ownerChats[p.channel] && p.channel !== 'discord') hints.ownerChats[p.channel] = p.senderId;
}

function cleanSender(channel: string, raw: string): string {
  let v = raw.trim().replace(new RegExp(`^(?:${channel}|tg|user):`, 'i'), '');
  if (channel === 'discord') v = v.replace(/^<@!?(\d+)>$/, '$1');
  return v;
}

/** Sender IDs as Ruby's channels report them: Telegram user IDs, Discord snowflakes, Signal numbers or UUIDs. */
export function validSender(channel: string, raw: string): boolean {
  const v = cleanSender(channel, raw);
  if (channel === 'telegram') return /^\d{1,20}$/.test(v);
  if (channel === 'discord') return /^\d{15,22}$/.test(v);
  if (channel === 'signal') return /^\+\d{6,16}$/.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  return false;
}

/** The sender ID in the form Ruby's channel reports it, or null when it is not a valid one. */
export function validSenderId(channel: string, raw: string): string | null {
  return validSender(channel, raw.trim()) ? cleanSender(channel, raw.trim()) : null;
}

function addAllow(ctx: Ctx, channelRaw: string, raw: string, from: string, displayName: string | null = null): void {
  const channel = channelRaw.toLowerCase();
  const entry = raw.trim();
  if (!entry) return;
  if (!(RUBY_CHANNELS as readonly string[]).includes(channel)) {
    noteOnce(ctx, `allowlisted ${channel} senders`, 'Ruby has no such channel');
    return;
  }
  if (entry === '*' || /^accessGroup:/.test(entry)) {
    noteOnce(ctx, `wildcard ${channel} allowlist (${from})`, 'Ruby never admits everyone; each person pairs with `ruby pair add` or a pairing code');
    return;
  }
  if (!validSender(channel, entry)) {
    ctx.plan.notImported.push({ what: `${channel} allowlist entry "${stripControl(entry).slice(0, 40)}" (${from})`, why: `not a ${channel} user ID Ruby can match (usernames and phone numbers on Telegram/Discord are not stable IDs)` });
    return;
  }
  const senderId = cleanSender(channel, entry);
  if (ctx.plan.pairings.some((p) => p.channel === channel && p.senderId === senderId)) return;
  ctx.plan.pairings.push({ channel: channel as RubyChannel, senderId, displayName, from });
}

function noteOnce(ctx: Ctx, what: string, why: string): void {
  if (!ctx.plan.notImported.some((n) => n.what === what)) ctx.plan.notImported.push({ what, why });
}

function safeList(dir: string): string[] {
  try {
    return makeScanner(dir).list(dir).filter((e) => e.dir).map((e) => e.name);
  } catch {
    return [];
  }
}

// ---- Hermes ----

function planHermes(ctx: Ctx): void {
  const { plan, sc } = ctx;
  plan.contentDir = sc.root;
  const mdir = join(sc.root, 'memories');
  const mem = sc.readText(join(mdir, 'MEMORY.md'));
  if (mem !== null) plan.memory.push(memoryAction(ctx, 'memory', sc, join(mdir, 'MEMORY.md'), parseDelimitedEntries(mem)));
  const usr = sc.readText(join(mdir, 'USER.md'));
  if (usr !== null) plan.memory.push(memoryAction(ctx, 'user', sc, join(mdir, 'USER.md'), parseDelimitedEntries(usr)));

  const soul = sc.readText(join(sc.root, 'SOUL.md'));
  if (soul !== null && soul.trim()) {
    plan.persona = buildPersona([{ file: 'SOUL.md', label: 'Soul', text: soul, optional: false }], 'hermes', null);
    addCopy(ctx, sc, join(sc.root, 'SOUL.md'), 'persona source kept in full');
  }

  // Bundled skills are synced into ~/.hermes/skills; the manifest records `name:md5` of each as shipped.
  // Pristine ones are skipped (they ship with Hermes); ones the owner edited are imported.
  const manifest = new Map<string, string>();
  const mtext = sc.readText(join(sc.root, 'skills', '.bundled_manifest'));
  if (mtext !== null) {
    for (const l of mtext.split('\n')) {
      const line = l.trim();
      if (!line) continue;
      const i = line.indexOf(':');
      manifest.set((i < 0 ? line : line.slice(0, i)).trim(), i < 0 ? '' : line.slice(i + 1).trim());
    }
  }
  const counts = collectSkills(ctx, [{ scanner: sc, root: join(sc.root, 'skills') }], manifest);
  if (manifest.size) {
    const edited = plan.skills.filter((s) => s.editedBundled).length;
    plan.notImported.push({
      what: 'bundled Hermes skills',
      why: `${counts.bundledSkipped} unchanged skills listed in skills/.bundled_manifest ship with Hermes itself and are skipped${edited ? `; ${edited} you edited are imported` : ''}${counts.bundledUnknown ? `; ${counts.bundledUnknown} have no recorded hash (old manifest), so edits cannot be detected and they are skipped` : ''}`,
    });
  }

  // Profiles: ~/.hermes/profiles/<name> has the same layout.
  for (const e of sc.list(join(sc.root, 'profiles'))) {
    if (e.dir) plan.warnings.push(`Found Hermes profile "${e.name}"; only the main profile is imported. Import it with --from ${join(plan.fromDir, 'profiles', e.name)} (into its own RUBY_HOME if it is a separate agent).`);
  }

  scanSecrets(ctx, [join(sc.root, '.env')]);
  const envText = sc.readText(join(sc.root, '.env'));
  const ids = envText === null ? {} : idValues(envText);
  const hints: DeliveryHints = { homeChannels: {}, ownerChats: {} };
  for (const [key, value] of Object.entries(ids)) {
    const m = ID_KEY.exec(key)!;
    const channel = m[1]!.toLowerCase();
    if (m[2] === 'HOME_CHANNEL') hints.homeChannels[channel] = value;
    else for (const id of value.split(',').map((s) => s.trim()).filter(Boolean)) addAllow(ctx, channel, id, `${key} in .env`);
  }
  hermesPairingStore(ctx);

  if (sc.exists(join(sc.root, 'auth.json'))) plan.notImported.push({ what: 'auth.json', why: 'OAuth credentials are never imported; sign in to your provider again in Ruby' });
  const cfg = sc.readText(join(sc.root, 'config.yaml'));
  let timezone: string | null = null;
  if (cfg !== null) {
    for (const c of CHANNELS) if (new RegExp(`^\\s*${c}\\s*:`, 'im').test(cfg)) addChannel(plan, c);
    for (const m of cfg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) addEnv(plan, m[1]!);
    const tz = /^timezone\s*:\s*["']?([A-Za-z0-9_+\-/]+)["']?\s*(?:#.*)?$/m.exec(cfg)?.[1];
    if (tz && validTimeZone(tz)) timezone = tz;
    plan.notImported.push({ what: 'config.yaml', why: 'model/provider settings, MCP servers, toolsets and gateway settings are not imported; configure Ruby with `ruby setup` (or config.json; `ruby config explain` lists every setting)' });
  }

  const jobsFile = join(sc.root, 'cron', 'jobs.json');
  const jobsText = sc.readText(jobsFile);
  if (jobsText !== null) {
    let data: unknown = null;
    try {
      data = JSON.parse(jobsText);
    } catch {
      plan.warnings.push('cron/jobs.json could not be parsed; no jobs were imported from it (it is archived).');
    }
    if (data !== null) plan.jobs.push(...hermesJobs(data, { timezone, hints, taken: new Set<string>(), skillName: (s) => normalizeSkillName(s) }));
    addCopy(ctx, sc, jobsFile, 'Hermes job definitions (imported as disabled Ruby jobs where possible)');
  }
  for (const [name, why] of [['state.db', 'session history is not imported'], ['sessions', 'session history is not imported']] as const) {
    if (sc.exists(join(sc.root, name))) plan.notImported.push({ what: name, why });
  }
}

/** Values of the allowlisted ID keys only (`<PLATFORM>_ALLOWED_USERS`, `<PLATFORM>_HOME_CHANNEL`). Every other value is ignored. */
function idValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !ID_KEY.test(m[1]!)) continue;
    const v = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\s+#.*$/, '');
    if (/^[\w@+:.,\- ]{1,2000}$/.test(v)) out[m[1]!] = v;
  }
  return out;
}

/** Hermes' pairing store: `<home>/platforms/pairing/<platform>-approved.json` (or the legacy `<home>/pairing/`), `{ user_id: { user_name } }`. */
function hermesPairingStore(ctx: Ctx): void {
  const { sc } = ctx;
  for (const dir of [join(sc.root, 'platforms', 'pairing'), join(sc.root, 'pairing')]) {
    for (const e of sc.list(dir)) {
      const m = /^([a-z_]+)-approved\.json$/.exec(e.name);
      if (e.dir || !m) continue;
      const text = sc.readText(join(dir, e.name));
      let data: unknown = null;
      try {
        data = text === null ? null : JSON.parse(text);
      } catch {
        /* unreadable: skipped */
      }
      if (!isRecord(data)) continue;
      for (const [id, info] of Object.entries(data)) {
        if (isRecord(info) && 'hash' in info && 'salt' in info) continue; // hashed entries cannot be recovered
        const name = isRecord(info) && typeof info.user_name === 'string' ? stripControl(info.user_name).slice(0, 80) || null : null;
        addAllow(ctx, m[1]!, id, `approved pairing (${sc.rel(join(dir, e.name))})`, name);
      }
    }
  }
}

// ---- shared helpers ----

function emptyPlan(source: Source, fromDir: string): ImportPlan {
  return { source, fromDir, contentDir: fromDir, name: null, memory: [], persona: null, skills: [], copies: [], jobs: [], pairings: [], notImported: [], envVars: [], channels: [], warnings: [] };
}

function finish(ctx: Ctx): void {
  const { plan } = ctx;
  for (const m of plan.memory) {
    if (m.fitCount < m.entries.length || m.skipped.length > 0 || m.shortened > 0) {
      const src = ctx.memSources.get(m);
      if (src) addCopy(ctx, src.scanner, src.abs, 'full original memory file; curate it with `ruby memory edit`');
    }
  }
  plan.warnings.push(...ctx.sc.warnings);
  if (ctx.ws !== ctx.sc) plan.warnings.push(...ctx.ws.warnings);
  const total = plan.skills.length;
  if (total > 50) plan.warnings.push(`${total} skills found; consider archiving the ones you do not need (ruby skills).`);
  if (plan.channels.length) {
    plan.notImported.push({ what: `channel settings (${plan.channels.join(', ')})`, why: 'tokens are not imported; enable the matching Ruby channels (Telegram, Discord, Signal) with `ruby setup`' });
  }
  if (plan.envVars.length) {
    plan.notImported.push({ what: `secrets (${plan.envVars.length} env var names)`, why: 'values are never read or copied; store the ones you still need with `ruby secrets set <NAME>` (or in ~/.ruby/env)' });
  }
}

/** A path relative to the source dir when possible; workspace content outside it gets a `workspace/` prefix. */
function relOf(ctx: Ctx, scanner: Scanner, abs: string): string {
  return scanner === ctx.sc ? scanner.rel(abs) : `workspace/${scanner.rel(abs)}`;
}

function addCopy(ctx: Ctx, scanner: Scanner, abs: string, reason: string): void {
  const { plan } = ctx;
  const src = scanner.rel(abs);
  const dest = `imported/${plan.source}/${relOf(ctx, scanner, abs)}`;
  if (plan.copies.some((c) => c.dest === dest)) return;
  plan.copies.push({ src, dest, reason, ...(scanner === ctx.sc ? {} : { root: scanner.root }) });
}
function addEnv(plan: ImportPlan, name: string): void {
  const m = /^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX)_/.exec(name);
  if (m) addChannel(plan, m[1]!.toLowerCase());
  if (ID_KEY.test(name) || /_ALLOW_ALL_USERS$/.test(name)) return; // IDs and switches, not secrets
  if (!plan.envVars.includes(name)) plan.envVars.push(name);
}
function addChannel(plan: ImportPlan, c: string): void {
  if (!plan.channels.includes(c)) plan.channels.push(c);
}

/** Collect variable NAMES only. Values are never stored in the plan. */
function scanSecrets(ctx: Ctx, files: string[]): void {
  scanSecretsWith(ctx, ctx.sc, files);
}
function scanSecretsWith(ctx: Ctx, scanner: Scanner, files: string[]): void {
  for (const f of files) {
    const t = scanner.readText(f);
    if (t === null) continue;
    for (const line of t.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) addEnv(ctx.plan, m[1]!);
    }
    if (!ctx.plan.notImported.some((n) => n.what === relOf(ctx, scanner, f))) ctx.plan.notImported.push({ what: relOf(ctx, scanner, f), why: 'secrets file: never imported or copied' });
  }
}

function clean(s: string): string {
  return stripControl(s.replace(/\s+/g, ' ')).trim();
}

/** OpenClaw MEMORY.md/USER.md are free-form markdown: every bullet or non-empty line is one entry; headings are dropped. */
export function parseMarkdownEntries(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const l = raw.trim();
    if (!l || /^#{1,6}\s/.test(l) || /^(-{3,}|\*{3,}|_{3,})$/.test(l) || /^<!--.*-->$/.test(l)) continue;
    out.push(l.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
  }
  return out;
}

/** Hermes stores entries separated by a line containing only "§" (confirmed in hermes-agent: ENTRY_DELIMITER = "\n§\n"). Entries may span lines. */
export function parseDelimitedEntries(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split(/^[ \t]*§[ \t]*$/m).map((e) => e.trim()).filter(Boolean);
}

function memoryAction(ctx: Ctx, file: 'memory' | 'user', scanner: Scanner, abs: string, raw: string[]): MemoryAction {
  const from = relOf(ctx, scanner, abs);
  const cap = ctx.opts.caps?.[file] ?? DEFAULT_LIMITS[file];
  const entries: string[] = [];
  const skipped: MemoryAction['skipped'] = [];
  let shortened = 0;
  const seen = new Set<string>();
  for (const r of raw) {
    let e = clean(r).replace(/^-\s+/, '');
    if (!e) continue;
    // The memory store's hygiene heuristic (not a security boundary): entries are replayed into prompts.
    const why = injectionReason(e);
    if (why) {
      skipped.push({ text: e.slice(0, 80), reason: why });
      continue;
    }
    if (e.length > MAX_ENTRY_CHARS) {
      e = `${e.slice(0, MAX_ENTRY_CHARS - 3).trimEnd()}...`;
      shortened++;
    }
    if (seen.has(e)) continue;
    seen.add(e);
    entries.push(e);
  }
  const needed = entries.length ? entries.map((e) => `- ${e}`).join('\n').length : 0;
  const action: MemoryAction = { file, from, entries, fitCount: selectFit(entries, [], cap).length, cap, needed, skipped, shortened };
  ctx.memSources.set(action, { scanner, abs });
  return action;
}

/**
 * Choose which entries to add. Policy: the most recent (last) entries win, because both tools append new
 * facts at the end. Walk from the end, take every entry that still fits, and keep source order.
 */
export function selectFit(entries: string[], existingLines: string[], cap: number): string[] {
  const have = new Set(existingLines);
  let used = existingLines.length ? existingLines.join('\n').length : -1; // -1: first line needs no newline
  const picked: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `- ${entries[i]!}`;
    if (have.has(line)) continue;
    const next = used + 1 + line.length;
    if (next > cap) continue;
    used = next;
    picked.push(line);
  }
  return picked.reverse().map((l) => l.slice(2));
}

export const PERSONA_HEADER = (source: Source) => `Imported from ${source}. Treat as the owner's style and standing preferences.`;

function buildPersona(parts: { file: string; label: string; text: string; optional: boolean }[], source: Source, name: string | null): PersonaAction | null {
  if (!parts.length) return null;
  const note = `\n[Imported from ${source}; truncated. Full text: workspace imported/${source}/]`;
  const header = `${PERSONA_HEADER(source)}${name ? `\nYour name is ${name}.` : ''}`;
  const blocks = parts.map((p) => `## ${p.label}\n${stripControl(p.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008]/g, '')).trim()}`);
  const full = `${header}\n\n${blocks.join('\n\n')}`;
  if (full.length <= PERSONA_MAX) return { text: full, from: parts.map((p) => p.file), truncated: false };
  // Mandatory parts first (SOUL/IDENTITY), optional ones (AGENTS.md) only with what room is left.
  const budget = PERSONA_MAX - note.length;
  const text = `${full.slice(0, budget).trimEnd()}${note}`;
  const used = parts.filter((p, i) => full.indexOf(blocks[i]!) < budget || !p.optional);
  return { text, from: used.map((p) => p.file), truncated: true };
}

// ---- skills ----

type SkillRoot = { scanner: Scanner; root: string };

function collectSkills(ctx: Ctx, roots: SkillRoot[], manifest: Map<string, string>): { bundledSkipped: number; bundledUnknown: number } {
  const seen = new Map<string, string>();
  const counts = { bundledSkipped: 0, bundledUnknown: 0 };
  const visit = (sc: Scanner, dir: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH) return;
    const entries = sc.list(dir);
    if (entries.some((e) => !e.dir && e.name === 'SKILL.md')) {
      addSkill(ctx, sc, dir, seen, manifest, counts);
      return;
    }
    for (const e of entries) {
      if (e.dir && !e.name.startsWith('.') && e.name !== 'node_modules') visit(sc, join(dir, e.name), depth + 1);
    }
  };
  for (const { scanner, root } of roots) if (scanner.isDir(root)) visit(scanner, root, 0);
  return counts;
}

function listFiles(sc: Scanner, dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  return sc.list(dir).flatMap((e) => (e.dir ? (e.name.startsWith('.') ? [] : listFiles(sc, join(dir, e.name), depth + 1)) : [join(dir, e.name)]));
}

function addSkill(ctx: Ctx, sc: Scanner, dir: string, seen: Map<string, string>, manifest: Map<string, string>, counts: { bundledSkipped: number; bundledUnknown: number }): void {
  const { plan } = ctx;
  const file = join(dir, 'SKILL.md');
  const from = relOf(ctx, sc, file);
  const dirName = dir.split(/[\\/]/).pop()!;
  const raw = sc.readText(file);
  if (raw === null) return;
  const { fm, raw: fmRaw, body } = parseSkillText(raw);
  const originalName = fm.name || dirName;
  let editedBundled = false;
  const bundledKey = manifest.has(originalName) ? originalName : manifest.has(dirName) ? dirName : null;
  if (bundledKey !== null) {
    const origin = manifest.get(bundledKey)!;
    if (!origin) {
      counts.bundledUnknown++;
      return;
    }
    if (hermesDirHash(sc, dir) === origin) {
      counts.bundledSkipped++;
      return;
    }
    editedBundled = true;
  }
  const name = normalizeSkillName(originalName) ?? normalizeSkillName(dirName);
  let description = clean(fm.description ?? '');
  if (!description) description = clean(body.split('\n').find((l) => l.trim() && !/^#/.test(l.trim())) ?? '');
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION - 3).trimEnd()}...`;
  const action: SkillAction = { name: name ?? '', originalName, description, body: '', from, extraFiles: [], bodyTruncated: false, frontmatter: {}, requires: emptyRequirements(), missing: [] };
  if (editedBundled) action.editedBundled = true;
  // Keep newlines and tabs, drop other control characters.
  let text = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const extras = listFiles(sc, dir).filter((p) => p !== file && sc.readBuffer(p) !== null);
  action.extraFiles = extras.map((p) => relOf(ctx, sc, p));
  if (action.extraFiles.length) {
    // Point the skill's own-folder placeholder at the archived copy (workspace-relative, as Ruby's file tools take it).
    const archived = `imported/${plan.source}/${relOf(ctx, sc, dir)}`;
    const rw = rewriteBaseDir(text, plan.source, archived);
    if (rw.changed) {
      text = rw.text;
      action.baseDirRewrite = archived;
    }
  }
  if (text.length > MAX_BODY) {
    const note = '\n\n[Imported skill truncated to fit Ruby\'s limit; the original is under the workspace imported/ folder.]';
    text = `${text.slice(0, MAX_BODY - note.length).trimEnd()}${note}`;
    action.bodyTruncated = true;
  }
  action.body = text;

  // Requirements: kept on the skill (frontmatter) and checked now so the owner sees what will not work.
  const { requires, metadata } = frontmatterRequirements(fmRaw);
  const tools = ctx.opts.tools ?? DEFAULT_TOOLS;
  requires.tools = missingTools(text, tools);
  action.requires = requires;
  if (metadata) action.frontmatter.metadata = metadata;
  if (requires.bins.length || requires.env.length || requires.tools.length || requires.os.length) {
    action.frontmatter.requires = JSON.stringify({
      ...(requires.bins.length ? { [requires.anyBin ? 'anyBins' : 'bins']: requires.bins } : {}),
      ...(requires.env.length ? { env: requires.env } : {}),
      ...(requires.tools.length ? { tools: requires.tools } : {}),
      ...(requires.os.length ? { os: requires.os } : {}),
    });
  }
  const hasBin = ctx.opts.hasBin ?? ((b: string) => onPath(b));
  const missingBins = requires.bins.filter((b) => !hasBin(b));
  if (requires.bins.length && (requires.anyBin ? missingBins.length === requires.bins.length : missingBins.length)) {
    action.missing.push(`${requires.anyBin ? 'one of ' : ''}${(requires.anyBin ? requires.bins : missingBins).join(', ')} (not on PATH)`);
  }
  if ((requires.bins.length || usesShell(text)) && !tools.includes('run_command')) action.missing.push('run_command (exec is denied in Ruby)');
  if (ctx.opts.hasSecret) {
    const missingEnv = requires.env.filter((e) => !ctx.opts.hasSecret!(e));
    if (missingEnv.length) action.missing.push(`${missingEnv.join(', ')} (secret not set; and run_command cannot pass secrets to commands yet)`);
  }
  if (requires.tools.length) action.missing.push(`${requires.tools.join(', ')} (no such Ruby tool)`);
  const os = { linux: 'linux', darwin: 'darwin', win32: 'win32' }[process.platform as string];
  if (requires.os.length && os && !requires.os.some((o) => o.toLowerCase() === os || (o === 'macos' && os === 'darwin') || (o === 'windows' && os === 'win32'))) {
    action.missing.push(`runs on ${requires.os.join(', ')} only`);
  }

  if (!name) action.conflict = `name "${originalName}" cannot be converted to a valid Ruby skill name`;
  else if (!description) action.conflict = 'no description in frontmatter and none could be derived';
  else if (!text) action.conflict = 'skill body is empty';
  else if (seen.has(name)) action.conflict = `name "${name}" already taken by ${seen.get(name)!} in this source`;
  if (name && !seen.has(name)) seen.set(name, from);
  if (action.extraFiles.length || action.bodyTruncated) {
    for (const p of [file, ...extras]) addCopy(ctx, sc, p, `skill "${name ?? originalName}": ${action.extraFiles.length ? 'supporting files Ruby skills cannot hold' : 'original body'}`);
  }
  plan.skills.push(action);
}

/**
 * Minimal frontmatter reader: top-level `key: value` pairs, quotes stripped, folded/literal blocks joined.
 * `raw` keeps each key's text with its indented continuation lines (for nested metadata).
 */
export function parseSkillText(text: string): { fm: Record<string, string>; raw: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { fm: {}, raw: {}, body: t };
  const fm: Record<string, string> = {};
  const raw: Record<string, string> = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let v = kv[2]!.trim();
    const block: string[] = [kv[2]!];
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]!) || (lines[i + 1]!.trim() === '' && /^[ \t]+\S/.test(lines[i + 2] ?? '')))) {
        block.push(lines[i + 1]!);
        const l = lines[++i]!.trim();
        if (l) parts.push(l);
      }
      v = parts.join(' ');
    } else {
      // Flow values that continue on indented lines (`metadata: {` … `}`).
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!)) block.push(lines[++i]!);
    }
    fm[kv[1]!] = v.replace(/^(["'])(.*)\1$/, '$2');
    raw[kv[1]!] = block.join('\n');
  }
  return { fm, raw, body: t.slice(m[0].length) };
}
