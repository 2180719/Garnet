// `garnet setup`: a re-runnable wizard for the model, keys, persona, channels,
// importing, the background service and pairing. All input comes through a
// Prompter and all side effects through SetupDeps, so tests script it fully.
// Nothing is written until the owner saves; secrets go to the encrypted store
// or the env file, never into config.
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  DEFAULT_NAME,
  PERSONA_MAX,
  defaultConfig,
  parseConfig,
  parseEnv,
  pathsFor,
  readPersona,
  removeFromEnvFile,
  setInEnvFile,
  writeConfig,
  writePersona,
  type GarnetConfig,
} from '../../config/index.ts';
import { GarnetError, errorMessage } from '../../contracts/index.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, isInside, openSecretStore, secretsFile, unlockFrom, writePrivateFile, type KdfParams } from '../../secrets/index.ts';
import type { ServiceResult } from '../../service/index.ts';
import type { Io } from '../main.ts';
import { checkDiscord, checkModel, checkSignal, checkTelegram, type CheckResult, type FetchFn } from './checks.ts';
import { askBasics } from './persona.ts';
import { sandboxStep } from './sandbox.ts';
import type { Choice, Prompter, Style } from './prompt.ts';

export type ImportSource = { source: 'openclaw' | 'hermes'; dir: string };
export type Pairing = { code: string; channel: string; senderId: string; senderName: string | null };

export type SetupDeps = {
  home: string;
  /** The process environment (with <home>/env already loaded, as `main` does). Updated when setup creates a key file. */
  env: NodeJS.ProcessEnv;
  style: Style;
  /** Where a new key file for the secret store goes (must be outside home). */
  defaultKeyFile: string;
  /** Cheaper key derivation (tests). */
  kdf?: KdfParams;
  /** Used only for checks the owner agreed to. */
  fetch?: FetchFn;
  now?: () => Date;
  /** The background service, or null where it is unsupported. */
  service: {
    label: string;
    installed: () => boolean;
    install: () => Promise<ServiceResult>;
    restart: () => Promise<ServiceResult>;
  } | null;
  /** OpenClaw / Hermes installs found on this machine. */
  importSources: () => ImportSource[];
  /**
   * Runs `garnet import` against the draft: persona and config changes (raised memory caps, imported
   * jobs) land in the draft and are saved with the rest of setup; `ask` puts the import's questions
   * to the owner.
   */
  runImport: (args: string[], draft: ImportDraft) => number | Promise<number>;
  /**
   * Starts the wake-up chat (`garnet chat --onboard`) after setup is saved; resolves with its exit code.
   * Absent where there is nowhere to chat (scripts and tests that do not offer it).
   */
  wake?: (opts: { fake: boolean }) => Promise<number>;
  /** Pending pairing requests in Garnet's database (written by the running service). */
  pairing: () => { pending: () => Pairing[]; approve: (code: string) => Pairing | null; close: () => void };
};

export type ImportDraft = {
  get: () => string | undefined;
  set: (persona: string) => void;
  config: () => GarnetConfig;
  setConfig: (config: GarnetConfig) => void;
  ask: Prompter;
};

type Storage = 'encrypted' | 'env-file' | 'env';
type ProviderChoice = 'anthropic' | 'openrouter' | 'local' | 'openai-compatible' | 'fake';
type Section = 'model' | 'persona' | 'sandbox' | 'channels' | 'import' | 'service' | 'done' | 'quit';

type State = {
  config: GarnetConfig;
  existing: boolean;
  /** An invalid config.json to move aside on save. */
  resetFrom: string | null;
  secrets: Map<string, { value: string; storage: 'encrypted' | 'env-file' }>;
  storage: Storage | null;
  keyFile: string | null;
  consent: boolean | null;
  /** Bot names learned from checks, for the pairing hint and summary. */
  bots: Record<string, string>;
  todo: string[];
  changed: boolean;
  /** The owner chose to set up the persona by talking to the agent, after setup is saved. */
  wake: boolean;
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const LOCAL_URL = 'http://127.0.0.1:11434/v1';
/** Local servers rarely need a key; a dedicated name keeps another provider's key from being sent to them. */
const LOCAL_KEY_ENV = 'LOCAL_MODEL_API_KEY';
const E164 = /^\+[1-9][0-9]{6,14}$/;

const validUrl = (v: string): string | null => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Use an http:// or https:// URL.';
  } catch {
    return 'That is not a URL.';
  }
};
const required = (what: string) => (v: string) => (v.trim() ? null : `Enter ${what}.`);
const validEnvName = (v: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? null : 'Use letters, digits and _ (like an environment variable).');

