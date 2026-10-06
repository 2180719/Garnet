import type { SessionEvent, TaskStatus } from '../contracts/index.ts';

export const PROFILE_TOOL = 'set_profile';
/** The tools that save what the owner says. A real success of either shows the model can use its tools. */
const SAVE_TOOLS: readonly string[] = [PROFILE_TOOL, 'memory'];
/** Owner turns with a failed save (and nothing saved yet) before the conversation gives up on tools. */
export const MAX_TOOL_FAILURES = 2;
/** Owner replies without anything saved before the conversation gives up. */
export const MAX_OWNER_REPLIES = 7;
/** Consecutive turns that ended in a failure before the conversation gives up. */
export const MAX_FAILED_TURNS = 2;

export type Verdict =
  | { next: 'continue'; note?: string }
  | { next: 'fallback'; reason: string };

/**
 * Decides, after each turn of the wake-up conversation, whether the model is
 * doing its job. It reads only the session's event log, so it can be tested
 * without a UI. The conversation is "verified" once a real `set_profile` or
 * `memory` call succeeded; it falls back to the form when saves keep failing,
 * turns keep failing, or the owner has answered many times and nothing was
 * saved. Every limit is finite, so onboarding can never loop.
 */
export class OnboardingWatch {
  private readonly events: () => SessionEvent[];
  private failedTurns = 0;
  private announced = false;
  /** 'fallback' once a verdict asked for the form; never goes back. */
  state: 'running' | 'verified' | 'fallback' = 'running';

  constructor(events: () => SessionEvent[]) {
    this.events = events;
  }

  /**
   * What the session's tools did: names that finished ok, how many owner turns had a failed save, and
   * the owner replies so far. Only the tools onboarding relies on (`set_profile`, `memory`) count as
   * failures, and a turn counts once however many of its calls failed: one confusing reply (a bad
   * time zone and a full memory file together) is one strike, not two.
   */
  summary(): { ok: string[]; failedSaveTurns: number; ownerReplies: number } {
    const names = new Map<string, string>();
    const ok = new Set<string>();
    let failedSaveTurns = 0;
    let failedNow = false;
    let users = 0;
    for (const e of this.events()) {
      if (e.type === 'user_message') {
        if (failedNow) failedSaveTurns++;
        failedNow = false;
        users++;
      } else if (e.type === 'tool_started') {
        names.set(e.call.id, e.call.name);
      } else if (e.type === 'tool_finished') {
        const name = names.get(e.callId) ?? '?';
        if (e.result.status === 'ok') ok.add(name);
        else if (SAVE_TOOLS.includes(name)) failedNow = true;
      }
    }
    if (failedNow) failedSaveTurns++;
    // The first user message is the CLI's kickoff, not an answer.
    return { ok: [...ok], failedSaveTurns, ownerReplies: Math.max(0, users - 1) };
  }

  afterTurn(status: TaskStatus): Verdict {
    if (this.state === 'fallback') return { next: 'fallback', reason: 'already fell back' };
    const s = this.summary();
    if (s.ok.some((n) => SAVE_TOOLS.includes(n))) {
      this.state = 'verified';
      if (this.announced) return { next: 'continue' };
      this.announced = true;
      const used = s.ok.filter((n) => n !== '?').join(', ');
      const profile = s.ok.includes(PROFILE_TOOL);
      return { next: 'continue', note: `Tool check passed: the model used real tools (${used})${profile ? ' and the profile was saved.' : '; it has not called set_profile yet.'}` };
    }
    this.failedTurns = status === 'failed' ? this.failedTurns + 1 : 0;
    const give = (reason: string): Verdict => {
      this.state = 'fallback';
      return { next: 'fallback', reason };
    };
    if (status === 'budget_exhausted') return give('the spending limit was reached');
    if (this.failedTurns >= MAX_FAILED_TURNS) return give('the model kept failing');
    if (s.failedSaveTurns >= MAX_TOOL_FAILURES) return give('saving kept failing');
    if (s.ownerReplies >= MAX_OWNER_REPLIES) return give('nothing was saved after several answers');
    return { next: 'continue' };
  }
}
