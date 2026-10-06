// `ruby import <openclaw|hermes> [--from <dir>] [--apply] ...` without depending on the composition root:
// the caller injects the stores, the persona accessors and (in the setup wizard) a way to ask the owner.
import { parseArgs } from 'node:util';
import { applyImport, personaHasOwnText } from './apply.ts';
import { formatPlan, formatResult } from './format.ts';
import { defaultSourceDir, planImport } from './plan.ts';
import { SOURCES, type ApplyOptions, type ImportDeps, type ImportPlan, type PersonaMode, type Source } from './types.ts';

export const IMPORT_USAGE = `Usage: ruby import <openclaw|hermes> [--from <dir>] [--apply] [options]
  Without --apply this only prints what would be imported.
  --from <dir>          Source home (default ~/.openclaw or ~/.hermes; honors OPENCLAW_STATE_DIR,
                        OPENCLAW_PROFILE, OPENCLAW_WORKSPACE_DIR and HERMES_HOME)
  --raise-caps          Raise memory caps (up to 20,000 chars) so all imported memory fits
  --pairings            Pair the allowlisted senders listed in the preview
  --persona <mode>      When you already have a persona: keep | merge | replace
                        (default: merge into a persona that only has setup basics, else keep)
  --no-jobs             Do not add the imported jobs (they are added disabled otherwise)
`;

const MODES: PersonaMode[] = ['keep', 'merge', 'replace'];

export async function runImport(args: string[], io: { out(t: string): void; err(t: string): void }, deps: ImportDeps): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      allowNegative: true,
      options: { from: { type: 'string' }, apply: { type: 'boolean' }, 'raise-caps': { type: 'boolean' }, pairings: { type: 'boolean' }, persona: { type: 'string' }, jobs: { type: 'boolean' } },
    }));
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${IMPORT_USAGE}`);
    return 2;
  }
  const source = positionals[0] as Source | undefined;
  const persona = values.persona as string | undefined;
  if (!source || !SOURCES.includes(source) || positionals.length > 1 || (persona !== undefined && !MODES.includes(persona as PersonaMode))) {
    io.err(IMPORT_USAGE);
    return 2;
  }
  try {
    const from = values.from as string | undefined;
    const plan = planImport(source, from ?? defaultSourceDir(source), {
      ...deps.planOptions,
      caps: { memory: deps.memory.limit('memory'), user: deps.memory.limit('user') },
      // Environment hints only apply to the default location; an explicit --from means "read exactly this".
      env: from ? {} : (deps.planOptions?.env ?? process.env),
    });
    io.out(formatPlan(plan));
    const tooBig = plan.memory.some((m) => m.fitCount < m.entries.length);
    if (!values.apply) {
      const hints: string[] = [];
      if (tooBig && deps.memory.setLimits) hints.push('--raise-caps to make room for all of it');
      if (plan.pairings.length && deps.pairings) hints.push('--pairings to pair the allowlisted senders');
      if (plan.persona && personaHasOwnText(deps.getPersona?.())) hints.push('--persona merge|replace to combine it with your current persona');
      io.out(`\nDry run: nothing was changed. Re-run with --apply to import${hints.length ? ` (add ${hints.join(', ')})` : ''}.\n`);
      return 0;
    }
    const opts = await decide(plan, values, deps, tooBig);
    io.out(`\n${formatResult(applyImport(plan, deps, opts))}`);
    io.out('Review with `ruby memory show`, `ruby skills` and `ruby jobs list`. Secrets were not imported.\n');
    return 0;
  } catch (e) {
    io.err(`Import failed: ${(e as Error).message}\n`);
    return 1;
  }
}

/** Flags win; otherwise the setup wizard asks (scripted runs get the safe default: off / keep). */
async function decide(plan: ImportPlan, values: Record<string, string | boolean | undefined>, deps: ImportDeps, tooBig: boolean): Promise<ApplyOptions> {
  const ask = deps.ask;
  const opts: ApplyOptions = { jobs: values.jobs !== false };
  if (typeof values['raise-caps'] === 'boolean') opts.raiseCaps = values['raise-caps'];
  else if (ask && tooBig && deps.memory.setLimits) {
    const need = plan.memory.filter((m) => m.fitCount < m.entries.length).map((m) => `${m.file === 'memory' ? 'MEMORY.md' : 'USER.md'} needs about ${m.needed} chars (cap ${m.cap})`);
    opts.raiseCaps = await ask.confirm({ id: 'import-raise-caps', message: 'Raise the memory caps so everything fits?', help: `${need.join('; ')}. Up to 20,000 each; bigger memory costs tokens on every request.`, default: true, auto: false });
  }
  if (typeof values.pairings === 'boolean') opts.pairings = values.pairings;
  else if (ask && plan.pairings.length && deps.pairings) {
    opts.pairings = await ask.confirm({ id: 'import-pairings', message: `Pair the ${plan.pairings.length} allowlisted sender(s) shown above?`, help: 'They can then message Ruby and approve its actions, like you.', default: false, auto: false });
  }
  if (typeof values.persona === 'string') opts.persona = values.persona as PersonaMode;
  else if (ask && plan.persona && personaHasOwnText(deps.getPersona?.())) {
    opts.persona = await ask.select<PersonaMode>({
      id: 'import-persona',
      message: 'You already have a persona. What should happen to the imported one?',
      choices: [
        { value: 'merge', label: 'Add it after mine' },
        { value: 'replace', label: 'Use it instead of mine' },
        { value: 'keep', label: 'Keep mine only (the original stays archived)' },
      ],
      default: 'merge',
      auto: 'keep',
    });
  }
  return opts;
}
