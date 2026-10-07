// Interactive terminal chat: wires keys, the editor, the runtime and the screen.
// Rendering decisions live in render.ts/markdown.ts; this file owns state and I/O.
// Two surfaces: inline (screen.ts: committed rows go to the scrollback) and
// fullscreen (fullscreen.ts: the alternate screen with a status bar and a
// scrollable transcript, laid out by layout.ts and scrolled by viewport.ts).

import type { TaskRecord, TaskStatus, ToolCallBlock, ToolResult } from '../../contracts/index.ts';
import { errorMessage } from '../../contracts/index.ts';
import type { Garnet } from '../../main.ts';
import type { ApprovalDecision, ApprovalRequest } from '../../policy/index.ts';
import type { RuntimeEvent } from '../../runtime/index.ts';
import { executeCommand, prepareTurn, type PendingFile } from './actions.ts';
import type { OnboardFlow } from './flow.ts';
import { complete, matchingCommands, messageText, parseSlash } from './commands.ts';
import { applyKey, emptyEditor, layoutEditor, type EditorState } from './editor.ts';
import type { InputHistory } from './history.ts';
import { KeyParser, type Key } from './keys.ts';
import { MarkdownStream } from './markdown.ts';
import { FULLSCREEN_OFF, FullScreen } from './fullscreen.ts';
import { compose } from './layout.ts';
import {
  approvalChoices, approvalOutcome, approvalRows, assistantRows, banner, footer, fullscreenFooter, hangingRows, MARK, scrollIndicator, sessionTotals,
  SPINNER, statusBar, suggestionRows, taintedRows, toolDoneRows, toolRunningRow, transcriptRows, turnSummary, userBlock, type SessionTotals,
} from './render.ts';
import { Screen, type TerminalOut } from './screen.ts';
import { appended, FOLLOW, following, rewrapped, scrollBy, scrollToTop, trimmed, view, type ScrollState } from './viewport.ts';
import { displayWidth, formatDuration, sanitize, truncate, wrapText } from './text.ts';
import type { Theme } from './theme.ts';

export type TtyInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
export type TtyOutput = TerminalOut & { on?: (event: 'resize', fn: () => void) => unknown; off?: (event: 'resize', fn: () => void) => unknown };

export type InteractiveOptions = {
  garnet: Garnet;
  sessionId: string;
  resumed: boolean;
  stdin: TtyInput;
  stdout: TtyOutput;
  theme: Theme;
  history: InputHistory;
  /** Install process signal handlers (SIGTERM, SIGHUP, SIGCONT) and the exit hook. Off in tests. */
  processHooks?: boolean;
  /** First-run wake-up (see `flow.ts`). */
  onboard?: OnboardFlow;
  /** The fullscreen UI (alternate screen, status bar, scrollable transcript). Absent: the inline UI. */
  fullscreen?: {
    /** Start with mouse reporting on (the wheel scrolls; F2 or Alt+M toggles it). */
    mouse: boolean;
    /** The assistant's name for the status bar. */
    assistantName: string;
  };
};

/** Transcript rows kept for scrolling in fullscreen; older rows are dropped. */
const MAX_ROWS = 20_000;

type Running = {
  controller: AbortController;
  startedAt: number;
  label: string;
  stream: MarkdownStream | null;
  /** True until the current assistant block has committed a row (for the mark). */
  firstRow: boolean;
  tool: { call: ToolCallBlock; startedAt: number } | null;
  /** Source text of the assistant block being streamed (re-rendered after a resize). */
  block: { text: string; done: boolean } | null;
  cancelling: boolean;
  done: Promise<unknown>;
};

const TERMINAL_MODES_ON = '\x1b[?2004h\x1b[>1u'; // bracketed paste; kitty keyboard "disambiguate" (Shift+Enter)
const TERMINAL_MODES_OFF = '\x1b[<u\x1b[?2004l\x1b[?25h';

