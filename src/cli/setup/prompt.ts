// Prompts for `ruby setup`, behind one interface so the wizard runs the same
// way on a terminal, from command-line flags (non-interactive) and in tests.
import { createInterface } from 'node:readline';
import { RubyError } from '../../contracts/index.ts';

export type Choice<T extends string> = { value: T; label: string; hint?: string };

/**
 * Every prompt has a stable `id`. Answers are looked up by id in scripted and
 * non-interactive mode, where it doubles as the command-line flag name.
 */
export type Ask = {
  id: string;
  message: string;
  /** One extra line shown under the question on a terminal. */
  help?: string;
};

export type TextAsk = Ask & {
  default?: string;
  /** Used in non-interactive mode when no answer was given (falls back to `default`). */
  auto?: string;
  /** Returns an error message, or null when the answer is acceptable. */
  validate?: (value: string) => string | null;
};
export type ConfirmAsk = Ask & { default: boolean; auto?: boolean };
export type SelectAsk<T extends string> = Ask & { choices: Choice<T>[]; default?: T; auto?: T };
export type SecretAsk = Ask;

export interface Prompter {
  /** True when a person is answering (pairing checks and retries only make sense then). */
  readonly interactive: boolean;
  text(q: TextAsk): Promise<string>;
  confirm(q: ConfirmAsk): Promise<boolean>;
  select<T extends string>(q: SelectAsk<T>): Promise<T>;
  /** A hidden value (API keys, tokens). Returns '' when none was given. Never echoed. */
  secret(q: SecretAsk): Promise<string>;
}

export type Answer = string | boolean;

/**
 * Answers from a map keyed by prompt id: command-line flags in
 * non-interactive mode, a script in tests. An array answers the same id
 * several times, in order. Unanswered prompts take `auto`, then `default`;
 * a prompt with neither is an error naming the flag to pass.
 */
export class AnswerPrompter implements Prompter {
  readonly interactive: boolean;
  /** Every prompt id asked, in order (tests). */
  readonly asked: string[] = [];
  /** The question text of every prompt, in order (tests). */
  readonly messages: string[] = [];
  private answers: Map<string, Answer[]>;
  private secrets: Map<string, string>;

  constructor(answers: Record<string, Answer | Answer[]> = {}, opts: { interactive?: boolean; secrets?: Record<string, string> } = {}) {
    this.interactive = opts.interactive ?? false;
    this.answers = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
    this.secrets = new Map(Object.entries(opts.secrets ?? {}));
  }

  private take(id: string, message: string): Answer | undefined {
    this.asked.push(id);
    this.messages.push(message);
    const queue = this.answers.get(id);
    if (!queue || queue.length === 0) return undefined;
    // The last answer repeats, so a single flag answers a prompt asked in a loop.
    return queue.length === 1 ? queue[0] : queue.shift();
  }

  private missing(q: Ask): never {
    throw new RubyError('invalid_input', `Missing an answer for "${q.message.replace(/[?:]\s*$/, '')}": pass --${q.id} <value>.`);
  }

  async text(q: TextAsk): Promise<string> {
    const given = this.take(q.id, q.message);
    const value = given !== undefined ? String(given) : (q.auto ?? q.default);
    if (value === undefined) this.missing(q);
    const problem = q.validate?.(value);
    if (problem) throw new RubyError('invalid_input', `--${q.id}: ${problem}`);
    return value;
  }

  async confirm(q: ConfirmAsk): Promise<boolean> {
    const given = this.take(q.id, q.message);
    if (given === undefined) return q.auto ?? q.default;
    if (typeof given === 'boolean') return given;
    return /^(y|yes|true|1|on)$/i.test(given);
  }

  async select<T extends string>(q: SelectAsk<T>): Promise<T> {
    const given = this.take(q.id, q.message);
    const value = given !== undefined ? String(given) : (q.auto ?? q.default);
    if (value === undefined) this.missing(q);
    const choice = q.choices.find((c) => c.value === value);
    if (!choice) throw new RubyError('invalid_input', `--${q.id} must be one of ${q.choices.map((c) => c.value).join(', ')} (got "${value}").`);
    return choice.value;
  }

  async secret(q: SecretAsk): Promise<string> {
    this.asked.push(q.id);
    this.messages.push(q.message);
    return this.secrets.get(q.id) ?? '';
  }
}

export type Style = {
  accent: (s: string) => string;
  muted: (s: string) => string;
  bold: (s: string) => string;
  ok: (s: string) => string;
  warn: (s: string) => string;
  bad: (s: string) => string;
};

const paint = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const plain = (s: string) => s;

