// `garnet setup`: a re-runnable wizard for the model, keys, persona, channels,
// importing, the background service and pairing. All input comes through a
// Prompter and all side effects through SetupDeps, so tests script it fully.
// Nothing is written until the owner saves; secrets go to the encrypted store
// or the env file, never into config.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PROVIDER,
  PROVIDER_NAME_RE,
  activeProvider,
  DEFAULT_NAME,
  PERSONA_MAX,
  defaultConfig,
  keyEnvOf,
  parseConfig,
  pathsFor,
  readPersona,
  removeFromEnvFile,
  setInEnvFile,
  withProvider,
  writeConfig,
  writePersona,
  type GarnetConfig,
  type ModelConfig,
} from '../../config/index.ts';
import { DEFAULT_GEMINI_MODEL, GEMINI_API_KEY_ENV, GEMINI_BASE_URL } from '../../models/index.ts';
import { loadCatalog, priceLine, refreshCatalog, suggestModels, type Catalog } from '../../catalog/index.ts';
import { errorMessage } from '../../contracts/index.ts';
import { KEY_FILE_ENV, openSecretStore, unlockFrom, writePrivateFile } from '../../secrets/index.ts';
import type { ServiceResult } from '../../service/index.ts';
import type { Io } from '../main.ts';
import { checkDiscord, checkModel, checkSignal, checkTelegram } from './checks.ts';
import { integrationsStep, integrationsSummary } from './integrations.ts';
import { askBasics } from './persona.ts';
import { preferencesStep, preferencesSummary, timezoneStep } from './preferences.ts';
import type { Choice, Prompter, Style } from './prompt.ts';
import { checked, lookup, secretStep } from './secrets.ts';
import { heading, required, validEnvName, validUrl, type ImportDraft, type SetupDeps, type State } from './shared.ts';
import { toolsStep, toolsSummary } from './tools.ts';
import { voiceStep, voiceSummary } from './voice.ts';

export type { ApprovalBinding, ApprovalMode, ImportDraft, ImportSource, Pairing, SetupDeps } from './shared.ts';

type ProviderChoice = 'anthropic' | 'gemini' | 'openrouter' | 'local' | 'openai-compatible' | 'fake';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
/** Local servers rarely need a key; a dedicated name keeps another provider's key from being sent to them. */
const LOCAL_KEY_ENV = 'LOCAL_MODEL_API_KEY';
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function providerOf(m: ModelConfig): ProviderChoice {
  if (m.provider !== 'openai-compatible') return m.provider;
  if (m.baseUrl && new URL(m.baseUrl).host === 'openrouter.ai') return 'openrouter';
  if (m.baseUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(m.baseUrl).hostname)) return 'local';
  return 'openai-compatible';
}

const PROVIDERS: Choice<ProviderChoice>[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'recommended · key from console.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', hint: 'key from aistudio.google.com/apikey' },
  { value: 'openrouter', label: 'OpenRouter', hint: 'one key, many models · openrouter.ai/keys' },
  { value: 'local', label: 'A model on this machine', hint: 'Ollama, LM Studio, llama.cpp, vLLM · no key' },
  { value: 'openai-compatible', label: 'Another OpenAI-compatible API', hint: 'any /v1/chat/completions endpoint' },
  { value: 'fake', label: 'Not yet: the offline demo model', hint: 'try Garnet without a key' },
];

export async function runSetup(p: Prompter, io: Io, deps: SetupDeps): Promise<number> {
  const s = deps.style;
  const st = loadState(io, deps);
  if (st.resetFrom) {
    const reset = await p.confirm({ id: 'reset', message: 'Start over from the defaults? The current file is kept as a backup.', default: true, auto: false });
    if (!reset) {
      io.err('Nothing was changed. Fix config.json by hand (`garnet config explain` lists every setting), or pass --reset.\n');
      return 1;
    }
  }
  io.out(`\n${s.accent('◆ GARNET')} ${s.muted('/ SETUP')}\n${s.muted('────────────────────────────────────────')}\n`);
  if (st.existing) {
    io.out(`Garnet is already set up in ${deps.home}. Change what you like; nothing is saved until you finish.\n\n`);
    io.out(summary(st, deps));
  } else {
    io.out(`Let's get Garnet ready. This takes a minute or two; everything goes in ${deps.home}.\nNothing is saved until the end. Press Ctrl+C to quit at any time.\n`);
  }

  let wantService = false;
  if (st.existing && p.interactive) {
    for (;;) {
      const section = await p.select<string>({ id: 'section', message: 'What would you like to change?', choices: menu(st, deps), default: 'done' });
      if (section === 'quit') {
        io.out('Nothing was changed.\n');
        return 0;
      }
      if (section === 'done') break;
      if (section === 'service') wantService = true;
      else await runSection(section === 'import' ? { id: 'import', run: importStep } : SECTIONS.find((x) => x.id === section)!, p, io, deps, st);
    }
    if (!st.changed && !wantService) {
      io.out('No changes.\n');
      return 0;
    }
  } else {
    if (!st.existing) await importStep(p, io, deps, st);
    await modelStep(p, io, deps, st);
    await personaSection(p, io, deps, st);
    await channelsStep(p, io, deps, st);
    await extrasSteps(p, io, deps, st);
  }

  // The tools step may have switched off the permission the wake-up chat needs to save what it learns.
  if (st.wake && st.config.permissions['memory.write'] === 'deny') {
    io.out(`  ${deps.style.warn('!')} The wake-up chat needs to remember things, which is off. Using the short form instead.\n`);
    st.wake = false;
    await personaStep(p, io, deps, st);
    await timezoneStep(p, st, deps);
  }
  if (p.review && !(await p.review({ id: 'review', message: 'Save these settings?', help: `Nothing has been written yet. Saving writes ${join(deps.home, 'config.json')} and stores any keys you entered.`, body: summary(st, deps) }))) {
    io.out('Nothing was saved.\n');
    return 0;
  }
  save(io, deps, st);
  // The wake-up chat writes persona and time zone to the saved config, and the service reads config once at start,
  // so the chat runs before the service is installed or restarted. Pairing needs the running service, so it stays after.
  if (st.wake) await wakeStep(io, deps, st);
  const service = await serviceStep(p, io, deps, st, wantService);
  await pairingStep(p, io, deps, st, service);
  io.out(nextSteps(st, deps, service));
  return 0;
}