export function providerOf(m: GarnetConfig['model']): ProviderChoice {
  if (m.provider !== 'openai-compatible') return m.provider;
  if (m.baseUrl && new URL(m.baseUrl).host === 'openrouter.ai') return 'openrouter';
  if (m.baseUrl && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(m.baseUrl).hostname)) return 'local';
  return 'openai-compatible';
}

const PROVIDERS: Choice<ProviderChoice>[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'recommended · key from console.anthropic.com' },
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
      const section = await p.select<Section>({ id: 'section', message: 'What would you like to change?', choices: menu(st, deps), default: 'done' });
      if (section === 'quit') {
        io.out('Nothing was changed.\n');
        return 0;
      }
      if (section === 'done') break;
      if (section === 'service') wantService = true;
      else await runSection(section, p, io, deps, st);
    }
    if (!st.changed && !wantService) {
      io.out('No changes.\n');
      return 0;
    }
  } else {
    if (!st.existing) await importStep(p, io, deps, st);
    await modelStep(p, io, deps, st);
    await personaStep(p, io, deps, st);
    await sandboxSection(p, io, deps, st);
    await channelsStep(p, io, deps, st);
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

function menu(st: State, deps: SetupDeps): Choice<Section>[] {
  const c = st.config;
  const channels = enabledChannels(c);
  const persona = readPersona(c.persona);
  const items: Choice<Section>[] = [
    { value: 'model', label: 'Model and API key', hint: `${providerOf(c.model)} · ${c.model.name}` },
    { value: 'persona', label: 'Name and persona', hint: `${persona.name}${persona.owner ? `, for ${persona.owner}` : ''}` },
    ...(c.permissions.exec === 'deny' ? [] : [{ value: 'sandbox' as const, label: 'Where commands run', hint: sandboxHint(c.sandbox) }]),
    { value: 'channels', label: 'Messaging channels', hint: channels.length ? channels.join(', ') : 'none' },
  ];
  if (deps.importSources().length) items.push({ value: 'import', label: 'Import from OpenClaw or Hermes' });
  if (deps.service) items.push({ value: 'service', label: 'Background service', hint: deps.service.installed() ? 'installed · restart or reinstall' : 'not installed' });
  items.push({ value: 'done', label: 'Save and finish' }, { value: 'quit', label: 'Quit without saving' });
  return items;
}

async function runSection(section: Exclude<Section, 'service' | 'done' | 'quit'>, p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const before = JSON.stringify(st.config) + st.secrets.size;
  if (section === 'model') await modelStep(p, io, deps, st);
  if (section === 'persona') await personaStep(p, io, deps, st);
  if (section === 'sandbox') await sandboxSection(p, io, deps, st);
  if (section === 'channels') await channelsStep(p, io, deps, st);
  if (section === 'import') await importStep(p, io, deps, st);
  if (JSON.stringify(st.config) + st.secrets.size !== before || st.wake) st.changed = true;
}

const heading = (io: Io, s: Style, n: string) => io.out(`\n${s.accent('◆')} ${s.bold(n)}\n`);

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
  const cur = st.config.model;
  const was = providerOf(cur);
  const provider = await p.select<ProviderChoice>({ id: 'provider', message: 'Which model should Garnet think with?', choices: PROVIDERS, default: was });
  const same = provider === was;
  const defaults = defaultConfig().model;
  const m: GarnetConfig['model'] = { ...cur };
  delete m.contextWindow;
  if (!same) delete m.baseUrl;
  if (same && cur.contextWindow) m.contextWindow = cur.contextWindow;

  const askModel = (help: string, def?: string) =>
    p.text({ id: 'model', message: 'Model ID', help, ...(def ? { default: def } : {}), validate: required('a model ID') });
  const askKeyEnv = async (def: string) => (p.interactive ? def : await p.text({ id: 'key-env', message: 'Name of the variable or secret that holds the key', default: def, validate: validEnvName }));

  switch (provider) {
    case 'fake':
      m.provider = 'fake';
      break;
    case 'anthropic':
      m.provider = 'anthropic';
      m.name = await askModel('Press Enter for the default.', same ? cur.name : defaults.name);
      m.apiKeyEnv = await askKeyEnv(same ? cur.apiKeyEnv : 'ANTHROPIC_API_KEY');
      break;
    case 'openrouter':
      m.provider = 'openai-compatible';
      m.baseUrl = OPENROUTER_URL;
      m.name = await askModel('IDs look like provider/model; browse https://openrouter.ai/models. Pick one that supports tools.', same ? cur.name : undefined);
      m.apiKeyEnv = await askKeyEnv(same ? cur.apiKeyEnv : 'OPENROUTER_API_KEY');
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
      m.apiKeyEnv = same ? cur.apiKeyEnv : LOCAL_KEY_ENV;
      break;
    case 'openai-compatible':
      m.provider = 'openai-compatible';
      m.baseUrl = await p.text({ id: 'base-url', message: 'API base URL (ending in /v1)', ...(same && cur.baseUrl ? { default: cur.baseUrl } : {}), validate: validUrl });
      m.name = await askModel('The model ID the API expects.', same ? cur.name : undefined);
      m.apiKeyEnv = await askKeyEnv(same && cur.apiKeyEnv !== 'ANTHROPIC_API_KEY' ? cur.apiKeyEnv : 'OPENAI_API_KEY');
      break;
  }
  st.config.model = m;

  if (provider === 'fake') {
    io.out(`  ${deps.style.muted('The demo model replies from a script. Run `garnet setup` again when you have a key.')}\n`);
    return;
  }
  const keySpec = {
    anthropic: { label: 'Anthropic API key', help: 'Create one at https://console.anthropic.com/settings/keys', required: true },
    openrouter: { label: 'OpenRouter API key', help: 'Create one at https://openrouter.ai/keys', required: true },
    'openai-compatible': { label: 'API key', help: 'Leave empty if the server needs none.', required: false },
    local: null,
  }[provider];
  const host = new URL(m.baseUrl ?? 'https://api.anthropic.com').host;
  await checked(p, io, deps, st, {
    what: 'model',
    consentHelp: `One request to ${host} that lists models; it uses no tokens.`,
    enter: async (fresh) => (keySpec ? secretStep(p, io, deps, st, { id: 'key', name: m.apiKeyEnv, ...keySpec }, fresh) : undefined),
    check: (key) => checkModel(m, key, deps.fetch),
    canRetry: keySpec !== null,
    needsValue: keySpec?.required ?? false,
  });
}