/** Ruby's terminal palette (docs/DESIGN.md), or no styling when color is off. */
export function makeStyle(color: boolean): Style {
  if (!color) return { accent: plain, muted: plain, bold: plain, ok: plain, warn: plain, bad: plain };
  return {
    accent: paint('1;38;2;255;102;128'),
    muted: paint('38;2;163;166;173'),
    bold: paint('1'),
    ok: paint('32'),
    warn: paint('33'),
    bad: paint('31'),
  };
}

/** Whether to color output on this stream: a TTY, and neither NO_COLOR nor TERM=dumb. */
export function wantsColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

const cancelled = () => new RubyError('cancelled', 'Setup cancelled.');

/**
 * Removes terminal key sequences (arrows, Home, F-keys, bracketed-paste
 * markers) from raw hidden input, so pressing an arrow key while typing a
 * secret does not add "[D" to it.
 */
export function stripKeySequences(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;:?<>=]*[ -/]*[@-~]|\x1bO.|\x1b./gs, '');
}

/**
 * Prompts on a terminal. Plain line input for text, numbered menus for
 * choices (type the number or the name), and hidden input for secrets that
 * shows one dot per character so pasting is visible but never the value.
 */
export class TerminalPrompter implements Prompter {
  readonly interactive = true;
  private input: NodeJS.ReadStream;
  private output: NodeJS.WriteStream;
  private s: Style;

  constructor(opts: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream; style: Style }) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.s = opts.style;
  }

  private line(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY) });
      let answered = false;
      rl.on('SIGINT', () => {
        rl.close();
        this.output.write('\n');
        reject(cancelled());
      });
      rl.on('close', () => {
        if (!answered) reject(cancelled());
      });
      rl.question(prompt, (answer) => {
        answered = true;
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  private head(q: Ask, suffix: string): string {
    if (q.help) this.output.write(`  ${this.s.muted(q.help)}\n`);
    return `${this.s.accent('?')} ${this.s.bold(q.message)}${suffix} `;
  }

  async text(q: TextAsk): Promise<string> {
    for (;;) {
      const def = q.default ? this.s.muted(` (${q.default})`) : '';
      const answer = (await this.line(this.head(q, def))) || q.default || '';
      const problem = q.validate?.(answer);
      if (!problem) return answer;
      this.output.write(`  ${this.s.bad('✗')} ${problem}\n`);
    }
  }

  async confirm(q: ConfirmAsk): Promise<boolean> {
    for (;;) {
      const answer = (await this.line(this.head(q, this.s.muted(q.default ? ' [Y/n]' : ' [y/N]')))).toLowerCase();
      if (!answer) return q.default;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      this.output.write(`  ${this.s.warn('!')} Answer y or n.\n`);
    }
  }

  async select<T extends string>(q: SelectAsk<T>): Promise<T> {
    if (q.help) this.output.write(`  ${this.s.muted(q.help)}\n`);
    this.output.write(`${this.s.accent('?')} ${this.s.bold(q.message)}\n`);
    q.choices.forEach((c, i) => {
      const mark = c.value === q.default ? this.s.accent('›') : ' ';
      this.output.write(`  ${mark} ${i + 1}) ${c.label}${c.hint ? `  ${this.s.muted(c.hint)}` : ''}\n`);
    });
    const defIndex = q.choices.findIndex((c) => c.value === q.default);
    for (;;) {
      const answer = await this.line(`  ${this.s.muted(`Choose 1-${q.choices.length}${defIndex >= 0 ? ` (${defIndex + 1})` : ''}:`)} `);
      if (!answer && defIndex >= 0) return q.choices[defIndex]!.value;
      const byNumber = /^\d+$/.test(answer) ? q.choices[Number(answer) - 1] : undefined;
      const choice = byNumber ?? q.choices.find((c) => c.value === answer.toLowerCase());
      if (choice) return choice.value;
      this.output.write(`  ${this.s.warn('!')} Type a number from 1 to ${q.choices.length}.\n`);
    }
  }

  async secret(q: SecretAsk): Promise<string> {
    const input = this.input;
    if (q.help) this.output.write(`  ${this.s.muted(q.help)}\n`);
    this.output.write(`${this.s.accent('?')} ${this.s.bold(q.message)} ${this.s.muted('(hidden; Enter to skip)')} `);
    if (!input.isTTY) return this.line('');
    return new Promise((resolve, reject) => {
      let value = '';
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      const finish = (err?: Error) => {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        this.output.write('\n');
        if (err) reject(err);
        else resolve(value.trim());
      };
      const onData = (text: string) => {
        // Key sequences and bracketed-paste markers are not part of the value.
        for (const ch of stripKeySequences(text)) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
          if (ch === '\u0003') return finish(cancelled());
          if (ch === '\u007f' || ch === '\b') {
            if (value.length) {
              value = value.slice(0, -1);
              this.output.write('\b \b');
            }
          } else if (ch >= ' ') {
            value += ch;
            this.output.write('•');
          }
        }
      };
      input.on('data', onData);
    });
  }
}
