// Secrets in the wizard: finding a key that is already set, choosing where new ones are stored, asking for one,
// and the optional live check that follows. Values go to the encrypted store or <home>/env at save time, never config.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from '../../config/index.ts';
import { GarnetError, errorMessage } from '../../contracts/index.ts';
import { KEY_FILE_ENV, PASSPHRASE_ENV, isInside, openSecretStore, secretsFile, unlockFrom } from '../../secrets/index.ts';
import type { Io } from '../main.ts';
import type { CheckResult } from './checks.ts';
import type { Choice, Prompter } from './prompt.ts';
import type { SetupDeps, State, Storage } from './shared.ts';

// ---------- secrets ----------

export type SecretSpec = { id: string; name: string; label: string; help: string; required: boolean };

export type Found = { found: boolean; where: string; value: string | undefined };

export function lookup(deps: SetupDeps, st: State, name: string): Found {
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
export async function secretStep(p: Prompter, io: Io, deps: SetupDeps, st: State, spec: SecretSpec, fresh: boolean): Promise<string | undefined> {
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
export async function checked(
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