// ---------- secrets ----------

type SecretSpec = { id: string; name: string; label: string; help: string; required: boolean };

type Found = { found: boolean; where: string; value: string | undefined };

function lookup(deps: SetupDeps, st: State, name: string): Found {
  const pending = st.secrets.get(name);
  if (pending) return { found: true, where: pending.storage === 'encrypted' ? 'encrypted store' : `${deps.home}/env`, value: pending.value };
  const envFile = join(deps.home, 'env');
  if (deps.env[name]) {
    const inFile = existsSync(envFile) && parseEnv(readFileSync(envFile, 'utf8')).has(name);
    return { found: true, where: inFile ? `${envFile}, plain text` : 'your environment', value: deps.env[name] };
  }
  const store = openSecretStore(deps.home, deps.env, deps.kdf ? { kdf: deps.kdf } : {});
  if (!store.exists()) return { found: false, where: '', value: undefined };
  try {
    const value = store.get(name);
    return value === undefined ? { found: false, where: '', value: undefined } : { found: true, where: 'encrypted store', value };
  } catch {
    // Locked or unreadable: we cannot tell, so do not claim it is there.
    return { found: false, where: '', value: undefined };
  }
}

function canUnlock(deps: SetupDeps): { ok: true } | { ok: false; why: string | null } {
  try {
    return unlockFrom(deps.env) ? { ok: true } : { ok: false, why: null };
  } catch (e) {
    return { ok: false, why: errorMessage(e) };
  }
}

