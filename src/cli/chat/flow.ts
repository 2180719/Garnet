// What `garnet chat --onboard` adds to either chat UI: a first message sent by
// the CLI, and a check after every turn that can end the chat in favour of the form.
import type { TaskStatus } from '../../contracts/index.ts';
import type { Verdict } from '../../onboarding/index.ts';
import type { Prompter } from '../setup/prompt.ts';

export type OnboardFlow = {
  /** The first user message, sent as soon as the chat opens. */
  kickoff: string;
  /** Called after each finished turn (also after a failed one). */
  check: (status: TaskStatus) => Verdict;
  /** Asks the same questions as the setup form and saves the answers. Used by the plain chat inline. */
  form: (p: Pick<Prompter, 'text'>, say: (text: string) => void) => Promise<void>;
};
