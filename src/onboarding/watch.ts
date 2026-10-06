import type { SessionEvent, TaskStatus } from '../contracts/index.ts';

export const PROFILE_TOOL = 'set_profile';
/** Failed tool calls (with nothing saved yet) before the conversation gives up on tools. */
export const MAX_TOOL_FAILURES = 2;
/** Owner replies without a saved profile before the conversation gives up. */
export const MAX_OWNER_REPLIES = 7;
/** Consecutive turns that ended in a failure before the conversation gives up. */
export const MAX_FAILED_TURNS = 2;

export type Verdict =
  | { next: 'continue'; note?: string }
  | { next: 'fallback'; reason: string };

/**
 * Decides, after each turn of the wake-up conversation, whether the model is
 * doing its job. It reads only the session's event log, so it can be tested
 * without a UI. The conversation is "verified" once a real `set_profile` call
 * succeeded; it falls back to the form when tools keep failing, turns keep
 * failing, or the owner has answered many times and nothing was saved. Every
 * limit is finite, so onboarding can never loop.
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

  /** Tools that finished with a non-error result, and the number of errors, in this session. */
  summary(): { ok: string[]; errors: number; ownerReplies: number } {
    const events = this.events();
    const names = new Map<string, string>();
    const ok = new Set<string>();
    let errors = 0;
    let users = 0;
    for (const e of events) {
      if (e.type === 'tool_started') names.set(e.call.id, e.call.name);
      else if (e.type === 'tool_finished') {
        if (e.result.status === 'ok') ok.add(names.get(e.callId) ?? '?');
        else errors++;
      } else if (e.type === 'user_message') users++;
    }
    // The first user message is the CLI's kickoff, not an answer.
    return { ok: [...ok], errors, ownerReplies: Math.max(0, users - 1) };
  }

  afterTurn(status: TaskStatus): Verdict {
    if (this.state === 'fallback') return { next: 'fallback', reason: 'already fell back' };
    const s = this.summary();
    if (s.ok.includes(PROFILE_TOOL)) {
      this.state = 'verified';
      if (this.announced) return { next: 'continue' };
      this.announced = true;
      const used = s.ok.filter((n) => n !== '?').join(', ');
      return { next: 'continue', note: `Tool check passed: the model used real tools (${used}) and the profile was saved.` };
    }
    this.failedTurns = status === 'failed' ? this.failedTurns + 1 : 0;
    const give = (reason: string): Verdict => {
      this.state = 'fallback';
      return { next: 'fallback', reason };
    };
    if (status === 'budget_exhausted') return give('the spending limit was reached');
    if (this.failedTurns >= MAX_FAILED_TURNS) return give('the model kept failing');
    if (s.errors >= MAX_TOOL_FAILURES) return give('saving kept failing');
    if (s.ownerReplies >= MAX_OWNER_REPLIES) return give('nothing was saved after several answers');
    return { next: 'continue' };
  }
}
