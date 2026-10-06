import type {
  ChatMessage,
  ContentBlock,
  ErrorCategory,
  MediaCapabilities,
  ModelAdapter,
  ModelCapabilities,
  ModelEvent,
  ModelRequest,
  StopReason,
  Usage,
} from '../contracts/index.ts';

export type FakeStep = {
  text?: string;
  toolCalls?: { name: string; input: unknown; id?: string }[];
  usage?: Partial<Usage>;
  /** Defaults to `tool_use` when the step has tool calls, else `end_turn`. */
  stopReason?: StopReason;
  error?: { category: ErrorCategory; message: string; retryAfterMs?: number };
};

export type FakeScript = (FakeStep | ((request: ModelRequest) => FakeStep))[];

/**
 * Deterministic, offline model for tests and `garnet chat --fake`. Plays its
 * script one step per call; after the script ends it echoes the last user text.
 */
export class FakeModel implements ModelAdapter {
  readonly id = 'fake:scripted';
  readonly capabilities: ModelCapabilities;
  readonly requests: ModelRequest[] = [];
  private readonly script: FakeScript;
  private step = 0;
  private callCounter = 0;

  /** `media` says what it pretends to read natively (default: images and PDFs, so tests see native blocks). */
  constructor(script: FakeScript = [], options: { media?: MediaCapabilities | undefined } = {}) {
    this.script = script;
    this.capabilities = {
      streaming: true,
      promptCaching: false,
      contextWindow: 200_000,
      media: options.media ?? { images: true, pdf: true, maxImageBytes: 5 * 1024 * 1024, maxPdfBytes: 20 * 1024 * 1024 },
    };
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
    yield { type: 'done', message, stopReason: step.stopReason ?? (step.toolCalls?.length ? 'tool_use' : 'end_turn'), usage };
  }
}

function echo(request: ModelRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  const files = last?.content.filter((b) => b.type === 'attachment' && b.data).length ?? 0;
  // The last text block the user typed: turns may start with a time stamp block (see context/messagesFromEvents)
  // and attachments come with a "[... attached: ...]" label.
  const text = last?.content.findLast((b) => b.type === 'text' && !/^\[(\w{3} \d{4}-\d\d-\d\d |\w+ attached: )/.test(b.text));
  const said = text && text.type === 'text' ? `You said: ${text.text}` : 'Done.';
  return files ? `${said}\n(${files} file(s) arrived as native blocks.)` : said;
}