export class InteractiveChat {
  private readonly o: InteractiveOptions;
  /** The inline surface, or null in fullscreen. */
  private readonly screen: Screen | null;
  /** The fullscreen surface, or null inline. */
  private readonly full: FullScreen | null;
  /** Fullscreen: committed transcript rows at the current width, the scroll position and the last layout. */
  private rows: string[] = [];
  private scroll: ScrollState = FOLLOW;
  private bodyHeight = 10;
  private contentLength = 0;
  private mouse = false;
  /** Fullscreen: rows printed on the normal screen after leaving the alternate screen. */
  private readonly epilogue: string[] = [];
  private terminalRestored = false;
  private readonly parser = new KeyParser();
  private sessionId: string;
  private editor: EditorState;
  private running: Running | null = null;
  private approval: { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null = null;
  private readonly alwaysAllowed = new Set<string>();
  private readonly queue: string[] = [];
  private readonly toolLog: { call: ToolCallBlock; result: ToolResult }[] = [];
  /** Files attached with /attach, sent with the next message. */
  private readonly attachments: PendingFile[] = [];
  private totals: SessionTotals;
  private notice: { text: string; until: number } | null = null;
  private exitArmedUntil = 0;
  private frame = 0;
  private pendingCommit: string[] = [];
  /** Everything committed so far, as width-independent renderers, so a narrower terminal can be redrawn cleanly. */
  private transcript: { render: (width: number) => string[] }[] = [];
  private drawnColumns = 0;
  private resizeTimer: NodeJS.Timeout | null = null;
  private renderTimer: NodeJS.Timeout | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private escapeTimer: NodeJS.Timeout | null = null;
  private finished: ((code: number) => void) | null = null;
  private exiting = false;
  /** Set when the onboarding check gave up on the conversation; the caller then asks the form questions. */
  fallbackReason: string | null = null;
  private readonly cleanups: (() => void)[] = [];

  constructor(options: InteractiveOptions) {
    this.o = options;
    this.full = options.fullscreen ? new FullScreen(options.stdout) : null;
    this.screen = this.full ? null : new Screen(options.stdout);
    this.mouse = options.fullscreen?.mouse ?? false;
    this.sessionId = options.sessionId;
    this.editor = emptyEditor(options.history.entries.length);
    this.totals = sessionTotals(options.garnet.store.events(this.sessionId), options.garnet.pricing);
  }

  private get theme(): Theme {
    return this.o.theme;
  }

  private get columns(): number {
    return (this.full ?? this.screen!).columns;
  }

  /** Usable width: one column short of the terminal so rows never trigger autowrap. */
  private get width(): number {
    return this.columns - 1;
  }

  /** The approver handed to the runtime: asks inline and remembers "always" answers for this chat. */
  readonly approve = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const key = alwaysKey(req);
    // An operation escalated by untrusted content is never covered by an earlier "always".
    if (!req.taint?.length && this.alwaysAllowed.has(key)) {
      this.commit(() => [`    ${this.theme.ok('✓')} ${this.theme.muted(`${req.tool} allowed (always, this chat)`)}`]);
      return Promise.resolve('approved');
    }
    if (this.exiting || !this.running) return Promise.resolve('denied');
    this.finishStream();
    this.scroll = FOLLOW; // the request must be in view
    this.commit((w) => approvalRows(req, this.theme, w));
    return new Promise((resolve) => {
      this.approval = { req, resolve };
      this.o.stdout.write('\x07'); // bell: an approval is waiting
      this.render();
    });
  };

  /** Runs until the owner exits. Resolves with the exit code. */
  run(): Promise<number> {
    const { stdin, stdout, garnet } = this.o;
    const done = new Promise<number>((resolve) => (this.finished = resolve));
    this.enterRawMode();
    const onData = (chunk: Buffer | string) => this.onInput(String(chunk));
    const onEnd = () => void this.exit(0);
    const onResize = () => this.onResize();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdout.on?.('resize', onResize);
    this.cleanups.push(() => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdout.off?.('resize', onResize);
    });
    if (this.o.processHooks) this.installProcessHooks();