function loadState(io: Io, deps: SetupDeps): State {
  const file = join(deps.home, 'config.json');
  const base: State = { config: defaultConfig(), existing: false, resetFrom: null, secrets: new Map(), storage: null, keyFile: null, consent: null, bots: {}, todo: [], changed: true, wake: false };
  if (!existsSync(file)) return base;
  try {
    // Migrations are applied in memory; the file is only rewritten on save.
    return { ...base, config: parseConfig(JSON.parse(readFileSync(file, 'utf8'))), existing: true, changed: false };
  } catch (e) {
    io.err(`${file} has problems:\n  ${errorMessage(e).replace(/\n/g, '\n  ')}\n`);
    return { ...base, resetFrom: file };
  }
}

/**
 * The parts of setup, in the order of a first run (after the import offer). On a re-run each one is a menu entry;
 * adding a part is adding an entry here. `extra` parts belong to the second half of a first run, which the owner may skip.
 */
type SectionSpec = {
  id: string;
  label: string;
  hint: (st: State, deps: SetupDeps) => string;
  run: (p: Prompter, io: Io, deps: SetupDeps, st: State) => Promise<void>;
  extra: boolean;
};

const SECTIONS: SectionSpec[] = [
  {
    id: 'model',
    label: 'Model and API key',
    hint: (st) => `${providerOf(activeProvider(st.config).model)} · ${activeProvider(st.config).model.name}`,
    run: modelStep,
    extra: false,
  },
  {
    id: 'persona',
    label: 'Name, persona and time zone',
    hint: (st) => {
      const persona = readPersona(st.config.persona);
      return `${persona.name}${persona.owner ? `, for ${persona.owner}` : ''} · ${st.config.timezone ?? 'host time zone'}`;
    },
    run: personaSection,
    extra: false,
  },
  {
    id: 'channels',
    label: 'Messaging channels',
    hint: (st) => enabledChannels(st.config).join(', ') || 'none',
    run: channelsStep,
    extra: false,
  },
  { id: 'tools', label: 'Tools and permissions', hint: (st) => toolsSummary(st.config), run: toolsStep, extra: true },
  {
    id: 'integrations',
    label: 'Connectors and skills',
    hint: (st) => {
      const i = integrationsSummary(st.config);
      return `${i.connectors} · skills: ${i.skills}`;
    },
    run: integrationsStep,
    extra: true,
  },
  { id: 'voice', label: 'Voice notes', hint: (st) => voiceSummary(st.config), run: voiceStep, extra: true },
  { id: 'preferences', label: 'Spending cap and dashboard', hint: (st) => preferencesSummary(st.config), run: preferencesStep, extra: true },
];

function menu(st: State, deps: SetupDeps): Choice<string>[] {
  const items: Choice<string>[] = SECTIONS.map((x) => ({ value: x.id, label: x.label, hint: x.hint(st, deps) }));
  if (deps.importSources().length) items.push({ value: 'import', label: 'Import from OpenClaw or Hermes' });
  if (deps.service) items.push({ value: 'service', label: 'Background service', hint: deps.service.installed() ? 'installed · restart or reinstall' : 'not installed' });
  items.push({ value: 'done', label: 'Save and finish' }, { value: 'quit', label: 'Quit without saving' });
  return items;
}

