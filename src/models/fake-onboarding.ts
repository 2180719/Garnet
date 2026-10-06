import type { ModelRequest } from '../contracts/index.ts';
import type { FakeScript, FakeStep } from './fake.ts';

export type OnboardingMode =
  /** Asks the questions, saves with set_profile and memory, confirms. */
  | 'ok'
  /** Asks the questions, then every save has invalid input, so tools keep failing. */
  | 'broken-tools'
  /** Asks the questions forever and never calls a tool (a weak model). */
  | 'no-tools';

/** The text the owner typed in the last user turn (not the time stamp, not tool results). */
function lastAnswer(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  const text = last?.content.findLast((b) => b.type === 'text' && !/^\[\w{3} \d{4}-\d\d-\d\d /.test(b.text));
  return text && text.type === 'text' ? text.text.replace(/\s+/g, ' ').trim() : '';
}

/** Pulls a short value out of an answer such as "call me Sam" or "I'm in Lisbon"; "skip" and empty mean none. */
function clean(answer: string, lead: RegExp): string | undefined {
  const a = answer.replace(lead, '').replace(/[.!]+$/, '').trim();
  return !a || /^(skip|no|none|n\/a|-)$/i.test(a) ? undefined : a.slice(0, 60);
}

const QUESTIONS = [
  'Hello! I have just woken up, so this is our first conversation. I will ask a few quick questions and you can skip any of them. First: what would you like to call me?',
  'Nice to meet you. And what should I call you?',
  'How do you like your answers? Short or detailed, any tone, and anything I should never do?',
  'Optional: what is your time zone, or the city you live in?',
  'Last one: what do you mostly want my help with?',
];

/**
 * A scripted wake-up conversation for `--fake` and tests. Questions come one
 * per owner reply; after the last answer it makes real tool calls (set_profile
 * and memory) and then reports what happened from the tool results.
 */
export function onboardingScript(mode: OnboardingMode = 'ok'): FakeScript {
  const answers: string[] = [];
  const ask = (i: number): FakeStep => ({ text: QUESTIONS[i]! });
  const asking = (i: number) => (request: ModelRequest): FakeStep => {
    // The kickoff message is not an answer; every later turn is.
    if (i > 0) answers.push(lastAnswer(request));
    // A weak model keeps asking and never saves.
    return mode === 'no-tools' && i === QUESTIONS.length - 1 ? { text: 'Thanks! Could you tell me a bit more?' } : ask(i);
  };
  const save = (request: ModelRequest): FakeStep => {
    answers.push(lastAnswer(request));
    const [name, owner, style, where, help] = answers.slice(-5);
    const zone = where && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(where) ? where : undefined;
    const bad = mode === 'broken-tools';
    const nameV = clean(name ?? '', /^(call me|i'?d like|you can call me|name:?)\s+/i);
    const ownerV = clean(owner ?? '', /^(call me|i'?m|i am|my name is)\s+/i);
    const toolCalls: NonNullable<FakeStep['toolCalls']> = [
      {
        name: 'set_profile',
        input: {
          // A newline is rejected by the real tool, which is how this mode makes saving fail.
          ...(bad ? { assistant_name: 'Bad\nName' } : nameV ? { assistant_name: nameV } : {}),
          ...(ownerV ? { owner_name: ownerV } : {}),
          ...(style && !/^skip$/i.test(style) ? { style_notes: style.slice(0, 400) } : {}),
          ...(zone ? { timezone: zone } : {}),
        },
      },
    ];
    if (!bad) {
      if (where && !zone && !/^(skip|no|none)$/i.test(where)) toolCalls.push({ name: 'memory', input: { action: 'add', target: 'user', text: `Lives in or near: ${where.slice(0, 80)}` } });
      if (help && !/^(skip|no|none)$/i.test(help)) toolCalls.push({ name: 'memory', input: { action: 'add', target: 'user', text: `Wants help with: ${help.slice(0, 200)}` } });
    }
    return { text: 'Thank you, that is everything I need. Let me save it now.', toolCalls };
  };
  const report = (request: ModelRequest): FakeStep => {
    const last = request.messages.at(-1);
    const results = last?.content.filter((b) => b.type === 'tool_result') ?? [];
    const failed = results.filter((r) => r.isError);
    if (failed.length === 0) {
      return { text: 'All saved. I stored your profile and notes. My name and your preferences apply from the next session. What would you like help with first?' };
    }
    // One retry with the same input: a real model would change it, a broken one cannot.
    return mode === 'broken-tools'
      ? { text: 'That did not save. Let me try once more.', toolCalls: [{ name: 'set_profile', input: { assistant_name: 'Bad\nName' } }] }
      : { text: 'Some of that did not save, sorry.' };
  };
  const after = (request: ModelRequest): FakeStep => {
    const last = request.messages.at(-1);
    const failed = last?.content.some((b) => b.type === 'tool_result' && b.isError);
    return failed ? { text: 'I could not save that. We can use the short form instead.' } : { text: 'Anything else I can help with?' };
  };
  const script: FakeScript = [asking(0), asking(1), asking(2), asking(3), asking(4)];
  if (mode === 'no-tools') {
    // Never saves: keeps chatting for as long as the owner answers.
    for (let i = 0; i < 20; i++) script.push(asking(QUESTIONS.length - 1));
    return script;
  }
  script.push(save, report, after, after, after);
  return script;
}
