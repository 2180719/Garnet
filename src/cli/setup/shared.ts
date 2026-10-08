// Types and small helpers shared by the setup steps (wizard.ts and the step files beside it).
import type { GarnetConfig } from '../../config/index.ts';
import type { KdfParams } from '../../secrets/index.ts';
import type { ServiceResult } from '../../service/index.ts';
import type { Io } from '../main.ts';
import type { FetchFn } from './checks.ts';
import type { Prompter, Style } from './prompt.ts';

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
  /** Where the approval mode is stored; absent until the permission policy exposes the setting (the step is then skipped). */
  approvalMode?: ApprovalBinding;
  /** The host's IANA time zone, offered as the default for the time zone question. */
  hostTimeZone?: () => string;
  /** Pending pairing requests in Garnet's database (written by the running service). */
  pairing: () => { pending: () => Pairing[]; approve: (code: string) => Pairing | null; close: () => void };
};

/** How requests that would need approval are settled (see approvals.ts). Mirrors the policy's `permissions.mode`. */
export type ApprovalMode = 'default' | 'ask-all' | 'allow-all' | 'custom' | 'reviewer';

/** What `custom` and `reviewer` need besides the mode itself. */
export type ApprovalOptions = { rulesFile?: string; reviewer?: string };

/**
 * Where the approval mode lives in config. The permission policy owns the setting; setup only reads and
 * writes it through this binding, so the step needs no change when the setting's shape does.
 */
export type ApprovalBinding = {
  read: (config: GarnetConfig) => ApprovalMode;
  /** A copy of `config` with the mode set (and the options that mode uses). */
  write: (config: GarnetConfig, mode: ApprovalMode, options: ApprovalOptions) => GarnetConfig;
  /** The current options, offered as defaults. */
  options: (config: GarnetConfig) => ApprovalOptions;
  /** Modes the running version implements; the others are listed as coming soon and cannot be picked. */
  available: readonly ApprovalMode[];
};

export type ImportDraft = {
  get: () => string | undefined;
  set: (persona: string) => void;
  config: () => GarnetConfig;
  setConfig: (config: GarnetConfig) => void;
  ask: Prompter;
};

export type Storage = 'encrypted' | 'env-file' | 'env';

export type State = {
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

export const validUrl = (v: string): string | null => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Use an http:// or https:// URL.';
  } catch {
    return 'That is not a URL.';
  }
};
export const required = (what: string) => (v: string) => (v.trim() ? null : `Enter ${what}.`);
export const validEnvName = (v: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? null : 'Use letters, digits and _ (like an environment variable).');

export const heading = (io: Io, s: Style, n: string) => io.out(`\n${s.accent('◆')} ${s.bold(n)}\n`);