async function chooseStorage(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<Storage> {
  if (st.storage) return st.storage;
  const s = deps.style;
  const unlock = canUnlock(deps);
  const storeExists = existsSync(secretsFile(deps.home));
  const lockedOut = !unlock.ok && (storeExists || unlock.why !== null);
  const choices: Choice<Storage>[] = [];
  if (!lockedOut) {
    choices.push({ value: 'encrypted', label: 'Encrypted secret store', hint: unlock.ok ? 'recommended' : `recommended · unlocked by a key file kept outside ${deps.home}` });
  }
  choices.push(
    { value: 'env-file', label: `Plain env file (${deps.home}/env, mode 600)`, hint: 'simple; readable by anyone with your account' },
    { value: 'env', label: "I'll set environment variables myself", hint: 'shell profile, systemd or a secrets manager' },
  );
  if (lockedOut) {
    io.out(`  ${s.warn('!')} The encrypted store at ${secretsFile(deps.home)} is locked${unlock.ok ? '' : unlock.why ? `: ${unlock.why}` : ''}. Set ${KEY_FILE_ENV} or ${PASSPHRASE_ENV} and re-run setup to use it.\n`);
  }
  const storage = await p.select<Storage>({ id: 'secrets', message: 'Where should Garnet keep keys and tokens?', choices, default: choices[0]!.value });
  if (storage === 'encrypted' && !unlock.ok) {
    const path = await p.text({
      id: 'key-file',
      message: 'Key file that unlocks the store',
      help: `Created with mode 600. Back it up: without it the store cannot be read. ${KEY_FILE_ENV} pointing at it goes in ${deps.home}/env.`,
      default: deps.defaultKeyFile,
      validate: (v) => (!isAbsolute(v) ? 'Use an absolute path.' : isInside(deps.home, v) ? `Keep it outside ${deps.home}, away from the store it unlocks.` : null),
    });
    st.keyFile = path;
  }
  st.storage = storage;
  return storage;
}

/** Asks for one secret (or keeps the one already set). Returns the value when known, for checks. */
async function secretStep(p: Prompter, io: Io, deps: SetupDeps, st: State, spec: SecretSpec, fresh: boolean): Promise<string | undefined> {
  const s = deps.style;
  const found = lookup(deps, st, spec.name);
  if (found.found && !fresh) {
    const keep = await p.confirm({ id: `keep-${spec.id}`, message: `Keep the ${spec.label} already set as ${spec.name} (${found.where})?`, default: true });
    if (keep) return found.value;
  }
  const storage = await chooseStorage(p, io, deps, st);
  if (storage === 'env') {
    io.out(`  Set ${s.bold(spec.name)} yourself: \`export ${spec.name}=…\` for the terminal, and a ${spec.name}=… line in ${deps.home}/env (mode 600) for the background service.\n`);
    if (spec.required && !found.found) st.todo.push(`Set ${spec.name} (your ${spec.label}).`);
    return found.value;
  }
  const value = await p.secret({ id: spec.id, message: `Paste your ${spec.label}`, help: spec.help });
  if (!value) {
    if (spec.required && !found.found) {
      io.out(`  ${s.warn('!')} Skipped. Add it later with \`garnet secrets set ${spec.name}\`.\n`);
      st.todo.push(`Add your ${spec.label}: garnet secrets set ${spec.name}`);
    }
    return found.value;
  }
  if (/\s/.test(value)) {
    io.out(`  ${s.warn('!')} That contains spaces; keys and tokens never do. Removed them.\n`);
  }
  st.secrets.set(spec.name, { value: value.replace(/\s+/g, ''), storage });
  return st.secrets.get(spec.name)!.value;
}

/**
 * Enters a secret, then (with consent, asked once) checks it live. On a
 * failed check a person may re-enter it; a script fails instead.
 */
async function checked(
  p: Prompter,
  io: Io,
  deps: SetupDeps,
  st: State,
  o: { what: string; consentHelp: string; enter: (fresh: boolean) => Promise<string | undefined>; check: (value: string | undefined) => Promise<CheckResult>; canRetry: boolean; needsValue?: boolean },
): Promise<CheckResult | null> {
  const s = deps.style;
  let fresh = false;
  for (;;) {
    const value = await o.enter(fresh);
    if (o.needsValue !== false && value === undefined) return null;
    if (st.consent === null) {
      st.consent = await p.confirm({ id: 'check', message: 'Check keys and connections with a live request as you go?', help: o.consentHelp, default: true, auto: false });
    }
    if (!st.consent) return null;
    const result = await o.check(value);
    io.out(`  ${!result.ok ? s.bad('✗') : result.warn ? s.warn('!') : s.ok('✓')} ${result.detail}\n`);
    if (result.ok) return result;
    if (!p.interactive) throw new GarnetError('config', `The ${o.what} check failed: ${result.detail}. Nothing was saved.`);
    if (!o.canRetry || !(await p.confirm({ id: `retry-${o.what}`, message: 'Enter it again?', default: true }))) {
      st.todo.push(`Fix the ${o.what} setup (the live check said: ${result.detail}), then run \`garnet doctor\`.`);
      return result;
    }
    fresh = true;
  }
}

// ---------- persona ----------

async function personaStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  heading(io, deps.style, 'Persona');
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
  const provider = providerOf(st.config.model);
  return provider === 'fake' || provider === 'local' || lookup(deps, st, st.config.model.apiKeyEnv).found;
}

