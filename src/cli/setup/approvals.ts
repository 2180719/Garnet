// The approval-mode question: how requests that need the owner's approval are settled. The permission policy
// owns the setting; this step reads and writes it through `deps.approvalMode` (see ApprovalBinding in shared.ts)
// and is skipped while no binding is wired in.
import { isAbsolute } from 'node:path';
import { listProviders } from '../../config/index.ts';
import type { Io } from '../main.ts';
import type { Choice, Prompter } from './prompt.ts';
import { heading, type ApprovalMode, type SetupDeps, type State } from './shared.ts';

const MODES: Choice<ApprovalMode>[] = [
  { value: 'default', label: 'Sensible defaults', hint: 'reads and web lookups go through; writes, commands and messages ask first' },
  { value: 'ask-all', label: 'Ask about everything', hint: 'every tool call waits for your yes' },
  { value: 'reviewer', label: 'Let a second model review', hint: 'an approval model decides; anything unclear still asks you' },
  { value: 'custom', label: 'My own rules file', hint: 'allow and deny patterns that apply everywhere' },
  { value: 'allow-all', label: 'Never ask', hint: 'explicit denies still hold; nothing else waits for you' },
];

export async function approvalsStep(p: Prompter, io: Io, deps: SetupDeps, st: State): Promise<void> {
  const binding = deps.approvalMode;
  if (!binding) return;
  heading(io, deps.style, 'Approvals');
  const current = binding.read(st.config);
  const options = binding.options(st.config);
  const choices = MODES.filter((m) => binding.available.includes(m.value));
  const mode = await p.select<ApprovalMode>({
    id: 'approvals',
    message: 'When Garnet wants to do something that needs approval, what should happen?',
    help: 'You can change this any time with `garnet setup`. Anything set to deny in your permissions stays denied in every mode.',
    choices,
    default: choices.some((c) => c.value === current) ? current : 'default',
    auto: choices.some((c) => c.value === current) ? current : 'default',
  });
  if (mode === 'allow-all') {
    const sure = await p.confirm({
      id: 'approvals-allow-all',
      message: 'Nothing will ask first, including file changes and messages sent on your behalf. Use this mode?',
      help: 'Content Garnet reads from the web can still steer it. A stricter mode keeps you in the loop for that.',
      default: false,
      auto: true,
    });
    if (!sure) return approvalsStep(p, io, { ...deps, approvalMode: { ...binding, available: binding.available.filter((m) => m !== 'allow-all') } }, st);
  }
  const chosen: { rulesFile?: string; reviewer?: string } = {};
  if (mode === 'custom') {
    chosen.rulesFile = await p.text({
      id: 'approval-rules',
      message: 'Where is your rules file?',
      help: 'An absolute path. Requests the file does not cover are settled the sensible-defaults way.',
      ...(options.rulesFile ? { default: options.rulesFile } : {}),
      validate: (v) => (isAbsolute(v) ? null : 'Use an absolute path.'),
    });
  }
  if (mode === 'reviewer') {
    const providers = listProviders(st.config).map((x) => ({ value: x.name, label: x.name, hint: `${x.model.provider} · ${x.model.name}` }));
    chosen.reviewer = await p.select({
      id: 'approval-reviewer',
      message: 'Which of your providers should review requests?',
      help: 'A cheaper, faster model is usually enough. It sees what is being asked, not your conversation.',
      choices: providers,
      default: options.reviewer && providers.some((x) => x.value === options.reviewer) ? options.reviewer : providers[0]!.value,
    });
  }
  st.config = binding.write(st.config, mode, chosen);
}
