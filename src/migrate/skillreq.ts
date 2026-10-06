// What an imported skill needs (binaries, secrets, tools), read from its frontmatter and body,
// and the Hermes bundled-skill hash used to tell edited bundled skills from pristine ones.
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { isRecord, tryJson5 } from './json5.ts';
import type { Scanner } from './safefs.ts';
import type { SkillRequirements, Source } from './types.ts';

/**
 * Tools of OpenClaw and Hermes that skills call by name. A skill whose body mentions one Garnet has
 * not registered is flagged. Names Garnet may gain later (web_fetch, web_search…) are checked against
 * the live registry, so the flag disappears once the tool exists.
 */
const FOREIGN_TOOLS = [
  'web_search',
  'web_extract',
  'web_fetch',
  'browser_navigate',
  'browser_click',
  'browser_snapshot',
  'execute_code',
  'delegate_task',
  'cronjob',
  'send_message',
  'vision_analyze',
  'image_generate',
  'text_to_speech',
  'session_search',
  'search_files',
  'memory_search',
];
/** Old shell tool names; Garnet's equivalent is run_command. */
const SHELL_TOOLS = ['terminal', 'exec', 'bash', 'process'];

const NAME = /^[A-Za-z0-9_.+-]{1,64}$/;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && NAME.test(x.trim())).map((x) => x.trim()) : []);

/** YAML flow (`[a, b]`) or block (`- a`) list under `key:` inside an indented block. Minimal by design. */
function yamlList(block: string, key: string): string[] {
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^(\\s*)${key}\\s*:\\s*(.*)$`).exec(lines[i]!);
    if (!m) continue;
    const rest = m[2]!.trim();
    if (rest.startsWith('[')) return rest.replace(/^\[|\]\s*$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => NAME.test(s));
    if (rest) return NAME.test(rest) ? [rest] : [];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s+(.+)$/.exec(lines[j]!);
      if (!item) break;
      const v = item[1]!.trim().replace(/^["']|["']$/g, '');
      if (NAME.test(v)) out.push(v);
    }
    return out;
  }
  return [];
}

export function emptyRequirements(): SkillRequirements {
  return { bins: [], anyBin: false, env: [], tools: [], os: [] };
}

/**
 * Requirements from the frontmatter: OpenClaw `metadata: { openclaw: { requires: { bins, anyBins, env }, os } }`
 * (JSON5), Hermes `prerequisites: { commands, env_vars }` and `platforms` (YAML).
 * Returns the requirements and the original `metadata` as one-line JSON (kept on the Garnet skill).
 */
export function frontmatterRequirements(raw: Record<string, string>): { requires: SkillRequirements; metadata: string | null } {
  const req = emptyRequirements();
  let metadata: string | null = null;
  const meta = raw.metadata !== undefined ? tryJson5(raw.metadata) : null;
  if (isRecord(meta)) {
    metadata = JSON.stringify(meta);
    for (const v of Object.values(meta)) {
      if (!isRecord(v)) continue;
      const r = isRecord(v.requires) ? v.requires : {};
      req.bins.push(...list(r.bins));
      const any = list(r.anyBins);
      if (any.length && !req.bins.length) {
        req.bins.push(...any);
        req.anyBin = true;
      }
      req.env.push(...list(r.env));
      req.os.push(...list(v.os));
    }
  } else if (raw.metadata !== undefined && raw.metadata.trim()) {
    // YAML metadata (Hermes): keep it as one line of text so nothing is lost.
    metadata = JSON.stringify(raw.metadata.trim());
  }
  if (raw.prerequisites !== undefined) {
    req.bins.push(...yamlList(raw.prerequisites, 'commands'));
    req.env.push(...yamlList(raw.prerequisites, 'env_vars'));
  }
  if (raw.platforms !== undefined) req.os.push(...yamlList(`platforms: ${raw.platforms}`, 'platforms'));
  req.bins = [...new Set(req.bins)];
  req.env = [...new Set(req.env)];
  req.os = [...new Set(req.os)];
  return { requires: req, metadata };
}

/** Tool names the body refers to that Garnet does not have. */
export function missingTools(body: string, garnetTools: string[]): string[] {
  const have = new Set(garnetTools);
  const out: string[] = [];
  for (const t of FOREIGN_TOOLS) if (!have.has(t) && new RegExp(`\\b${t}\\b`).test(body)) out.push(t);
  if (/\bbrowser_[a-z_]+\b/.test(body) && !garnetTools.some((t) => t.startsWith('browser_')) && !out.some((t) => t.startsWith('browser_'))) out.push('browser');
  return out;
}

/** Whether the body reaches for a shell (old shell tool names, or fenced shell commands). */
export function usesShell(body: string): boolean {
  return SHELL_TOOLS.some((t) => new RegExp(`\`${t}\`|\\b${t}\\(|\\b${t} tool\\b`).test(body)) || /```(?:sh|bash|shell|zsh)\n/.test(body);
}

/** Default PATH lookup: an executable file named `name` in a PATH directory. */
export function onPath(name: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!NAME.test(name) || name.includes('/')) return false;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Placeholders skills use for their own folder. */
export function rewriteBaseDir(body: string, source: Source, dir: string): { text: string; changed: boolean } {
  let text = body.replaceAll('{baseDir}', dir);
  if (source === 'hermes') text = text.replace(/\$\{HERMES_SKILL_DIR\}|\$HERMES_SKILL_DIR\b|\bSKILL_DIR\b/g, dir);
  return { text, changed: text !== body };
}

/**
 * Hermes' bundled-skill hash (tools/skills_sync.py `_dir_hash`): MD5 over every file under the skill
 * directory in sorted path order, each contributing its relative path then its bytes, skipping Python
 * runtime caches. Returns null when a file cannot be read through the scanner (symlink escape, >1 MB).
 */
export function hermesDirHash(sc: Scanner, dir: string): string | null {
  const CACHE = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
  const files: { parts: string[]; abs: string }[] = [];
  let ok = true;
  const walk = (abs: string, parts: string[], depth: number): void => {
    if (depth > 8) return;
    for (const e of sc.list(abs)) {
      if (e.dir) {
        if (!CACHE.has(e.name)) walk(join(abs, e.name), [...parts, e.name], depth + 1);
      } else {
        const p = [...parts, e.name];
        if (/\.py[co]$/.test(e.name) && sc.exists(join(abs, e.name.replace(/\.py[co]$/, '.py')))) continue;
        files.push({ parts: p, abs: join(abs, e.name) });
      }
    }
  };
  walk(dir, [], 0);
  // Python sorts Path objects by their parts.
  files.sort((a, b) => {
    for (let i = 0; i < Math.min(a.parts.length, b.parts.length); i++) {
      if (a.parts[i] !== b.parts[i]) return a.parts[i]! < b.parts[i]! ? -1 : 1;
    }
    return a.parts.length - b.parts.length;
  });
  const h = createHash('md5');
  for (const f of files) {
    const data = sc.readBuffer(f.abs);
    if (!data) {
      ok = false;
      break;
    }
    h.update(f.parts.join('/'), 'utf8');
    h.update(data);
  }
  return ok ? h.digest('hex') : null;
}