    const events = this.o.resumed ? garnet.store.events(this.sessionId) : [];
    const sessionId = this.sessionId;
    this.drawnColumns = this.columns;
    this.commit((w) => [...banner(this.theme, w, garnet.model.id, sessionId, this.o.resumed), ...transcriptRows(events, this.theme, w)]);
    if (this.o.onboard) void this.kick(this.o.onboard);
    return done;
  }

  private enterRawMode(): void {
    const { stdin } = this.o;
    stdin.setRawMode?.(true);
    (stdin as NodeJS.ReadStream).setEncoding?.('utf8');
    stdin.resume();
    this.o.stdout.write(TERMINAL_MODES_ON);
    this.full?.enter(this.mouse);
    this.terminalRestored = false;
  }

  private leaveRawMode(): void {
    this.full?.leave();
    this.o.stdout.write(TERMINAL_MODES_OFF);
    this.o.stdin.setRawMode?.(false);
    this.terminalRestored = true;
  }

  private installProcessHooks(): void {
    // Last resort when the chat cannot clean up: written once, so a second
    // "leave the alternate screen" cannot move the cursor over a crash report.
    const restore = () => {
      if (this.terminalRestored) return;
      this.terminalRestored = true;
      this.o.stdout.write((this.full ? FULLSCREEN_OFF : '') + TERMINAL_MODES_OFF);
      this.o.stdin.setRawMode?.(false);
    };
    const onTerm = () => void this.exit(143);
    const onHup = () => void this.exit(129);
    const onInt = () => void this.exit(130);
    const onCont = () => {
      this.enterRawMode();
      this.screen?.resized();
      this.full?.invalidate();
      this.render();
    };
    process.on('exit', restore);
    // Runs before Node prints an uncaught error, so the report lands on the normal screen with the terminal usable.
    process.on('uncaughtExceptionMonitor', restore);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    process.on('SIGINT', onInt);
    process.on('SIGCONT', onCont);
    this.cleanups.push(() => {
      process.off('exit', restore);
      process.off('uncaughtExceptionMonitor', restore);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      process.off('SIGINT', onInt);
      process.off('SIGCONT', onCont);
    });
  }

  // ── input ────────────────────────────────────────────────────────────

  private onInput(chunk: string): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    this.keys(() => this.parser.feed(chunk));
    if (this.parser.pendingEscape) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        this.keys(() => this.parser.flush());
      }, this.parser.pendingTimeoutMs);
    }
  }

  /** Handles parsed keys. A bug in key handling shows a notice instead of crashing with the terminal in raw mode. */
  private keys(parse: () => Key[]): void {
    try {
      for (const k of parse()) this.onKey(k);
    } catch (e) {
      this.setNotice(this.theme.error(`Input error: ${sanitize(errorMessage(e))}`), 4000);
      this.render();
    }
  }

  /** Handles one key. Public for tests. */
  onKey(k: Key): void {
    if (this.exiting) return;
    if (this.full && this.onViewKey(k)) return this.render();
    if (this.approval) return this.onApprovalKey(k);
    const now = Date.now();
    if (k.ctrl && k.name === 'c') {
      if (this.running) {
        if (this.running.cancelling) return void this.exit(130);
        this.cancel();
      } else if (this.editor.text) {
        this.editor = emptyEditor(this.o.history.entries.length);
      } else if (now < this.exitArmedUntil) {
        return void this.exit(0);
      } else {
        this.exitArmedUntil = now + 2000;
        this.setNotice(this.theme.warn('Press Ctrl+C again to exit'), 2000);
      }
      return this.render();
    }
    if (k.name === 'escape') {
      if (this.running) this.cancel();
      return this.render();
    }
    if (k.ctrl && k.name === 'd' && !this.editor.text) return void this.exit(0);
    if (k.ctrl && k.name === 'l') {
      this.clearScreen();
      return this.render();
    }
    if (k.ctrl && k.name === 'z' && this.o.processHooks && process.platform !== 'win32') return this.suspend();
    if (k.name === 'tab' && !k.shift) {
      const c = complete(this.editor.text, (cmd) => (cmd === 'resume' ? this.o.garnet.store.listSessions(50).map((s) => s.id) : []));
      if (c.text !== this.editor.text) this.editor = { ...this.editor, text: c.text, cursor: c.text.length };
      return this.render();
    }
    const { state, action } = applyKey(this.editor, k, this.o.history.entries);
    this.editor = state;
    if (action === 'submit') {
      const text = state.text;
      if (text.trim()) this.o.history.add(text);
      this.editor = emptyEditor(this.o.history.entries.length);
      if (text.trim()) {
        this.scroll = FOLLOW;
        if (this.running) this.queue.push(text);
        else void this.process(text);
      }
    }
    this.render();
  }

  /** Fullscreen keys that move the view or toggle the mouse. True when handled. */
  private onViewKey(k: Key): boolean {
    const total = this.contentLength;
    const h = this.bodyHeight;
    const by = (delta: number) => (this.scroll = scrollBy(this.scroll, delta, total, h));
    const idle = !this.editor.text && !this.approval;
    if (k.name === 'mouse') return true; // clicks and releases: nothing to do
    if (k.name === 'wheelup' || k.name === 'wheeldown') by(k.name === 'wheelup' ? -3 : 3);
    else if (k.name === 'pageup' || k.name === 'pagedown') by((k.name === 'pageup' ? -1 : 1) * Math.max(1, h - 2));
    else if ((k.name === 'up' || k.name === 'down') && (k.shift || k.ctrl) && !k.meta) by((k.name === 'up' ? -1 : 1) * Math.max(1, Math.floor(h / 2)));
    else if (k.name === 'home' && (k.ctrl || idle)) this.scroll = scrollToTop(this.scroll, total, h);
    else if (k.name === 'end' && (k.ctrl || idle)) this.scroll = FOLLOW;
    else if (k.name === 'escape' && !this.running && !this.approval && !following(this.scroll)) this.scroll = FOLLOW;
    else if (k.name === 'f2' || (k.meta && !k.ctrl && k.name === 'm')) {
      this.mouse = !this.mouse;
      this.full!.setMouse(this.mouse);
      this.setNotice(
        this.mouse
          ? this.theme.muted('Mouse reporting on: the wheel scrolls. Hold Shift (Option in iTerm2) to select text, or press F2.')
          : this.theme.muted('Mouse reporting off: select text as usual. Scroll with PgUp/PgDn; F2 turns the wheel back on.'),
        4000,
      );
    } else return false;
    return true;
  }

  private onApprovalKey(k: Key): void {
    const a = this.approval!;
    const decide = (d: 'once' | 'always' | 'denied') => {
      this.approval = null;
      this.notice = null;
      this.scroll = FOLLOW; // answered: back to the turn it belongs to
      if (d === 'always') this.alwaysAllowed.add(alwaysKey(a.req));
      this.commit((w) => hangingRows('    ', approvalOutcome(d, this.theme).trimStart(), w));
      a.resolve(d === 'denied' ? 'denied' : 'approved');
    };
    const ch = k.name === 'text' ? (k.text ?? '').toLowerCase() : '';
    if (ch === 'y') decide('once');
    else if (ch === 'a' && !a.req.taint?.length) decide('always');
    else if (ch === 'n' || k.name === 'escape') decide('denied');
    else if (k.ctrl && k.name === 'c') {
      decide('denied');
      this.cancel();
    } else {
      this.setNotice(this.theme.warn('Press y, a or n'), 3000);
    }
    this.render();
  }

  private suspend(): void {
    this.screen?.release();
    this.leaveRawMode();
    // Stop the whole process group, as the terminal does for Ctrl+Z in cooked
    // mode, so a parent such as `npm run` stops too and the shell takes over.
    // SIGCONT (installed with the process hooks) restores raw mode and redraws.
    process.kill(0, 'SIGTSTP');
  }

  // ── turns ────────────────────────────────────────────────────────────

  private async process(raw: string): Promise<void> {
    const slash = parseSlash(raw);
    if (slash) {
      await this.command(slash);
    } else {
      const text = messageText(raw).trim();
      if (text) {
        const status = await this.turn(text);
        if (status && (await this.checkOnboarding(status))) return;
      }
    }
    const next = this.queue.shift();
    if (next !== undefined && !this.exiting) return this.process(next);
    this.render();
  }

  private busy(label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    let settle!: () => void;
    const running: Running = {
      controller, startedAt: Date.now(), label, stream: null, firstRow: true, tool: null, block: null, cancelling: false,
      done: new Promise<void>((r) => (settle = r)),
    };
    this.running = running;
    this.spinnerTimer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 100);
    this.render();
    return work(controller.signal)
      .catch((e: unknown) => this.commit((w) => ['', ...hangingRows(`  ${this.theme.error('✗ error')} `, sanitize(errorMessage(e)), w)]))
      .finally(() => {
        if (this.spinnerTimer) clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
        this.running = null;
        settle();
      });
  }

  /** The wake-up chat opens with a message from the CLI, so the agent speaks first. */
  private async kick(flow: OnboardFlow): Promise<void> {
    const status = await this.turn(flow.kickoff, false);
    if (status && (await this.checkOnboarding(status))) return;
    // An answer typed while the agent was still greeting waits in the queue; send it like process() does.
    const next = this.queue.shift();
    if (next !== undefined && !this.exiting) return this.process(next);
    this.render();
  }

  /** True when the chat was ended in favour of the form. */
  private async checkOnboarding(status: TaskStatus): Promise<boolean> {
    const flow = this.o.onboard;
    if (!flow || this.exiting) return false;
    const v = flow.check(status);
    if (v.next === 'continue') {
      const note = v.note;
      if (note) this.commit((w) => ['', ...hangingRows(`  ${this.theme.ok('✓')} `, sanitize(note), w)]);
      return false;
    }
    this.fallbackReason = v.reason;
    const stopping = (w: number) => ['', ...hangingRows(`  ${this.theme.warn('!')} `, `Setup chat is stopping because ${sanitize(v.reason)}. A short form comes next; your replies stay in this session.`, w)];
    this.commit(stopping);
    // The alternate screen goes away on exit: say it again where the form will be asked.
    if (this.full) this.epilogue.push(...stopping(this.width));
    await this.exit(0);
    return true;
  }

  private async turn(text: string, echo = true): Promise<TaskStatus | null> {
    const files = this.attachments.splice(0);
    const names = files.map((f) => f.name).join(', ');
    if (echo) this.commit((w) => [...userBlock(text, this.theme, w), ...(files.length ? wrapText(this.theme.muted(`  + ${sanitize(names)}`), w) : [])]);
    let status = null as TaskStatus | null;
    await this.busy(files.length ? 'reading files' : 'thinking', async (signal) => {
      const started = Date.now();
      const prepared = await prepareTurn(this.o.garnet, this.sessionId, text, files, signal);
      if ('reply' in prepared) {
        this.commit((w) => ['', ...wrapText(`  ${sanitize(prepared.reply)}`, w), '']);
        status = 'completed';
        return;
      }
      const task: TaskRecord = await this.o.garnet.agent.run(this.sessionId, prepared.turn, { signal, onEvent: (e) => this.onEvent(e), source: 'cli' });
      this.finishStream();
      this.refreshTotals();
      const elapsed = Date.now() - started;
      this.commit((w) => turnSummary(task, elapsed, this.theme, w, this.o.garnet.pricing));
      status = task.status;
    });
    // A turn that threw (busy reports the error on screen) counts as failed for the onboarding check.
    return status ?? (this.o.onboard ? 'failed' : null);
  }

  private onEvent(e: RuntimeEvent): void {
    const r = this.running;
    if (!r) return;
    if (e.type === 'text') {
      if (!r.stream || !r.block) {
        r.stream = new MarkdownStream({ width: this.width - 2, theme: this.theme });
        r.firstRow = true;
        const block = (r.block = { text: '', done: false });
        this.record((w) => {
          const s = new MarkdownStream({ width: w - 2, theme: this.theme });
          const rows = s.push(block.text);
          if (block.done) rows.push(...s.finish());
          return rows.length ? ['', ...assistantRows(rows, this.theme, true)] : [];
        });
      }
      r.label = 'writing';
      r.block.text += e.text;
      this.commitAssistant(r.stream.push(e.text), false);
      this.scheduleRender();
    } else if (e.type === 'tool_start') {
      this.finishStream();
      r.tool = { call: e.call, startedAt: Date.now() };
      this.render();
    } else if (e.type === 'tool_end') {
      r.tool = null;
      r.label = 'thinking';
      this.toolLog.push({ call: e.call, result: e.result });
      if (this.toolLog.length > 50) this.toolLog.shift();
      const { call, result } = e;
      this.commit((w) => toolDoneRows(call, result, this.theme, w));
    } else if (e.type === 'retry') {
      this.finishStream();
      r.label = 'retrying';
      this.commit([this.theme.warn(`  ↻ retrying in ${formatDuration(e.delayMs)} (attempt ${e.attempt}): ${sanitize(e.message)}`)]);
    } else if (e.type === 'tainted') {
      this.finishStream();
      const first = this.totals.untrusted.length === 0;
      this.totals = { ...this.totals, untrusted: [...e.sources] };
      this.commit((w) => taintedRows(e.source, first, this.theme, w));
    } else if (e.type === 'compacting') {
      r.label = 'compacting older turns';
      this.commit([this.theme.muted('  ⋯ compacting older turns to free context')]);
    }
  }

  private commitAssistant(rows: string[], render = true): void {
    const r = this.running;
    if (!r || !rows.length) return;
    const lead = r.firstRow ? [''] : [];
    this.pendingCommit.push(...lead, ...assistantRows(rows, this.theme, r.firstRow));
    r.firstRow = false;
    if (render) this.render();
  }

  private finishStream(): void {
    const r = this.running;
    if (!r?.stream) return;
    const rows = r.stream.finish();
    r.stream = null;
    if (r.block) r.block.done = true;
    r.block = null;
    this.commitAssistant(rows);
  }

  private cancel(): void {
    const r = this.running;
    if (!r || r.cancelling) return;
    r.cancelling = true;
    r.label = 'interrupting';
    r.controller.abort();
    this.queue.length = 0; // an interrupt also drops type-ahead
    this.setNotice(this.theme.warn('Interrupting… press Ctrl+C again to quit'), 3000);
  }

  private refreshTotals(): void {
    this.totals = sessionTotals(this.o.garnet.store.events(this.sessionId), this.o.garnet.pricing);
  }

  // ── commands ─────────────────────────────────────────────────────────

  private async command(parsed: NonNullable<ReturnType<typeof parseSlash>>): Promise<void> {
    const run = async (signal?: AbortSignal) => {
      const result = await executeCommand(parsed, {
        garnet: this.o.garnet,
        sessionId: this.sessionId,
        theme: this.theme,
        width: this.width,
        toolLog: this.toolLog,
        attachments: this.attachments,
        ...(this.full ? { fullscreen: true } : {}),
        ...(this.o.onboard ? { onboarding: true } : {}),
        switchTo: (id) => this.switchTo(id),
        ...(signal ? { signal } : {}),
      });
      if (result.effect === 'exit') return void this.exit(0);
      if (result.effect === 'clear') this.clearScreen();
      this.refreshTotals();
      // Re-rendered at the new width if the terminal narrows; rows that still overflow are wrapped.
      const render = (w: number) => result.rows(w).flatMap((r) => (displayWidth(r) > w ? wrapText(r, w) : [r]));
      if (render(this.width).length) this.commit(render);
      else this.render();
    };
    if ('command' in parsed && parsed.command.name === 'compact') return this.busy('compacting', run);
    return run();
  }

  private switchTo(id: string): void {
    this.sessionId = id;
    this.alwaysAllowed.clear();
    this.refreshTotals();
  }

  // ── output ───────────────────────────────────────────────────────────

  /**
   * Prints rows permanently above the live region. A function is re-run at the
   * new width when the terminal narrows; fixed rows are re-wrapped instead.
   */
  private commit(rows: string[] | ((width: number) => string[])): void {
    const render = typeof rows === 'function' ? rows : (w: number) => rows.flatMap((r) => (displayWidth(r) > w ? wrapText(r, w) : [r]));
    this.record(render);
    this.pendingCommit.push(...render(this.width));
    this.render();
  }

  private record(render: (width: number) => string[]): void {
    this.transcript.push({ render });
    if (this.transcript.length > 2000) this.transcript.splice(0, this.transcript.length - 2000);
  }

  private clearScreen(): void {
    this.transcript = [];
    this.pendingCommit = [];
    this.rows = [];
    this.scroll = FOLLOW;
    this.screen?.clearScreen();
    this.full?.invalidate();
  }

  /**
   * Wider: future rows use the new width. Narrower: reflowing terminals push
   * the old live rows into the scrollback where they cannot be erased, so the
   * screen is cleared and the whole transcript re-rendered at the new width.
   */
  private onResize(): void {
    const cols = this.columns;
    if (this.full) {
      // The alternate screen is redrawn whole: any new width re-wraps the transcript from its blocks.
      const changed = cols !== this.drawnColumns;
      this.drawnColumns = cols;
      this.full.invalidate();
      if (changed) return this.redrawAll();
      return this.render();
    }
    const narrower = cols < this.drawnColumns;
    this.drawnColumns = cols;
    if (!narrower && !this.resizeTimer) {
      this.running?.stream?.setWidth(this.width - 2);
      this.screen!.resized();
      return this.render();
    }
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.redrawAll();
    }, 60);
  }

  private redrawAll(): void {
    const w = this.width;
    const r = this.running;
    if (r?.stream && r.block) {
      r.stream = new MarkdownStream({ width: w - 2, theme: this.theme });
      r.stream.push(r.block.text);
    }
    const rows = this.transcript.flatMap((b) => b.render(w));
    if (this.full) {
      this.scroll = rewrapped(this.scroll, this.rows.length, rows.length);
      this.rows = rows;
      this.pendingCommit = [];
    } else {
      this.screen!.clearScreen();
      this.pendingCommit = rows;
    }
    this.render();
  }

  private setNotice(text: string, ms: number): void {
    this.notice = { text, until: Date.now() + ms };
    setTimeout(() => this.render(), ms + 10).unref();
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 16);
  }

  /** Builds the live region from state and draws it with any pending committed rows. */
  render(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if ((this.exiting && !this.pendingCommit.length) || this.resizeTimer) return;
    if (this.full) return this.renderFull();
    const t = this.theme;
    const w = this.width;
    const rows: string[] = [];
    const r = this.running;
    if (r) {
      const pending = r.stream?.pending() ?? [];
      if (pending.length) rows.push(...(r.firstRow ? [''] : []), ...assistantRows(pending, t, r.firstRow));
      const frame = SPINNER[this.frame]!;
      if (this.approval) {
        rows.push('', ...approvalChoices(this.approval.req, t, w));
      } else if (r.tool) {
        rows.push(toolRunningRow(r.tool.call, frame, Date.now() - r.tool.startedAt, t, w));
      } else {
        const elapsed = formatDuration(Date.now() - r.startedAt);
        rows.push('', truncate(`  ${t.accent(frame)} ${t.muted(`${r.label}… ${elapsed}`)}${t.muted(r.cancelling ? '' : ' · esc to interrupt')}`, w));
      }
      for (const q of this.queue) rows.push(truncate(t.muted(`  ↳ queued: ${sanitize(q.replace(/\s+/g, ' '))}`), w));
    }
    let cursor: { row: number; col: number } | null = null;
    if (!this.approval) {
      rows.push(t.rule('─'.repeat(w)));
      const layout = layoutEditor(this.editor, w, `${r ? t.muted('›') : t.accent('›')} `, '  ', 2);
      cursor = { row: rows.length + layout.cursorRow, col: layout.cursorCol };
      rows.push(...layout.rows);
      const matches = matchingCommands(this.editor.text);
      if (matches.length) rows.push(...suggestionRows(matches.slice(0, 10), t, w));
    }
    const notice = this.notice && this.notice.until > Date.now() ? this.notice.text : undefined;
    rows.push(footer({ model: this.o.garnet.model.id, sessionId: this.sessionId, totals: this.totals, contextWindow: this.o.garnet.model.capabilities.contextWindow, notice }, t, w));
    const committed = this.pendingCommit;
    this.pendingCommit = [];
    this.screen!.setLive(rows, cursor, committed);
  }

  /** What a turn is doing, in words, for the status bar. */
  private stateWords(): string {
    if (this.approval) return 'waiting for your approval';
    const r = this.running;
    if (!r) return 'ready';
    const elapsed = formatDuration(Date.now() - r.startedAt);
    if (r.cancelling) return `interrupting ${elapsed}`;
    if (r.tool) return `running ${sanitize(r.tool.call.name)} ${elapsed}`;
    return `${r.label} ${elapsed}`;
  }

  /**
   * Fullscreen frame: the status bar, the transcript (committed rows, then the
   * live tail: streaming text, spinner, queued messages) through the viewport,
   * and the dock (input or approval choices, footer).
   */
  private renderFull(): void {
    if (this.exiting) return;
    const t = this.theme;
    const w = this.width;
    if (this.pendingCommit.length) {
      this.rows.push(...this.pendingCommit);
      this.scroll = appended(this.scroll, this.pendingCommit.length);
      this.pendingCommit = [];
      if (this.rows.length > MAX_ROWS) {
        const removed = this.rows.length - MAX_ROWS;
        this.rows.splice(0, removed);
        this.scroll = trimmed(this.scroll, removed);
      }
    }
    const tail: string[] = [];
    const r = this.running;
    if (r) {
      const pending = r.stream?.pending() ?? [];
      if (pending.length) tail.push(...(r.firstRow ? [''] : []), ...assistantRows(pending, t, r.firstRow));
      const spin = SPINNER[this.frame]!;
      if (r.tool) {
        tail.push(toolRunningRow(r.tool.call, spin, Date.now() - r.tool.startedAt, t, w));
      } else if (!this.approval) {
        const elapsed = formatDuration(Date.now() - r.startedAt);
        tail.push('', truncate(`  ${t.accent(spin)} ${t.muted(`${r.label}… ${elapsed}`)}${t.muted(r.cancelling ? '' : ' · esc to interrupt')}`, w));
      }
      for (const q of this.queue) tail.push(truncate(t.muted(`  ↳ queued: ${sanitize(q.replace(/\s+/g, ' '))}`), w));
    }
    const content = tail.length ? [...this.rows, ...tail] : this.rows;
    this.contentLength = content.length;

    const dock: string[] = [t.rule('─'.repeat(w))];
    let cursor: { row: number; col: number } | null = null;
    if (this.approval) {
      dock.push(...approvalChoices(this.approval.req, t, w));
    } else {
      const layout = layoutEditor(this.editor, w, `${r ? t.muted('›') : t.accent('›')} `, '  ', 2);
      cursor = { row: dock.length + layout.cursorRow, col: layout.cursorCol };
      dock.push(...layout.rows);
      const matches = matchingCommands(this.editor.text);
      if (matches.length) dock.push(...suggestionRows(matches.slice(0, 10), t, w));
    }
    const notice = this.notice && this.notice.until > Date.now() ? this.notice.text : undefined;
    dock.push(fullscreenFooter({ notice, mouse: this.mouse }, t, w));

    const header = statusBar({
      name: this.o.fullscreen!.assistantName,
      model: this.o.garnet.model.id,
      sessionId: this.sessionId,
      totals: this.totals,
      contextWindow: this.o.garnet.model.capabilities.contextWindow,
      state: this.stateWords(),
      busy: Boolean(r),
      approval: Boolean(this.approval),
    }, t, w);
    const frame = compose({
      height: this.full!.rows,
      header,
      dock,
      cursor,
      body: (h) => {
        this.bodyHeight = h;
        const v = view(content, this.scroll, h);
        return v.indicator ? [...v.rows, scrollIndicator(v.below, this.scroll.unseen, t, w)] : v.rows;
      },
    });
    this.full!.draw(frame.rows, frame.cursor);
  }

  // ── exit ─────────────────────────────────────────────────────────────

  private async exit(code: number): Promise<void> {
    if (this.exiting) return;
    // Flush what is already on screen before tearing down.
    this.render();
    this.exiting = true;
    if (this.approval) {
      this.approval.resolve('denied');
      this.approval = null;
    }
    const r = this.running;
    if (r) {
      r.controller.abort();
      await Promise.race([r.done, new Promise((res) => setTimeout(res, 3000).unref())]);
    }
    for (const timer of [this.renderTimer, this.spinnerTimer, this.escapeTimer, this.resizeTimer]) if (timer) clearTimeout(timer);
    if (this.screen) {
      if (this.pendingCommit.length) this.screen.setLive([], null, this.pendingCommit);
      this.screen.release();
    }
    this.leaveRawMode();
    if (this.full) {
      // The transcript went with the alternate screen: leave a pointer back to it on the normal screen.
      if (!this.o.onboard) {
        this.epilogue.push(`  ${this.theme.accent(MARK)} ${this.theme.muted(`Continue this chat: garnet chat --session ${this.sessionId}`)}`);
      }
      if (this.epilogue.length) this.o.stdout.write(`${this.epilogue.map((row) => `${row}\x1b[0m`).join('\n')}\n`);
    }
    for (const c of this.cleanups) c();
    this.o.stdin.pause();
    this.finished?.(code);
  }
}

/** "Always" covers a tool for the rest of the chat, except commands, which must match exactly. */
function alwaysKey(req: ApprovalRequest): string {
  return req.capability === 'exec'
    ? `${req.sessionId}|${req.tool}|${JSON.stringify(req.input)}`
    : `${req.sessionId}|${req.tool}|${req.capability}`;
}