async function runSection(section: SectionSpec | { id: 'import'; run: SectionSpec['run'] }, p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const before = JSON.stringify(st.config) + st.secrets.size;
  await section.run(p, io, deps, st);
  if (JSON.stringify(st.config) + st.secrets.size !== before || st.wake) st.changed = true;
}

/**
 * The second half of a first run: tools, connectors, voice notes, limits. A person is asked once whether to go
 * through it; a script always runs it (every question keeps the current setting unless a flag says otherwise).
 */
async function extrasSteps(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const more = await p.select<'more' | 'defaults'>({
    id: 'extras',
    message: 'Want to set up tools and extras now?',
    help: 'Garnet asks before it browses, writes files or sends messages, and never runs commands unless you allow it. Everything here can be changed later with `garnet setup`.',
    choices: [
      { value: 'more', label: 'Yes, walk me through them', hint: 'web search, commands, calendar, GitHub, voice notes, a spending cap' },
      { value: 'defaults', label: 'No, the defaults are fine' },
    ],
    default: 'more',
    auto: 'more',
  });
  if (more === 'defaults') return;
  for (const section of SECTIONS.filter((x) => x.extra)) {
    // Voice notes arrive through chats, so only offer them when one is connected.
    if (section.id === 'voice' && !enabledChannels(st.config).length) continue;
    await section.run(p, io, deps, st);
  }
}

// ---------- import ----------

async function importStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const sources = deps.importSources();
  if (!sources.length) return;
  heading(io, deps.style, 'Bring your old assistant along');
  for (const { source, dir } of sources) {
    const name = source === 'openclaw' ? 'OpenClaw' : 'Hermes';
    const look = await p.confirm({ id: 'import', message: `Found ${name} at ${dir}. Preview what Garnet can import?`, help: 'Memory, persona and skills. Secrets are never copied.', default: true, auto: false });
    if (!look) continue;
    const draft: ImportDraft = {
      get: () => st.config.persona,
      set: (v: string) => void (st.config.persona = v),
      config: () => st.config,
      setConfig: (c: GarnetConfig) => void (st.config = c),
      ask: p,
    };
    // An import is optional: a failure is reported and setup carries on.
    const run = async (args: string[]): Promise<number> => {
      try {
        return await deps.runImport(args, draft);
      } catch (e) {
        io.err(`  ${deps.style.bad('✗')} Import failed: ${errorMessage(e)}\n`);
        return 1;
      }
    };
    if ((await run([source, '--from', dir])) !== 0) continue;
    if (await p.confirm({ id: 'import-apply', message: `Import from ${name} now?`, help: 'Memory, skills and pairings are written right away; the persona, memory caps and (disabled) jobs are saved with the rest of setup.', default: true })) {
      await run([source, '--from', dir, '--apply']);
      st.changed = true;
    }
  }
}

// ---------- model ----------

