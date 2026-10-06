export type Source = 'openclaw' | 'hermes';
export const SOURCES: Source[] = ['openclaw', 'hermes'];

export type MemoryAction = {
  /** Ruby memory file this feeds. */
  file: 'memory' | 'user';
  /** Source file, relative to the source dir. */
  from: string;
  /** All valid entries, normalized to single lines (without the "- " prefix), in source order. */
  entries: string[];
  /** How many of `entries` fit an empty Ruby file at the default cap (most recent first). */
  fitCount: number;
  cap: number;
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

export type SkillAction = {
  /** Normalized Ruby name. */
  name: string;
  /** Name as found in the source (frontmatter name or directory name). */
  originalName: string;
  description: string;
  body: string;
  /** SKILL.md path relative to the source dir. */
  from: string;
  /** Supporting files (scripts, references) that Ruby skills cannot hold; archived under imported/. Relative to the source dir. */
  extraFiles: string[];
  bodyTruncated: boolean;
  /** Set when this skill cannot be imported (e.g. two source skills normalize to one name). */
  conflict?: string;
};

export type CopyAction = {
  /** Source path relative to the source dir. */
  src: string;
  /** Destination relative to the Ruby workspace. */
  dest: string;
  reason: string;
};

export type NotImported = { what: string; why: string };

export type ImportPlan = {
  source: Source;
  fromDir: string;
  /** Directory the markdown files were read from (OpenClaw: <from>/workspace when it exists). */
  contentDir: string;
  memory: MemoryAction[];
  persona: PersonaAction | null;
  skills: SkillAction[];
  copies: CopyAction[];
  notImported: NotImported[];
  /** Environment variable NAMES found in the source's .env/config (never values). */
  envVars: string[];
  /** Channels detected in the source; the user must enable the Ruby equivalents. */
  channels: string[];
  warnings: string[];
};

export type ImportDeps = {
  memory: {
    read(ns: string, file: 'memory' | 'user'): string;
    write(ns: string, file: 'memory' | 'user', content: string): { used: number; limit: number };
    limit(file: 'memory' | 'user'): number;
  };
  skills: {
    root: string;
    create(name: string, description: string, body: string, provenance: 'user'): unknown;
  };
  /** Ruby workspace directory; files go under <workspace>/imported/<source>/. */
  workspace: string;
  setPersona: (persona: string) => void;
  /** Current config persona. When set and different, the imported persona is not applied over it. */
  getPersona?: () => string | undefined;
  /** Memory namespace (default "default"). */
  namespace?: string;
};

export type ApplyResult = {
  memory: { file: 'memory' | 'user'; added: number; alreadyPresent: number; omittedForCap: number; used: number; limit: number }[];
  persona: 'set' | 'unchanged' | 'kept-existing' | 'none';
  skills: { name: string; status: 'created' | 'exists' | 'skipped' | 'failed'; detail?: string }[];
  copied: { dest: string; status: 'copied' | 'exists' | 'failed'; detail?: string }[];
};
