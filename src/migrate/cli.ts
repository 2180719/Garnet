// `ruby import <openclaw|hermes> [--from <dir>] [--apply]` without depending on the composition root:
// the caller injects the stores and the persona accessors.
import { applyImport } from './apply.ts';
import { formatPlan, formatResult } from './format.ts';
import { defaultSourceDir, planImport } from './plan.ts';
import { SOURCES, type ImportDeps, type Source } from './types.ts';

export const IMPORT_USAGE = 'Usage: ruby import <openclaw|hermes> [--from <dir>] [--apply]\n  Without --apply this only prints what would be imported.\n';

export function runImport(args: string[], io: { out(t: string): void; err(t: string): void }, deps: ImportDeps): number {
  const rest = [...args];
  const apply = rest.includes('--apply');
  const fi = rest.indexOf('--from');
  const from = fi >= 0 ? rest[fi + 1] : undefined;
  if (fi >= 0 && !from) {
    io.err(IMPORT_USAGE);
    return 2;
  }
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1));
  const source = positional[0] as Source | undefined;
  if (!source || !SOURCES.includes(source)) {
    io.err(IMPORT_USAGE);
    return 2;
  }
  try {
    const plan = planImport(source, from ?? defaultSourceDir(source));
    io.out(formatPlan(plan));
    if (!apply) {
      io.out('\nDry run: nothing was changed. Re-run with --apply to import.\n');
      return 0;
    }
    io.out(`\n${formatResult(applyImport(plan, deps))}`);
    io.out('Review with `ruby memory show` and `ruby skills`. Secrets were not imported.\n');
    return 0;
  } catch (e) {
    io.err(`Import failed: ${(e as Error).message}\n`);
    return 1;
  }
}
