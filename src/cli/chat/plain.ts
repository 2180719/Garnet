// Line-based chat for pipes, TERM=dumb and --plain. No cursor movement or
// styling. The assistant's replies go to stdout; everything else (prompts,
// tool calls, status) goes to stderr, so stdout stays clean for scripts.

import { createInterface } from 'node:readline';
import { errorMessage, type ToolCallBlock, type ToolResult } from '../../contracts/index.ts';
import type { Garnet } from '../../main.ts';
import type { ApprovalDecision, ApprovalRequest } from '../../policy/index.ts';
import type { RuntimeEvent } from '../../runtime/index.ts';
import { executeCommand, prepareTurn, type PendingFile } from './actions.ts';
import { messageText, parseSlash } from './commands.ts';
import { describeCall } from './render.ts';
import { formatTokens, sanitize, truncate } from './text.ts';
import { makeTheme } from './theme.ts';

export type PlainOptions = {
  garnet: Garnet;
  sessionId: string;
  input: NodeJS.ReadableStream;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Show the `you ›` prompt (only useful when a person is typing). */
  prompt: boolean;
};

const plainTheme = makeTheme({ styled: false, color: false, truecolor: false });

export class PlainChat {
  private readonly o: PlainOptions;
  private readonly lines: AsyncIterator<string>;
  private readonly close: () => void;
  private current: AbortController | null = null;
  private sessionId: string;
  private readonly always = new Set<string>();
  private readonly toolLog: { call: ToolCallBlock; result: ToolResult }[] = [];
  private readonly attachments: PendingFile[] = [];

  constructor(options: PlainOptions) {
    this.o = options;
    this.sessionId = options.sessionId;
    const rl = createInterface({ input: options.input, terminal: false });
    // One line iterator shared by the prompt and approvals, so input typed or
    // piped while a task runs is buffered instead of lost.
    this.lines = rl[Symbol.asyncIterator]();
    this.close = () => rl.close();
  }

  private async ask(prompt: string): Promise<string | null> {
    if (prompt) this.o.err(prompt);
    const next = await this.lines.next();
    return next.done ? null : String(next.value);
  }

  readonly approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const key = req.capability === 'exec' ? `${req.tool}|${JSON.stringify(req.input)}` : `${req.tool}|${req.capability}`;
    const tainted = Boolean(req.taint?.length);
    // An operation escalated by untrusted content is never covered by an earlier "always".
    if (!tainted && this.always.has(`${this.sessionId}|${key}`)) return 'approved';
    // stderr is usually the owner's terminal: show control characters instead of sending them.
    this.o.err(`\n  ? ${sanitize(req.tool)} wants ${req.capability}${req.targets.length ? ` on ${sanitize(req.targets.join(', '))}` : ''}\n`);
    for (const line of sanitize(req.summary).split('\n')) this.o.err(`    | ${line}\n`);
    const answer = ((await this.ask(tainted ? '  allow? [y]es once, [N]o: ' : '  allow? [y]es once, [a]lways in this chat, [N]o: ')) ?? '').trim().toLowerCase();
    if (!tainted && (answer === 'a' || answer === 'always')) {
      this.always.add(`${this.sessionId}|${key}`);
      return 'approved';
    }
    return answer === 'y' || answer === 'yes' ? 'approved' : 'denied';
  };

  async run(): Promise<number> {
    const { garnet } = this.o;
    const onSigint = () => {
      if (this.current) {
        this.current.abort();
        this.o.err('\n[interrupting…]\n');
      } else {
        this.close();
      }
    };
    process.on('SIGINT', onSigint);
    try {
      this.o.err(`Garnet (${garnet.model.id}) · session ${this.sessionId}\nType a message. /help for commands, /exit to quit, Ctrl+C to interrupt.\n\n`);
      for (;;) {
        const raw = await this.ask(this.o.prompt ? 'you › ' : '');
        if (raw === null) return 0;
        if (!raw.trim()) continue;
        const slash = parseSlash(raw);
        if (slash) {
          const result = await executeCommand(slash, {
            garnet, sessionId: this.sessionId, theme: plainTheme, width: 100, toolLog: this.toolLog, attachments: this.attachments,
            switchTo: (id) => (this.sessionId = id),
          });
          if (result.effect === 'exit') return 0;
          const rows = result.rows(100);
          if (rows.length) this.o.err(rows.join('\n') + '\n');
          continue;
        }
        await this.turn(messageText(raw).trim());
      }
    } finally {
      process.off('SIGINT', onSigint);
      this.close();
    }
  }

  private async turn(text: string): Promise<void> {
    this.current = new AbortController();
    let wroteText = false;
    const onEvent = (e: RuntimeEvent) => {
      if (e.type === 'text') {
        this.o.out(e.text);
        wroteText = true;
      } else if (e.type === 'tool_start') {
        if (wroteText) this.o.out('\n');
        wroteText = false;
        this.o.err(`  [tool] ${truncate(describeCall(e.call), 160)}\n`);
      } else if (e.type === 'tool_end') {
        this.toolLog.push({ call: e.call, result: e.result });
        if (e.result.status === 'error') this.o.err(`  [tool ${e.result.category}] ${truncate(sanitize(e.result.content.replace(/\s+/g, ' ')), 160)}\n`);
      } else if (e.type === 'retry') {
        this.o.err(`  [retrying in ${Math.round(e.delayMs / 1000)}s: ${sanitize(e.message)}]\n`);
      } else if (e.type === 'compacting') {
        this.o.err('  [compacting older turns]\n');
      } else if (e.type === 'tainted') {
        this.o.err(`  [untrusted content read: ${sanitize(e.source)}; risky actions now ask first until /new]\n`);
      }
    };
    try {
      const prepared = await prepareTurn(this.o.garnet, this.sessionId, text, this.attachments.splice(0), this.current.signal);
      if ('reply' in prepared) {
        this.o.out(`${prepared.reply}\n`);
        return;
      }
      const task = await this.o.garnet.agent.run(this.sessionId, prepared.turn, { signal: this.current.signal, onEvent, source: 'cli' });
      if (wroteText) this.o.out('\n');
      const u = task.usage;
      this.o.err(`  [${task.status}${task.reason ? `: ${sanitize(task.reason)}` : ''} · in ${formatTokens(u.inputTokens)} · cached ${formatTokens(u.cacheReadTokens)} · out ${formatTokens(u.outputTokens)} tokens]\n\n`);
    } catch (e) {
      // Like the interactive chat: report the error and keep the conversation going.
      if (wroteText) this.o.out('\n');
      this.o.err(`  [error: ${sanitize(errorMessage(e))}]\n\n`);
    } finally {
      this.current = null;
    }
  }
}