async function modelStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  heading(io, deps.style, 'Model');
  const current = activeProvider(st.config);
  const cur = current.model;
  const was = providerOf(cur);
  const provider = await p.select<ProviderChoice>({ id: 'provider', message: 'Which model should Garnet think with?', choices: PROVIDERS, default: was });
  const same = provider === was;
  const defaults = defaultConfig().model;
  const m: ModelConfig = { ...cur };
  delete m.contextWindow;
  if (!same) delete m.baseUrl;
  if (same && cur.contextWindow) m.contextWindow = cur.contextWindow;

  const catalog = loadCatalog(deps.home);
  const known = (kind: ModelConfig['provider'], baseUrl?: string): string => {
    const found = suggestModels(catalog, { provider: kind, baseUrl }, 6);
    return found.length ? ` Recent: ${found.map((f) => f.name).join(', ')}.` : '';
  };
  const askModel = (help: string, def?: string) =>
    p.text({ id: 'model', message: 'Model ID', help, ...(def ? { default: def } : {}), validate: required('a model ID') });
  const askKeyEnv = async (def: string) => (p.interactive ? def : await p.text({ id: 'key-env', message: 'Name of the variable or secret that holds the key', default: def, validate: validEnvName }));

  switch (provider) {
    case 'fake':
      m.provider = 'fake';
      break;
    case 'anthropic':
      m.provider = 'anthropic';
      m.name = await askModel(`Press Enter for the default.${known('anthropic')}`, same ? cur.name : defaults.name);
      m.apiKeyEnv = await askKeyEnv(same ? keyEnvOf(cur) : 'ANTHROPIC_API_KEY');
      break;
    case 'gemini':
      m.provider = 'gemini';
      m.name = await askModel(`Recent IDs from Google's catalog:${known('gemini')}`, same ? cur.name : DEFAULT_GEMINI_MODEL);
      m.apiKeyEnv = await askKeyEnv(same ? keyEnvOf(cur) : GEMINI_API_KEY_ENV);
      break;
    case 'openrouter':
      m.provider = 'openai-compatible';
      m.baseUrl = OPENROUTER_URL;
      m.name = await askModel('IDs look like provider/model; browse https://openrouter.ai/models. Pick one that supports tools.', same ? cur.name : undefined);
      m.apiKeyEnv = await askKeyEnv(same ? keyEnvOf(cur) : 'OPENROUTER_API_KEY');
      break;
    case 'local':
      m.provider = 'openai-compatible';
      m.baseUrl = await p.text({
        id: 'base-url',
        message: 'Server address',
        help: 'Ollama http://127.0.0.1:11434/v1 · LM Studio http://127.0.0.1:1234/v1 · llama.cpp http://127.0.0.1:8080/v1',
        default: same && cur.baseUrl ? cur.baseUrl : LOCAL_URL,
        validate: validUrl,
      });
      m.name = await askModel('The name your server uses, e.g. from `ollama list`. Pick one that supports tools.', same ? cur.name : undefined);
      m.apiKeyEnv = same ? keyEnvOf(cur) : LOCAL_KEY_ENV;
      break;
    case 'openai-compatible':
      m.provider = 'openai-compatible';
      m.baseUrl = await p.text({ id: 'base-url', message: 'API base URL (ending in /v1)', ...(same && cur.baseUrl ? { default: cur.baseUrl } : {}), validate: validUrl });
      m.name = await askModel('The model ID the API expects.', same ? cur.name : undefined);
      m.apiKeyEnv = await askKeyEnv(same && keyEnvOf(cur) !== 'ANTHROPIC_API_KEY' ? keyEnvOf(cur) : 'OPENAI_API_KEY');
      break;
  }
  // A custom provider can be given a name (kept next to the others in `providers`); other kinds stay where they are.
  let name = current.name;
  if (provider === 'local' || provider === 'openrouter' || provider === 'openai-compatible') {
    name = await p.text({
      id: 'provider-name',
      message: 'Name for this provider',
      help: 'Lowercase letters, digits and dashes. "default" is the main model block; a new name is added next to your other providers and becomes the one in use.',
      default: current.name,
      validate: (v) => (v === DEFAULT_PROVIDER || PROVIDER_NAME_RE.test(v) ? null : 'Use lowercase letters, digits and dashes (at most 32).'),
    });
  }
  st.config = name === DEFAULT_PROVIDER ? { ...st.config, model: m, activeProvider: DEFAULT_PROVIDER } : { ...withProvider(st.config, name, m), activeProvider: name };

  if (provider === 'fake') {
    io.out(`  ${deps.style.muted('The demo model replies from a script. Run `garnet setup` again when you have a key.')}\n`);
    return;
  }
  const keySpec = {
    anthropic: { label: 'Anthropic API key', help: 'Create one at https://console.anthropic.com/settings/keys', required: true },
    openrouter: { label: 'OpenRouter API key', help: 'Create one at https://openrouter.ai/keys', required: true },
    gemini: { label: 'Gemini API key', help: 'Create one at https://aistudio.google.com/apikey', required: true },
    'openai-compatible': { label: 'API key', help: 'Leave empty if the server needs none.', required: false },
    local: null,
  }[provider];
  const host = new URL(m.baseUrl ?? (provider === 'gemini' ? GEMINI_BASE_URL : 'https://api.anthropic.com')).host;
  const result = await checked(p, io, deps, st, {
    what: 'model',
    consentHelp: `One request to ${host} that lists models, and one to openrouter.ai for current model prices; neither uses tokens.`,
    enter: async (fresh) => (keySpec ? secretStep(p, io, deps, st, { id: 'key', name: keyEnvOf(m), ...keySpec }, fresh) : undefined),
    check: (key) => checkModel(m, key, deps.fetch),
    canRetry: keySpec !== null,
    needsValue: keySpec?.required ?? false,
  });
  // A checked setup also refreshes prices (the owner agreed to live requests); otherwise the cache or bundled snapshot answers.
  let prices: Catalog = catalog;
  if (result?.ok) {
    const fresh = await refreshCatalog(deps.home, deps.fetch, deps.now);
    prices = fresh.catalog;
    if (!fresh.ok) io.out(`  ${deps.style.warn('!')} ${fresh.detail}; using the ${fresh.catalog.source} from ${fresh.catalog.fetchedAt.slice(0, 10)}.\n`);
  }
  const configured = m.pricing ? `${m.name}: price set in config (model.pricing): $${m.pricing.input} in / $${m.pricing.output} out per million tokens; it overrides the catalog` : null;
  io.out(`  ${deps.style.muted(configured ?? priceLine(prices, m, m.name))}\n`);
}


// ---------- persona ----------

/** Name, how to be addressed and answer style, then the time zone (the wake-up chat asks that itself). */
async function personaSection(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  await personaStep(p, io, deps, st);
  if (!st.wake) await timezoneStep(p, st, deps);
}