/** Runs right after the config is saved, before the service starts. A failure never undoes setup: the form is one command away. */
async function wakeStep(io: Io, deps: SetupDeps, st: State): Promise<void> {
  const s = deps.style;
  io.out(`\n${s.accent('◆')} ${s.bold('Waking your assistant up')}\n  ${s.muted('Say /exit when you are done. If the model cannot use its tools, you will get the short form instead.')}\n\n`);
  try {
    const code = await deps.wake!({ fake: providerOf(st.config.model) === 'fake' });
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

// ---------- sandbox ----------

const sandboxHint = (sb: GarnetConfig['sandbox']): string => (sb.backend === 'ssh' && sb.ssh.host ? `ssh ${sb.ssh.user ? `${sb.ssh.user}@` : ''}${sb.ssh.host}` : sb.backend);

/** Where commands run. Skipped when commands are denied; a script that passes no flag keeps the current backend. */
async function sandboxSection(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  if (st.config.permissions.exec === 'deny') return;
  heading(io, deps.style, 'Commands');
  st.config.sandbox = await sandboxStep(p, st.config.sandbox);
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
  const provider = providerOf(c.model);
  const persona = readPersona(c.persona);
  const channels = enabledChannels(c);
  const rows: [string, string][] = [
    ['Model', provider === 'fake' ? 'offline demo model (scripted replies)' : `${provider} · ${c.model.name}${c.model.baseUrl ? ` · ${c.model.baseUrl}` : ''}`],
  ];
  if (provider !== 'fake' && provider !== 'local') rows.push(['Key', keyState(deps, st, c.model.apiKeyEnv)]);
  rows.push(['Persona', `${persona.name}${persona.owner ? `, working for ${persona.owner}` : ''}`]);
  rows.push([
    'Channels',
    channels.length
      ? channels
          .map((n) => (n === 'signal' ? `signal ${c.channels.signal.account}` : `${n}${st.bots[n] ? ` ${st.bots[n]}` : ''} · ${keyState(deps, st, c.channels[n].tokenEnv)}`))
          .join('; ')
      : 'none',
  ]);
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
  step(c.model.provider === 'fake' ? 'garnet chat --fake' : 'garnet chat', 'talk to Garnet in this terminal');
  if (channels.length && service !== 'installed' && service !== 'restarted') step('garnet start', 'run Garnet for your channels (or `garnet service install`)');
  if (channels.length) step('garnet pair list', 'see and approve who wants to talk to Garnet');
  step('garnet doctor', 'check that everything is wired up');
  step('garnet setup', 'change any of this later');
  step('garnet dashboard', 'open the web dashboard (optional)');
  if (service === 'failed') lines.push(`\n  ${s.warn('!')} The background service did not start cleanly; see the output above, or run \`garnet start\` to see errors in the foreground.\n`);
  return lines.join('');
}
