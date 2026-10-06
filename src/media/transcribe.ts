// Speech to text for voice notes: an OpenAI-compatible endpoint, or a local command.
import { RubyError, errorMessage } from '../contracts/index.ts';
import { runOnFile } from './command.ts';
import { extensionFor } from './mime.ts';

export interface Transcriber {
  /** Short description for logs and doctor output, e.g. "openai-compatible (https://api.groq.com/...)". */
  readonly label: string;
  transcribe(file: { data: Uint8Array; mimeType: string; name?: string | undefined }, signal: AbortSignal): Promise<string>;
}

export type OpenAITranscriberOptions = {
  /** API base, e.g. https://api.openai.com/v1, https://api.groq.com/openai/v1, http://127.0.0.1:8080/v1 */
  baseUrl: string;
  /** Path under the base. Default "/audio/transcriptions". whisper.cpp's server uses "/inference" unless started with --inference-path. */
  path?: string | undefined;
  apiKey?: string | undefined;
  model: string;
  language?: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
};

/**
 * POST multipart/form-data to `/audio/transcriptions` (OpenAI, Groq, speaches,
 * whisper.cpp server with `--inference-path`), `response_format=json`, and
 * reads `{ text }`. The key is sent only as a bearer token and redacted from
 * every error.
 */
export class OpenAITranscriber implements Transcriber {
  readonly label: string;
  private readonly o: OpenAITranscriberOptions;

  constructor(options: OpenAITranscriberOptions) {
    this.o = options;
    this.label = `openai-compatible (${options.baseUrl}, model ${options.model})`;
  }

  async transcribe(file: { data: Uint8Array; mimeType: string; name?: string | undefined }, signal: AbortSignal): Promise<string> {
    const o = this.o;
    const form = new FormData();
    // Providers pick the decoder from the file name's extension, so it must match the bytes.
    const filename = `audio${extensionFor(file.mimeType)}`;
    form.append('file', new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }), filename);
    form.append('model', o.model);
    form.append('response_format', 'json');
    if (o.language) form.append('language', o.language);
    const url = `${o.baseUrl.replace(/\/+$/, '')}${o.path ?? '/audio/transcriptions'}`;
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(url, {
        method: 'POST',
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs)]),
      });
    } catch (e) {
      if (signal.aborted) throw new RubyError('cancelled', 'Cancelled.');
      throw new RubyError('provider_transient', `Transcription request failed: ${this.redact(errorMessage(e))}`);
    }
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = this.redact(excerpt(body));
      const category = res.status === 429 || res.status >= 500 ? 'provider_transient' : 'provider_fatal';
      const hint = res.status === 401 || res.status === 403 ? ' (check the transcription API key)' : res.status === 404 ? ' (check media.transcription.baseUrl, path and model)' : '';
      throw new RubyError(category, `Transcription failed with HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`);
    }
    let text: unknown;
    try {
      text = (JSON.parse(body) as { text?: unknown }).text;
    } catch {
      text = body; // a server that ignored response_format and sent plain text
    }
    if (typeof text !== 'string') throw new RubyError('provider_fatal', 'Transcription response had no text.');
    return text.trim();
  }

  private redact(s: string): string {
    return this.o.apiKey ? s.split(this.o.apiKey).join('<key>') : s;
  }
}

/**
 * Runs a local command (whisper.cpp's whisper-cli, openai-whisper, a wrapper
 * script) and takes the transcript from stdout. See `runOnFile`.
 */
export class CommandTranscriber implements Transcriber {
  readonly label: string;
  private readonly argv: string[];
  private readonly timeoutMs: number;

  constructor(argv: string[], timeoutMs: number) {
    this.argv = argv;
    this.timeoutMs = timeoutMs;
    this.label = `command (${argv[0] ?? '?'})`;
  }

  async transcribe(file: { data: Uint8Array; mimeType: string }, signal: AbortSignal): Promise<string> {
    const out = await runOnFile({ argv: this.argv, timeoutMs: this.timeoutMs }, file.data, file.mimeType, signal);
    // whisper-cli prints "[00:00:00.000 --> 00:00:02.000]  text" unless run with -nt; strip timestamps either way.
    return out
      .split('\n')
      .map((l) => l.replace(/^\s*\[\d{2}:\d{2}[:.\d]*\s*-->\s*\d{2}:\d{2}[:.\d]*\]\s*/, '').trim())
      .filter(Boolean)
      .join('\n');
  }
}

function excerpt(body: string): string {
  let text = body.trim();
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof j.error === 'string') text = j.error;
    else if (typeof j.error?.message === 'string') text = j.error.message;
    else if (typeof j.message === 'string') text = j.message;
  } catch {
    // not JSON
  }
  text = text.replace(/\s+/g, ' ');
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