async function personaStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  heading(io, deps.style, 'About you');
  st.wake = false;
  // Only a person at a terminal is offered the chat, and only when the model can answer. Scripts always get the form.
  if (p.interactive && deps.wake && wakeReady(deps, st)) {
    const how = await p.select<'form' | 'wake'>({
      id: 'onboarding',
      message: 'How would you like to set up your assistant?',
      help: 'The quick form asks three short questions. "Wake it up" opens a first chat where your assistant introduces itself and asks the same things.',
      choices: [
        { value: 'form', label: 'Quick form', hint: 'name, what to call you, answer style' },
        { value: 'wake', label: 'Wake it up', hint: 'a first conversation, right after setup is saved' },
      ],
      default: 'form',
      auto: 'form',
    });
    if (how === 'wake') {
      st.wake = true;
      return;
    }
  }
  const cur = readPersona(st.config.persona);
  const { name, owner, notes } = await askBasics(p, cur);
  const persona = writePersona(st.config.persona, { name: name || DEFAULT_NAME, owner, notes });
  if ((persona ?? '').length > PERSONA_MAX) {
    io.out(`  ${deps.style.warn('!')} The persona would exceed ${PERSONA_MAX} characters, so these basics were not added. Shorten config.persona first.\n`);
    return;
  }
  if (persona === undefined) delete st.config.persona;
  else st.config.persona = persona;
}

/** The wake-up chat needs a model that can answer (the offline demo, a local server, or a key that is already available) and permission to save (`memory.write`). */
function wakeReady(deps: SetupDeps, st: State): boolean {
  if (st.config.permissions['memory.write'] === 'deny') return false;
  const provider = providerOf(activeProvider(st.config).model);
  return provider === 'fake' || provider === 'local' || lookup(deps, st, keyEnvOf(activeProvider(st.config).model)).found;
}

/** Runs right after the config is saved, before the service starts. A failure never undoes setup: the form is one command away. */
async function wakeStep(io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  io.out(`\n${s.accent('◆')} ${s.bold('Waking your assistant up')}\n  ${s.muted('Say /exit when you are done. If the model cannot use its tools, you will get the short form instead.')}\n\n`);
  try {
    const code = await deps.wake!({ fake: providerOf(activeProvider(st.config).model) === 'fake' });
    if (code !== 0) st.todo.push('The wake-up chat ended with an error. Run `garnet wake` to try again, or `garnet setup` for the form.');
  } catch (e) {
    st.todo.push(`The wake-up chat could not start (${errorMessage(e)}). Run \`garnet wake\` to try again, or \`garnet setup\` for the form.`);
  }
  // The chat saves through the same config file; show what it stored.
  try {
    st.config = parseConfig(JSON.parse(readFileSync(join(deps.home, 'config.json'), 'utf8')));
  } catch {
    // Keep the draft: the summary is informational.
  }
}

// ---------- channels ----------

type ChannelName = keyof GarnetConfig['channels'];
type ChannelSpec = {
  name: ChannelName;
  label: string;
  hint: string;
  /** Asks for this channel's details (token, number), runs its optional live check and sets `enabled`. */
  setup: (p: Prompter, io: Io, deps: SetupDeps, st: State) => Promise<void>;
};

