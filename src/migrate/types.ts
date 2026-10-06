import type { JobConfig } from '../config/index.ts';

export type Source = 'openclaw' | 'hermes';
export const SOURCES: Source[] = ['openclaw', 'hermes'];

export type MemoryFile = 'memory' | 'user';

export type MemoryAction = {
  /** Garnet memory file this feeds. */
  file: MemoryFile;
  /** Source file, relative to its root (see `CopyAction.root`). */
  from: string;
  /** All valid entries, normalized to single lines (without the "- " prefix), in source order. */
  entries: string[];
  /** How many of `entries` fit an empty Garnet file at the current cap (most recent first). */
  fitCount: number;
  cap: number;
  /** Characters all entries need as "- entry" lines in an empty file. */
  needed: number;
  /** Entries dropped before import, with the reason. */
  skipped: { text: string; reason: string }[];
  /** Entries that were shortened to the per-entry limit. */
  shortened: number;
};

export type PersonaAction = {
  text: string;
  /** Source files (relative) that contributed. */
  from: string[];
  truncated: boolean;
};

export type SkillRequirements = {
  /** Host binaries the skill runs (OpenClaw `requires.bins`/`anyBins`, Hermes `prerequisites.commands`). */
  bins: string[];
  /** True when any one of `bins` is enough (OpenClaw `anyBins`). */
  anyBin: boolean;
  /** Environment variables or secrets it needs (names only). */
  env: string[];
  /** Tools of the old harness that the body refers to and Garnet does not have. */
  tools: string[];
  /** Operating systems it supports, when declared. */
  os: string[];
};

export type SkillAction = {
  /** Normalized Garnet name. */
  name: string;
  /** Name as found in the source (frontmatter name or directory name). */
  originalName: string;
  description: string;
  body: string;
  /** SKILL.md path relative to the source dir. */
  from: string;
  /** Supporting files (scripts, references) that Garnet skills cannot hold; archived under imported/. Relative to the source dir. */
  extraFiles: string[];
  bodyTruncated: boolean;
  /** Set when this skill cannot be imported (e.g. two source skills normalize to one name). */
  conflict?: string;
  /** Extra frontmatter kept on the Garnet skill (single-line values: `metadata`, `requires`). */
  frontmatter: Record<string, string>;
  /** What the skill needs; empty lists when nothing is declared. */
  requires: SkillRequirements;
  /** Human-readable unmet requirements found at plan time (missing binaries, secrets, tools). */
  missing: string[];
  /** Where `{baseDir}`/`SKILL_DIR` was rewritten to, when the skill's files were archived. */
  baseDirRewrite?: string;
  /** A bundled Hermes skill the owner edited (imported because its hash differs from the manifest). */
  editedBundled?: boolean;
};

export type CopyAction = {
  /** Source path relative to `root` (or the source dir). */
  src: string;
  /** Destination relative to the Garnet workspace (always under imported/<source>/). */
  dest: string;
  reason: string;
  /** Absolute directory `src` is relative to, when it is not the source dir (a custom OpenClaw workspace). */
  root?: string;
};

export type JobAction = {
  /** The job's name or id in the source. */
  from: string;
  /** The Garnet job to add (always disabled), or null when it cannot be mapped. */
  job: JobConfig | null;
  /** Why it was skipped (job is null), or what changed in the mapping. */
  notes: string[];
};

export type PairingAction = {
  channel: 'telegram' | 'discord' | 'signal';
  senderId: string;
  displayName: string | null;
  /** Where the ID came from (e.g. "TELEGRAM_ALLOWED_USERS in .env"). */
  from: string;
};

export type NotImported = { what: string; why: string };

export type ImportPlan = {
  source: Source;
  fromDir: string;
  /** Directory the markdown files were read from (OpenClaw: the configured workspace, else <from>/workspace when it exists). */
  contentDir: string;
  /** The assistant's name found in the source (OpenClaw IDENTITY.md), if any. */
  name: string | null;
  memory: MemoryAction[];
  persona: PersonaAction | null;
  skills: SkillAction[];
  copies: CopyAction[];
  /** Scheduled jobs, imported disabled. */
  jobs: JobAction[];
  /** Allowlisted senders that can be paired after the owner confirms (`--pairings`). */
  pairings: PairingAction[];
  notImported: NotImported[];
  /** Environment variable NAMES found in the source's .env/config (never values). */
  envVars: string[];
  /** Channels detected in the source; the user must enable the Garnet equivalents. */
  channels: string[];
  warnings: string[];
};

