// The fullscreen `Prompter` for `garnet setup`: every question is a screen in
// the alternate screen. What the wizard prints between questions (notes,
// instructions, check results) is captured, shown above the next question
// while there is room, and printed to the normal screen when setup ends.
import { GarnetError } from '../../contracts/index.ts';
import type { Theme } from '../chat/theme.ts';
import { sanitize, stripAnsi, wrapText } from '../chat/text.ts';
import type { ConfirmAsk, MultiSelectAsk, Prompter, SecretAsk, SelectAsk, TextAsk } from '../setup/prompt.ts';
import { FullscreenSession, type FsInput, type FsOutput } from './fullscreen.ts';
import type { Stage } from './layout.ts';
import { initConfirm, initMultiSelect, initReview, initSecret, initSelect, initText, updatePrompt, viewPrompt, type PromptState, type PromptValue, type ReviewAsk } from './prompts.ts';

/** Setup stages in order; a prompt id belongs to one of them (unknown ids stay in the current stage). */
export const SETUP_STAGES = ['Import & model', 'Persona', 'Channels', 'Save', 'Finish'] as const;

const STAGE_OF: [RegExp, (typeof SETUP_STAGES)[number]][] = [
  [/^(import|import-.*|reset|section|provider|provider-name|model|base-url|key-env|key|keep-key|secrets|key-file|keep-.*|check|retry-.*)$/, 'Import & model'],
  [/^(name|owner|notes|persona.*)$/, 'Persona'],
  [/^(telegram.*|discord.*|signal.*|channels.*)$/, 'Channels'],
  [/^review$/, 'Save'],
  [/^(service|pair-.*)$/, 'Finish'],
];

export function stageOf(id: string): (typeof SETUP_STAGES)[number] | null {
  return STAGE_OF.find(([re]) => re.test(id))?.[1] ?? null;
}

export type LogLine = { stream: 'out' | 'err'; text: string };

export class TuiPrompter implements Prompter {
  readonly interactive = true;
  /** Prompt ids asked, in order (tests). */
  readonly asked: string[] = [];
  /** The screen being answered right now (tests script keys from it). */
  current: PromptState | null = null;
  private readonly session: FullscreenSession;
  private readonly theme: Theme;
  private readonly title: string;
  /** Everything the wizard wrote, in order; printed when the session ends. */
  readonly log: LogLine[] = [];
  private notes: string[] = [];
  private stage: (typeof SETUP_STAGES)[number] = 'Import & model';
  private readonly stages: readonly string[];

  constructor(opts: { input: FsInput; output: FsOutput; theme: Theme; title?: string; processHooks?: boolean; stages?: readonly string[] }) {
    this.session = new FullscreenSession({ input: opts.input, output: opts.output, processHooks: opts.processHooks ?? true });
    this.theme = opts.theme;
    this.title = opts.title ?? 'SETUP';
    this.stages = opts.stages ?? SETUP_STAGES;
  }

  /** An `Io`-shaped sink: the wizard's output goes to the log, not to the alternate screen. */
  capture = (stream: 'out' | 'err') => (text: string): void => {
    this.log.push({ stream, text });
    // The wizard's own banner repeats the screen header.
    for (const line of stripAnsi(text).split('\n')) if (!/^\s*◆ GARNET|^\s*─{10,}\s*$/.test(line)) this.notes.push(line);
  };

  /** Leaves the alternate screen (always safe to call), then hands back what to print on the normal screen. */
  close(): LogLine[] {
    this.session.close();
    return this.log;
  }

  private currentStage(id: string): Stage {
    const s = stageOf(id);
    if (s) {
      this.stage = s;
    }
    const index = Math.max(1, this.stages.indexOf(this.stage) + 1);
    return { index, total: this.stages.length, label: this.stage };
  }

  private ask(state: PromptState, id: string): Promise<PromptValue> {
    this.asked.push(id);
    this.current = state;
    const stage = this.currentStage(id);
    // The tail of the notes that fits is shown; blank edges are trimmed.
    const context = this.notes.flatMap((n) => wrapText(sanitize(n), 100));
    while (context.length && !context[0]!.trim()) context.shift();
    while (context.length && !context[context.length - 1]!.trim()) context.pop();
    this.notes = [];
    const theme = this.theme;
    return this.session.run<PromptState, PromptValue>(
      {
        state,
        update: updatePrompt,
        view: (s, width, height) => viewPrompt(s, width, height, { theme, stage, context: context.map((l) => theme.muted(l)), title: this.title }),
      },
      'Setup',
    );
  }

  async text(q: TextAsk): Promise<string> {
    return (await this.ask(initText(q), q.id)) as string;
  }
  async confirm(q: ConfirmAsk): Promise<boolean> {
    return (await this.ask(initConfirm(q), q.id)) as boolean;
  }
  async select<T extends string>(q: SelectAsk<T>): Promise<T> {
    const value = (await this.ask(initSelect(q as SelectAsk<string>), q.id)) as T;
    if (!q.choices.some((c) => c.value === value)) throw new GarnetError('invalid_input', `Unknown choice "${value}" for ${q.id}.`);
    return value;
  }
  async multiselect<T extends string>(q: MultiSelectAsk<T>): Promise<T[]> {
    return (await this.ask(initMultiSelect(q as MultiSelectAsk<string>), q.id)) as T[];
  }
  async secret(q: SecretAsk): Promise<string> {
    return (await this.ask(initSecret(q), q.id)) as string;
  }
  /** The summary shown before anything is written. True to save. */
  async review(q: Omit<ReviewAsk, 'lines'> & { body: string }): Promise<boolean> {
    return (await this.ask(initReview({ id: q.id, message: q.message, ...(q.help ? { help: q.help } : {}), lines: stripAnsi(q.body).split('\n').map((l) => l.trimEnd()) }), q.id)) as boolean;
  }
}