/** The channels the checklist offers. Adding a channel to the list is adding one entry here. */
const CHANNELS: ChannelSpec[] = [
  {
    name: 'telegram',
    label: 'Telegram',
    hint: 'a bot from @BotFather',
    setup: async (p, io, deps, st) => {
      const tg = { ...st.config.channels.telegram, enabled: true };
      io.out(`  1. Open https://t.me/BotFather and send /newbot\n  2. Pick a display name, then a username ending in "bot"\n  3. Copy the token it gives you\n`);
      if (!p.interactive) tg.tokenEnv = await p.text({ id: 'telegram-token-env', message: 'Name of the variable or secret that holds the Telegram token', default: tg.tokenEnv, validate: validEnvName });
      const r = await checked(p, io, deps, st, {
        what: 'telegram',
        consentHelp: 'For example Telegram getMe, which shows your bot’s name.',
        enter: (fresh) => secretStep(p, io, deps, st, { id: 'telegram-token', name: tg.tokenEnv, label: 'Telegram bot token', help: 'It looks like 123456789:AA…', required: true }, fresh),
        check: (token) => checkTelegram(token ?? '', deps.fetch),
        canRetry: true,
      });
      if (r?.ok && 'username' in r) st.bots.telegram = `@${(r as { username: string }).username}`;
      st.config.channels.telegram = tg;
    },
  },
  {
    name: 'discord',
    label: 'Discord',
    hint: 'a bot with a token',
    setup: async (p, io, deps, st) => {
      const dc = { ...st.config.channels.discord, enabled: true };
      io.out(
        `  1. https://discord.com/developers/applications → New Application → Bot → Reset Token, and copy it\n` +
          `  2. On the same page, turn on Message Content Intent (Privileged Gateway Intents)\n` +
          `  3. Garnet answers direct messages: share a server with the bot, then DM it\n`,
      );
      if (!p.interactive) dc.tokenEnv = await p.text({ id: 'discord-token-env', message: 'Name of the variable or secret that holds the Discord token', default: dc.tokenEnv, validate: validEnvName });
      const r = await checked(p, io, deps, st, {
        what: 'discord',
        consentHelp: 'For example Discord /users/@me, which shows your bot’s name.',
        enter: (fresh) => secretStep(p, io, deps, st, { id: 'discord-token', name: dc.tokenEnv, label: 'Discord bot token', help: 'From the Bot page of your application.', required: true }, fresh),
        check: (token) => checkDiscord(token ?? '', deps.fetch),
        canRetry: true,
      });
      if (r?.ok && 'username' in r) st.bots.discord = (r as { username: string }).username;
      st.config.channels.discord = dc;
    },
  },
  {
    name: 'signal',
    label: 'Signal',
    hint: 'needs signal-cli and a phone number for the bot',
    setup: async (p, io, deps, st) => {
      const sg = { ...st.config.channels.signal, enabled: true };
      sg.account = await p.text({ id: 'signal-number', message: "The bot's Signal number", help: 'International format, e.g. +15551234567', ...(sg.account ? { default: sg.account } : {}), validate: (v) => (E164.test(v) ? null : 'Use + and digits only, e.g. +15551234567.') });
      sg.baseUrl = await p.text({ id: 'signal-url', message: 'signal-cli daemon address', default: sg.baseUrl, validate: validUrl });
      io.out(`  Keep the daemon running: ${deps.style.bold(`signal-cli -a ${sg.account} daemon --http ${new URL(sg.baseUrl).host}`)}\n`);
      const baseUrl = sg.baseUrl;
      await checked(p, io, deps, st, {
        what: 'signal',
        consentHelp: 'For example a request to the local signal-cli daemon.',
        enter: async () => undefined,
        check: () => checkSignal(baseUrl, deps.fetch),
        canRetry: false,
        needsValue: false,
      });
      st.config.channels.signal = sg;
    },
  },
];

const CHANNEL_NAMES = CHANNELS.map((c) => c.name);
const enabledChannels = (c: GarnetConfig): ChannelName[] => CHANNEL_NAMES.filter((n) => c.channels[n].enabled);

/**
 * One checklist for all channels (already enabled ones ticked), then each ticked channel is set up in turn.
 * Unticking an enabled channel asks first; a script that passes --no-<channel> has already decided.
 */
async function channelsStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  heading(io, s, 'Channels');
  io.out(`  ${s.muted('Reach Garnet from your phone. Each channel is optional; you can add them later.')}\n`);
  const before = enabledChannels(st.config);
  const picked = await p.multiselect<ChannelName>({
    id: 'channels',
    message: 'Which channels do you want to connect?',
    help: 'Pick as many as you like, or none. You set up each one in turn.',
    choices: CHANNELS.map((c) => ({ value: c.name, label: c.label, hint: before.includes(c.name) ? `${c.hint} · set up now` : c.hint })),
    default: before,
  });
  for (const spec of CHANNELS) {
    if (picked.includes(spec.name) || !before.includes(spec.name)) continue;
    const off = await p.confirm({
      id: `disable-${spec.name}`,
      message: `Turn off ${spec.label}? Garnet will stop answering there. Its token stays where it is.`,
      default: false,
      auto: true,
    });
    if (off) st.config.channels[spec.name].enabled = false;
  }
  // Declining to turn a channel off keeps it as it is; only the ticked ones are set up.
  const todo = CHANNELS.filter((c) => picked.includes(c.name));
  for (const [i, spec] of todo.entries()) {
    if (todo.length > 1) io.out(`\n${s.bold(`${spec.label} (${i + 1} of ${todo.length})`)}\n`);
    await spec.setup(p, io, deps, st);
  }
}

// ---------- save ----------

