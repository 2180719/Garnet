// Enforces Ruby's architecture rules. Run with `npm run lint`.
//
// 1. A module may import another module only through its index.ts.
// 2. Only src/main.ts and src/cli/ may import src/main.ts (the composition root).
// 3. External packages are allowlisted per module; node: builtins are always allowed.
// 4. Every module has an AGENTS.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

const PACKAGES: Record<string, string[]> = {
  zod: ['contracts', 'config', 'tools', 'gateway', 'memory', 'skills', 'media', 'scheduler'],
  '@anthropic-ai/sdk': ['models'],
};

const problems: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const moduleOf = (file: string): string | null => {
  const rel = relative(SRC, file);
  return rel.includes(sep) ? rel.split(sep)[0]! : null;
};

for (const file of walk(SRC)) {
  const source = readFileSync(file, 'utf8');
  const from = moduleOf(file);
  const isTest = file.endsWith('.test.ts');
  // Static imports and re-exports, side-effect imports, and dynamic import() with a literal specifier.
  const specs = [
    ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]!);
  for (const spec of specs) {
    const where = `${relative(ROOT, file)}: "${spec}"`;
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      if (!target.startsWith(SRC + sep)) {
        if (!(isTest && target.startsWith(join(ROOT, 'test')))) problems.push(`${where} reaches outside src/`);
        continue;
      }
      if (target === join(SRC, 'main.ts')) {
        if (from !== 'cli' && from !== null) problems.push(`${where} only the CLI may import the composition root`);
        continue;
      }
      const to = moduleOf(target);
      if (to && to !== from && relative(join(SRC, to), target) !== 'index.ts') {
        problems.push(`${where} import from ${to}/index.ts instead of its internals`);
      }
      continue;
    }
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    const allowed = PACKAGES[pkg];
    if (!allowed) problems.push(`${where} unknown dependency (add it to scripts/lint.ts with a reason)`);
    else if (from && !allowed.includes(from) && !isTest) problems.push(`${where} ${pkg} is only allowed in ${allowed.join(', ')}`);
  }
}

for (const name of readdirSync(SRC)) {
  const dir = join(SRC, name);
  if (statSync(dir).isDirectory() && !existsSync(join(dir, 'AGENTS.md'))) problems.push(`src/${name}/ has no AGENTS.md`);
}

if (problems.length) {
  console.error(`Lint found ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Lint OK');
