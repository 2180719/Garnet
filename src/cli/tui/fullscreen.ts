// Fullscreen terminal sessions for `garnet setup` and `garnet config`: the
// alternate screen, raw keys, resize and a guaranteed restore. The screens
// themselves are pure (state in, rows out); this file only moves bytes.
import { GarnetError } from '../../contracts/index.ts';
import { KeyParser, type Key } from '../chat/keys.ts';

// Alternate screen, bracketed paste, alternate-scroll (the wheel sends arrow keys, no mouse reporting needed), hidden cursor.
export const FULLSCREEN_ON = '\x1b[?1049h\x1b[?2004h\x1b[?1007h\x1b[?25l\x1b[2J\x1b[H';
// Everything undone, in reverse; safe to write twice. Also the last resort on process exit.
export const FULLSCREEN_OFF = '\x1b[?25h\x1b[?1007l\x1b[?2004l\x1b[?1049l';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export type FsInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
export type FsOutput = {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
  on?: (event: 'resize', fn: () => void) => unknown;
  off?: (event: 'resize', fn: () => void) => unknown;
};

/** What a screen's key handler returns: the next state, and optionally an end. */
export type Step<S, R> = { state: S; done?: { value: R } | { cancel: true } };

export type Frame = { rows: string[]; cursor?: { row: number; col: number } };

export type Screen<S, R> = {
  state: S;
  update(state: S, key: Key): Step<S, R>;
  /** Exactly `height` rows of at most `width` columns, plus where to put the cursor (optional). */
  view(state: S, width: number, height: number): Frame;
};

export const cancelledError = (what: string) => new GarnetError('cancelled', `${what} cancelled.`);

/** True when a fullscreen UI is appropriate: both streams are terminals, TERM is usable. */
export function wantsFullscreen(streams: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } }, env: NodeJS.ProcessEnv, plain = false): boolean {
  return !plain && Boolean(streams.stdin.isTTY && streams.stdout.isTTY) && Boolean(env.TERM) && env.TERM !== 'dumb';
}

export class FullscreenSession {
  private readonly input: FsInput;
  private readonly output: FsOutput;
  private readonly hooks: boolean;
  private opened = false;
  private parser = new KeyParser();
  private escapeTimer: NodeJS.Timeout | null = null;
  private redraw: (() => void) | null = null;
  private onKeys: ((keys: Key[]) => void) | null = null;
  private readonly onData = (chunk: string | Buffer) => {
    const keys = this.parser.feed(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    if (this.parser.pendingEscape) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        this.onKeys?.(this.parser.flush());
      }, 30);
    }
    if (keys.length) this.onKeys?.(keys);
  };
  private readonly onResize = () => this.redraw?.();
  private readonly onExit = () => {
    this.output.write(FULLSCREEN_OFF);
  };
  private readonly onSignal = (sig: NodeJS.Signals) => {
    this.close();
    process.exit(sig === 'SIGHUP' ? 129 : 143);
  };

  constructor(opts: { input: FsInput; output: FsOutput; processHooks?: boolean }) {
    this.input = opts.input;
    this.output = opts.output;
    this.hooks = opts.processHooks ?? true;
  }

  get isOpen(): boolean {
    return this.opened;
  }
  get width(): number {
    return Math.max(20, this.output.columns ?? 80);
  }
  get height(): number {
    return Math.max(3, this.output.rows ?? 24);
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.input.setRawMode?.(true);
    this.input.resume();
    (this.input as NodeJS.ReadStream).setEncoding?.('utf8');
    this.input.on('data', this.onData);
    this.output.on?.('resize', this.onResize);
    if (this.hooks) {
      process.once('exit', this.onExit);
      process.once('SIGTERM', this.onSignal);
      process.once('SIGHUP', this.onSignal);
    }
    this.output.write(FULLSCREEN_ON);
  }

  /** Restores the terminal. Idempotent; never throws. */
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    try {
      if (this.escapeTimer) clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
      this.input.off('data', this.onData);
      this.output.off?.('resize', this.onResize);
      this.input.setRawMode?.(false);
      this.input.pause();
    } catch {
      /* the terminal reset below still runs */
    }
    this.output.write(FULLSCREEN_OFF);
    if (this.hooks) {
      process.off('exit', this.onExit);
      process.off('SIGTERM', this.onSignal);
      process.off('SIGHUP', this.onSignal);
    }
  }

  /** Draws rows (already sized to the screen) in place, without flicker where supported. */
  private paint(frame: Frame): void {
    let out = SYNC_START + '\x1b[H';
    out += frame.rows.map((r) => `${r}\x1b[0m\x1b[K`).join('\r\n');
    out += '\x1b[J';
    out += frame.cursor ? `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\x1b[?25h` : '\x1b[?25l';
    this.output.write(out + SYNC_END);
  }

  /** Runs one screen until it finishes; resolves its value or rejects when cancelled. */
  run<S, R>(screen: Screen<S, R>, what = 'Cancelled'): Promise<R> {
    this.open();
    return new Promise<R>((resolve, reject) => {
      let state = screen.state;
      let finished = false;
      const draw = () => {
        if (!finished) this.paint(screen.view(state, this.width, this.height));
      };
      this.redraw = draw;
      const end = () => {
        finished = true;
        this.onKeys = null;
        this.redraw = null;
      };
      this.onKeys = (keys) => {
        for (const key of keys) {
          if (finished) return;
          if (key.name === 'unknown') continue;
          let step: Step<S, R>;
          try {
            step = screen.update(state, key);
          } catch (e) {
            end();
            reject(e);
            return;
          }
          state = step.state;
          if (step.done) {
            end();
            if ('cancel' in step.done) reject(cancelledError(what));
            else resolve(step.done.value);
            return;
          }
        }
        draw();
      };
      draw();
    });
  }
}