function save(io: Io, deps: SetupDeps, st: State): void {
  const s = deps.style;
  const config = parseConfig(st.config); // throws before anything is written if invalid
  if (st.keyFile) {
    if (!existsSync(st.keyFile)) {
      mkdirSync(resolve(st.keyFile, '..'), { recursive: true, mode: 0o700 });
      writePrivateFile(st.keyFile, randomBytes(32).toString('base64') + '\n');
      io.out(`  ${s.ok('✓')} Created the key file ${st.keyFile}. Back it up somewhere safe.\n`);
    }
    // Throws a clear error if an existing file is unusable (for example too open).
    unlockFrom({ [KEY_FILE_ENV]: st.keyFile });
    setInEnvFile(deps.home, { [KEY_FILE_ENV]: st.keyFile });
    deps.env[KEY_FILE_ENV] = st.keyFile;
  }
  const encrypted = [...st.secrets].filter(([, v]) => v.storage === 'encrypted');
  const plain = [...st.secrets].filter(([, v]) => v.storage === 'env-file');
  if (encrypted.length) {
    const store = openSecretStore(deps.home, deps.env, deps.kdf ? { kdf: deps.kdf } : {});
    store.setMany(Object.fromEntries(encrypted.map(([n, v]) => [n, v.value])));
    const names = encrypted.map(([n]) => n);
    // A copy in the env file would win over the store; move it out.
    const moved = removeFromEnvFile(deps.home, names);
    io.out(`  ${s.ok('✓')} Encrypted ${names.join(', ')} in ${store.file}.${moved.length ? ` Removed the plain-text copy of ${moved.join(', ')} from ${deps.home}/env.` : ''}\n`);
    for (const n of names) {
      if (deps.env[n] && !moved.includes(n) && deps.env[n] !== st.secrets.get(n)?.value) {
        io.out(`  ${s.warn('!')} ${n} is also set in your environment, which takes precedence over the store. Unset it to use the stored value.\n`);
      }
    }
  }
  if (plain.length) {
    setInEnvFile(deps.home, Object.fromEntries(plain.map(([n, v]) => [n, v.value])));
    io.out(`  ${s.ok('✓')} Wrote ${plain.map(([n]) => n).join(', ')} to ${deps.home}/env (mode 600).\n`);
  }
  // Last, so a failure above leaves an invalid config.json where it was.
  if (st.resetFrom) {
    const backup = `${st.resetFrom}.bak-${(deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(st.resetFrom, backup);
    io.out(`  Kept the old config as ${backup}.\n`);
  }
  writeConfig(deps.home, config);
  mkdirSync(pathsFor(deps.home, config).workspace, { recursive: true });
  st.config = config;
  io.out(`  ${s.ok('✓')} Saved ${join(deps.home, 'config.json')}.\n`);
}

// ---------- service ----------

type ServiceOutcome = 'installed' | 'restarted' | 'failed' | 'skipped' | 'unsupported';

async function serviceStep(p: Prompter, io: Io, deps: SetupDeps, st: State, asked: boolean): Promise<ServiceOutcome> {
  const s = deps.style;
  const svc = deps.service;
  if (!svc) return 'unsupported';
  const anyChannel = enabledChannels(st.config).length > 0;
  const installed = svc.installed();
  heading(io, s, 'Background service');
  if (installed && !asked) {
    if (!(await p.confirm({ id: 'service', message: `Restart the ${svc.label} so it uses the new settings?`, default: true, auto: false }))) return 'skipped';
    return report(io, s, await svc.restart(), 'restarted');
  }
  const want = await p.confirm({
    id: 'service',
    message: installed ? `Reinstall and restart the ${svc.label}?` : `Keep Garnet running in the background (${svc.label}, starts at login)?`,
    help: anyChannel ? 'Your channels only work while Garnet runs.' : 'Useful once a channel or the API is on; `garnet start` runs it in the foreground instead.',
    default: anyChannel || installed,
    auto: false,
  });
  if (!want) return 'skipped';
  if (st.storage === 'env') io.out(`  ${s.warn('!')} The service does not see variables from your shell. Put them in ${deps.home}/env.\n`);
  const result = await svc.install();
  const outcome = report(io, s, result, 'installed');
  if (outcome === 'installed' && installed) return report(io, s, await svc.restart(), 'restarted');
  return outcome;
}

function report(io: Io, s: Style, r: ServiceResult, success: ServiceOutcome): ServiceOutcome {
  for (const c of r.commands) {
    io.out(`  ${c.code === 0 ? s.ok('✓') : s.bad('✗')} ${c.cmd.join(' ')}${c.code === 0 ? '' : ` (exit ${c.code})${c.stderr.trim() ? `: ${c.stderr.trim().split('\n')[0]}` : ''}`}\n`);
  }
  for (const n of r.notes) io.out(`  ${s.muted(n)}\n`);
  return r.ok ? success : 'failed';
}

// ---------- pairing ----------

async function pairingStep(p: Prompter, io: Io, deps: SetupDeps, st: State, service: ServiceOutcome): Promise<void> {
  const s = deps.style;
  const channels = enabledChannels(st.config);
  if (!p.interactive || !channels.length) return;
  const running = service === 'installed' || service === 'restarted';
  heading(io, s, 'Pairing');
  io.out(`  ${s.muted('Garnet only talks to people you approve. The first message from a new account gets a pairing code.')}\n`);
  const go = await p.confirm({
    id: 'pair',
    message: 'Pair your own account now?',
    help: running ? 'The service is running.' : 'Garnet must be running: start `garnet start` in another terminal first.',
    default: running,
  });
  if (!go) return;
  const where = channels.map((c) => (c === 'telegram' && st.bots.telegram ? `${st.bots.telegram} on Telegram` : c === 'discord' && st.bots.discord ? `${st.bots.discord} on Discord` : c === 'signal' ? `${st.config.channels.signal.account} on Signal` : `your ${c} bot`));
  const db = deps.pairing();
  try {
    for (let tries = 0; tries < 20; tries++) {
      const answer = await p.text({ id: 'pair-wait', message: `Send a message to ${where.join(' or ')}, then press Enter`, help: tries ? undefined : 'Type "skip" to do this later.', default: '' });
      if (answer.toLowerCase() === 'skip') break;
      const pending = db.pending();
      if (!pending.length) {
        io.out(`  ${s.muted('No pairing request yet. Did the bot answer with a code? If not, check `garnet doctor`.')}\n`);
        continue;
      }
      let approved = 0;
      for (const req of pending) {
        const who = `${req.senderName ?? req.senderId} on ${req.channel}`;
        if (await p.confirm({ id: 'pair-approve', message: `Approve ${who} (code ${req.code})?`, help: 'Only approve yourself or people you trust.', default: true })) {
          if (db.approve(req.code)) {
            io.out(`  ${s.ok('✓')} Paired ${who}. Garnet will greet them.\n`);
            approved++;
          }
        }
      }
      if (approved) return;
    }
    io.out(`  Later: message the bot, then run \`garnet pair list\` and \`garnet pair approve <code>\`.\n`);
  } finally {
    db.close();
  }
}