export type PlanOptions = {
  /** Current Garnet memory caps (defaults to the built-in ones). */
  caps?: { memory: number; user: number };
  /** Names of the tools Garnet has registered (to flag skills that need others). */
  tools?: string[];
  /** Whether a binary is on the PATH (defaults to a PATH scan). */
  hasBin?: (name: string) => boolean;
  /** Whether an environment variable or stored secret with this NAME exists (never its value). */
  hasSecret?: (name: string) => boolean;
  /** Environment for OPENCLAW_WORKSPACE_DIR / HERMES_HOME hints (defaults to process.env). */
  env?: Record<string, string | undefined>;
};

export type PersonaMode = 'auto' | 'keep' | 'merge' | 'replace';

export type ApplyOptions = {
  /** Raise memory caps (up to 20,000) so the imported memory fits. Needs `deps.memory.setLimits`. */
  raiseCaps?: boolean;
  /** Add the plan's allowlisted senders as paired identities. Needs `deps.pairings`. */
  pairings?: boolean;
  /** How to combine an imported persona with an existing one. `auto` merges into a setup-only persona and otherwise keeps the existing one. */
  persona?: PersonaMode;
  /** Add the plan's jobs (disabled). Default true when `deps.jobs` is given. */
  jobs?: boolean;
};

export type ImportDeps = {
  memory: {
    read(ns: string, file: MemoryFile): string;
    write(ns: string, file: MemoryFile, content: string): { used: number; limit: number };
    limit(file: MemoryFile): number;
    /** Raises the caps (writes config.memory and switches the store to the new limits). */
    setLimits?(caps: Partial<Record<MemoryFile, number>>): void;
  };
  skills: {
    root: string;
    create(name: string, description: string, body: string, provenance: 'user', frontmatter?: Record<string, string>): unknown;
  };
  /** Garnet workspace directory; files go under <workspace>/imported/<source>/. */
  workspace: string;
  setPersona: (persona: string) => void;
  /** Current config persona. When set and different, the imported persona is not applied over it. */
  getPersona?: () => string | undefined;
  /** Memory namespace (default "default"). */
  namespace?: string;
  /** Garnet jobs in config.json. */
  jobs?: { ids(): string[]; add(jobs: JobConfig[]): void };
  /** Paired identities (gateway store). */
  pairings?: { has(channel: string, senderId: string): boolean; add(channel: string, senderId: string, displayName: string | null): void };
  /** Asks the owner (setup wizard); without it the flags decide. */
  ask?: {
    confirm(q: { id: string; message: string; help?: string; default: boolean; auto?: boolean }): Promise<boolean>;
    select<T extends string>(q: { id: string; message: string; help?: string; choices: { value: T; label: string }[]; default?: T; auto?: T }): Promise<T>;
  };
  /** Planning inputs the caller knows (registered tools, secret names). */
  planOptions?: PlanOptions;
};

export type ApplyResult = {
  memory: { file: MemoryFile; added: number; alreadyPresent: number; omittedForCap: number; used: number; limit: number; raisedFrom?: number }[];
  persona: 'set' | 'merged' | 'replaced' | 'unchanged' | 'kept-existing' | 'none';
  /** Set when the persona was merged or kept: what the owner should know. */
  personaNote?: string;
  skills: { name: string; status: 'created' | 'exists' | 'skipped' | 'failed'; detail?: string }[];
  copied: { dest: string; status: 'copied' | 'exists' | 'failed'; detail?: string }[];
  jobs: { id: string; status: 'added' | 'exists' | 'skipped' | 'failed'; detail?: string }[];
  pairings: { channel: string; senderId: string; status: 'added' | 'exists' | 'not-requested' }[];
};
