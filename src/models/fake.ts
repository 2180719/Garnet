import type {
  ChatMessage,
  ContentBlock,
  ErrorCategory,
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  Usage,
} from '../contracts/index.ts';

export type FakeStep = {
  text?: string;
  toolCalls?: { name: string; input: unknown; id?: string }[];
  usage?: Partial<Usage>;
  error?: { category: ErrorCategory; message: string };
};

export type FakeScript = (FakeStep | ((request: ModelRequest) => FakeStep))[];

/**
 * Deterministic, offline model for tests and `ruby chat --fake`. Plays its
 * script one step per call; after the script ends it echoes the last user text.
 */
export class FakeModel implements ModelAdapter {
  readonly id = 'fake:scripted';
  readonly capabilities = { streaming: true, promptCaching: false, contextWindow: 200_000 };
  readonly requests: ModelRequest[] = [];
  private readonly script: FakeScript;
  private step = 0;
  private callCounter = 0;

  constructor(script: FakeScript = []) {
    this.script = script;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const entry = this.script[this.step++];
    const step: FakeStep = typeof entry === 'function' ? entry(request) : entry ?? { text: echo(request) };

    if (request.signal?.aborted) {
      yield { type: 'error', category: 'cancelled', message: 'aborted' };
      return;
    }
    if (step.error) {
      yield { type: 'error', ...step.error };
      return;
    }

    const content: ContentBlock[] = [];
    if (step.text) {
      for (const chunk of step.text.match(/.{1,16}/gs) ?? []) yield { type: 'text_delta', text: chunk };
      content.push({ type: 'text', text: step.text });
    }
    for (const call of step.toolCalls ?? []) {
      const block = { type: 'tool_call' as const, id: call.id ?? `fake_call_${++this.callCounter}`, name: call.name, input: call.input };
      content.push(block);
      yield { type: 'tool_call', call: block };
    }
    const usage: Usage = {
      inputTokens: step.usage?.inputTokens ?? 100,
      outputTokens: step.usage?.outputTokens ?? 20,
      cacheReadTokens: step.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: step.usage?.cacheWriteTokens ?? null,
    };
    const message: ChatMessage = { role: 'assistant', content };
    yield { type: 'done', message, stopReason: step.toolCalls?.length ? 'tool_use' : 'end_turn', usage };
  }
}

function echo(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  const text = last?.content.find((b) => b.type === 'text');
  return text && text.type === 'text' ? `You said: ${text.text}` : 'Done.';
}