// ---------- summary ----------

function keyState(deps: SetupDeps, st: State, name: string): string {
  const f = lookup(deps, st, name);
  return f.found ? `${name} (${f.where})` : `${name} (not set yet)`;
}

function summary(st: State, deps: SetupDeps, service?: ServiceOutcome): string {
  const c = st.config;
  const s = deps.style;
  const active = activeProvider(c);
  const provider = providerOf(active.model);
  const persona = readPersona(c.persona);
  const channels = enabledChannels(c);
  const rows: [string, string][] = [
    ['Model', provider === 'fake' ? 'offline demo model (scripted replies)' : `${active.name === DEFAULT_PROVIDER ? '' : `${active.name}: `}${provider} · ${active.model.name}${active.model.baseUrl ? ` · ${active.model.baseUrl}` : ''}`],
  ];
  if (provider !== 'fake' && provider !== 'local') rows.push(['Key', keyState(deps, st, keyEnvOf(active.model))]);
  rows.push(['Persona', `${persona.name}${persona.owner ? `, working for ${persona.owner}` : ''}`]);
  rows.push([
    'Channels',
    channels.length
      ? channels
          .map((n) => (n === 'signal' ? `signal ${c.channels.signal.account}` : `${n}${st.bots[n] ? ` ${st.bots[n]}` : ''} · ${keyState(deps, st, c.channels[n].tokenEnv)}`))
          .join('; ')
      : 'none',
  ]);
  rows.push(['Tools', toolsSummary(c)]);
  const extras = integrationsSummary(c);
  rows.push(['Services', `${extras.connectors} · skills: ${extras.skills}`]);
  rows.push(['Voice', voiceSummary(c)]);
  rows.push(['Limits', `${c.timezone ?? 'host time zone'} · ${preferencesSummary(c)}`]);
  if (deps.service) rows.push(['Service', deps.service.installed() ? `${deps.service.label} installed${service === 'failed' ? ', but not running' : ''}` : 'not installed']);
  return rows.map(([k, v]) => `  ${s.muted(k.padEnd(9))} ${v}\n`).join('');
}

function nextSteps(st: State, deps: SetupDeps, service: ServiceOutcome): string {
  const s = deps.style;
  const c = st.config;
  const channels = enabledChannels(c);
  const lines: string[] = [`\n${s.accent('◆')} ${s.bold('Garnet is ready.')}\n`, summary(st, deps, service)];
  if (st.todo.length) {
    lines.push(`\n${s.bold('Still to do')}\n`);
    for (const t of st.todo) lines.push(`  ${s.warn('!')} ${t}\n`);
  }
  lines.push(`\n${s.bold('Next')}\n`);
  const step = (cmd: string, why: string) => lines.push(`  ${s.accent(cmd.padEnd(22))} ${why}\n`);
  step(activeProvider(c).model.provider === 'fake' ? 'garnet chat --fake' : 'garnet chat', 'talk to Garnet in this terminal');
  if (channels.length && service !== 'installed' && service !== 'restarted') step('garnet start', 'run Garnet for your channels (or `garnet service install`)');
  if (channels.length) step('garnet pair list', 'see and approve who wants to talk to Garnet');
  if (c.permissions.exec !== 'deny') step('garnet sandbox check', 'make sure commands can run');
  step('garnet doctor', 'check that everything is wired up');
  step('garnet setup', 'change any of this later');
  step('garnet dashboard', 'open the web dashboard (optional)');
  if (service === 'failed') lines.push(`\n  ${s.warn('!')} The background service did not start cleanly; see the output above, or run \`garnet start\` to see errors in the foreground.\n`);
  return lines.join('');
}
