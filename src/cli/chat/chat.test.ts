// End-to-end: drives `garnet chat` with a scripted model through a fake TTY and
// checks what a person would see on the screen.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { VirtualTerminal } from '../../../test/vt.ts';
import type { ModelAdapter, ModelEvent, ModelRequest } from '../../contracts/index.ts';
import { createGarnet } from '../../main.ts';
import { FakeModel, type FakeScript } from '../../models/index.ts';
import { chat } from './index.ts';

class FakeStdin extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(mode: boolean): this {
    this.raw = mode;
    return this;
  }
}

class FakeStdout {
  readonly vt: VirtualTerminal;
  raw = '';
  isTTY = true;
  columns: number;
  rows: number;
  private readonly resize = new Set<() => void>();
  constructor(columns = 80, rows = 30) {
    this.columns = columns;
    this.rows = rows;
    this.vt = new VirtualTerminal(columns, rows);
  }
  write(s: string): boolean {
    this.raw += s;
    this.vt.write(s);
    return true;
  }
  on(_: 'resize', fn: () => void): void {
    this.resize.add(fn);
  }
  off(_: 'resize', fn: () => void): void {
    this.resize.delete(fn);
  }
  setSize(columns: number, rows: number): void {
    this.columns = this.vt.columns = columns;
    this.rows = this.vt.rows = rows;
    for (const fn of this.resize) fn();
  }
}

type Started = {
  stdin: FakeStdin;
  stdout: FakeStdout;
  done: Promise<number>;
  home: string;
  err: string[];
  text: () => string;
  until: (check: (text: string) => boolean, what: string) => Promise<void>;
  type: (keys: string) => Promise<void>;
};

function start(model: ModelAdapter, options: { home?: string; args?: string[]; env?: NodeJS.ProcessEnv; columns?: number } = {}): Started {
  const home = options.home ?? tempDir();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(options.columns ?? 80);
  const err: string[] = [];
  const done = chat(
    options.args ?? [],
    { out: () => {}, err: (t) => err.push(t), stdin, stdout, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...options.env } },
    { createGarnet: (o) => createGarnet({ ...o, home, env: {}, model }), processHooks: false },
  );
  const text = () => stdout.vt.text();
  const until = async (check: (t: string) => boolean, what: string) => {
    const deadline = Date.now() + 4000;
    while (!check(text())) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}. Screen:\n${text()}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const type = async (keys: string) => {
    stdin.write(keys);
    await new Promise((r) => setTimeout(r, 15));
  };
  return { stdin, stdout, done, home, err, text, until, type };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** A model that streams slowly, so a turn can be interrupted or typed over. */
class SlowModel extends FakeModel {
  private readonly delayMs: number;
  constructor(script: FakeScript, delayMs: number) {
    super(script);
    this.delayMs = delayMs;
  }
  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    for await (const e of super.stream(request)) {
      if (e.type === 'done') await new Promise((r) => setTimeout(r, this.delayMs));
      yield e;
    }
  }
}

test('a conversation with markdown, a tool call, an inline approval and history', async () => {
  const model = new FakeModel([
    { text: 'Saving it.', toolCalls: [{ name: 'write_file', input: { path: 'a.md', content: '- milk' } }] },
    { text: 'Saved **a.md**:\n\n- milk\n- `eggs`' },
    { toolCalls: [{ name: 'write_file', input: { path: 'b.md', content: 'x' } }] },
    { text: 'Saved b.' },
  ]);
  const c = start(model);
  await c.until((t) => t.includes('◆ GARNET / terminal chat') && t.includes('\n›'), 'the banner and prompt');
  assert.ok(c.stdin.raw, 'raw mode is on');
  assert.ok(c.stdout.raw.includes('\x1b[?2004h'), 'bracketed paste is enabled');

  await c.type('save my list\r');
  await c.until((t) => t.includes('Allow? y allow once'), 'the approval prompt');
  assert.match(c.text(), /› save my list/);
  assert.match(c.text(), /◆ Saving it\./);
  assert.match(c.text(), /\? write_file needs approval \(fs\.write\)/);
  await c.type('a');
  await c.until((t) => t.includes('✓ done'), 'the end of the turn');
  const t1 = c.text();
  assert.match(t1, /✓ approved \(for the rest of this chat\)/);
  assert.match(t1, /✓ write_file a\.md · \d+ms/);
  assert.match(t1, /◆ Saved a\.md:\n\n  • milk\n  • eggs/, 'markdown is rendered: bold and code markers are gone, bullets are drawn');
  assert.ok(existsSync(join(c.home, 'workspace', 'a.md')));

  await c.type('another\r');
  await c.until((t) => count(t, '✓ done') === 2, 'the second turn');
  assert.match(c.text(), /write_file allowed \(always, this chat\)/, '"always" covers later calls of the same tool');
  assert.ok(existsSync(join(c.home, 'workspace', 'b.md')));

  await c.type('\x04'); // Ctrl+D on an empty line
  assert.equal(await c.done, 0);
  assert.ok(!c.stdin.raw, 'raw mode is restored');
  assert.ok(c.stdout.raw.endsWith('\x1b[<u\x1b[?2004l\x1b[?25h'), 'terminal modes are reset and the cursor shown');
  const lines = c.text().split('\n');
  assert.match(lines.at(-1)!, /✓ done/, 'the live region (input, footer) is erased on exit; the transcript stays');
  const history = readFileSync(join(c.home, 'chat_history.jsonl'), 'utf8');
  assert.equal(history, '"save my list"\n"another"\n');
});

test('Esc interrupts a running turn without leaving the chat; Ctrl+C twice exits', async () => {
  const hanging: ModelAdapter = {
    id: 'test:hang',
    capabilities: { streaming: true, promptCaching: false, contextWindow: 1000 },
    async *stream(req) {
      yield { type: 'text_delta', text: 'Thinking about it' };
      await new Promise((r) => req.signal?.addEventListener('abort', r));
      yield { type: 'error', category: 'cancelled', message: 'aborted' };
    },
  };
  const c = start(hanging);
  await c.type('long task\r');
  await c.until((t) => t.includes('Thinking about it') && t.includes('esc to interrupt'), 'streamed text and the spinner');
  await c.type('\x1b');
  await c.until((t) => t.includes('■ interrupted'), 'the interrupted status');
  assert.match(c.text(), /◆ Thinking about it/, 'text streamed before the interrupt is kept');
  await c.type('\x03');
  await c.until((t) => t.includes('Press Ctrl+C again to exit'), 'the exit hint');
  await c.type('\x03');
  assert.equal(await c.done, 0);
});

test('messages typed while Garnet works are queued and sent next', async () => {
  const c = start(new SlowModel([], 150));
  await c.type('first\r');
  await c.type('second\r');
  await c.until((t) => t.includes('↳ queued: second'), 'the queued message');
  await c.until((t) => count(t, '✓ done') === 2, 'both turns');
  assert.match(c.text(), /You said: first[\s\S]*› second[\s\S]*You said: second/);
  await c.type('/exit\r');
  assert.equal(await c.done, 0);
});

test('slash commands: help, unknown, usage, model, sessions, new, expand, compact', async () => {
  const model = new FakeModel([
    { toolCalls: [{ name: 'list_files', input: { path: '.' } }] },
    { text: 'one' },
    { text: 'two' },
    { text: 'three' },
    { text: '<summary>We said one, two and three.</summary>' },
  ]);
  const c = start(model);
  await c.type('/he');
  await c.until((t) => t.includes('/help') && t.includes('Show commands and keyboard shortcuts'), 'the suggestion list');
  await c.type('\t\r');
  await c.until((t) => t.includes('Keys') && t.includes('Shift+Enter'), 'help');
  await c.type('/bogus\r');
  await c.until((t) => t.includes('Unknown command /bogus'), 'the unknown-command message');
  for (const m of ['a\r', 'b\r', 'c\r']) {
    const before = count(c.text(), '✓ done');
    await c.type(m);
    await c.until((t) => count(t, '✓ done') === before + 1, `turn ${m}`);
  }
  await c.type('/expand\r');
  await c.until((t) => /list_files \. \(ok\)\n  input/.test(t), 'the expanded tool call');
  await c.type('/usage\r');
  await c.until((t) => t.includes('Budget per task'), 'usage');
  assert.match(c.text(), /output\s+80 tokens/);
  assert.match(c.text(), /cache read\s+\? tokens/, 'unknown usage is shown as ?');
  await c.type('/model\r');
  await c.until((t) => t.includes('context window'), 'model info');
  await c.type('/compact\r');
  await c.until((t) => t.includes('Compacted older turns'), 'compaction');
  await c.type('/new\r');
  await c.until((t) => t.includes('New session ses_'), 'a new session');
  await c.type('/sessions\r');
  await c.until((t) => t.includes('Recent sessions'), 'the session list');
  assert.equal(count(c.text().split('Recent sessions')[1]!, 'Terminal chat'), 2);
  await c.type('/quit\r');
  assert.equal(await c.done, 0);
});

test('--session resumes with recent history; an unknown session fails', async () => {
  const home = tempDir();
  const first = start(new FakeModel(), { home });
  await first.type('remember me\r');
  await first.until((t) => t.includes('✓ done'), 'the first turn');
  const id = /session (ses_\w+)/.exec(first.text())![1]!;
  await first.type('\x04');
  assert.equal(await first.done, 0);

  const second = start(new FakeModel(), { home, args: ['--session', id] });
  await second.until((t) => t.includes('─── resumed ───'), 'the resumed transcript');
  assert.match(second.text(), /\(resumed\)[\s\S]*› remember me[\s\S]*◆ You said: remember me/);
  await second.type('\x04');
  assert.equal(await second.done, 0);

  const missing = start(new FakeModel(), { home, args: ['--session', 'ses_nope'] });
  assert.equal(await missing.done, 1);
  assert.match(missing.err.join(''), /No session "ses_nope"/);
});

test('NO_COLOR keeps the interactive UI but emits no colors', async () => {
  const c = start(new FakeModel([{ text: 'Use `npm test`.' }]), { env: { NO_COLOR: '1' } });
  await c.type('hi\r');
  await c.until((t) => t.includes('✓ done'), 'the turn');
  assert.ok(!/\x1b\[(38|39)[;m]/.test(c.stdout.raw), 'no foreground colors');
  assert.match(c.text(), /◆ Use `npm test`\./, 'inline code keeps its backticks without color');
  await c.type('\x04');
  assert.equal(await c.done, 0);
});

test('a narrower terminal is redrawn cleanly at the new width', async () => {
  const c = start(new FakeModel([{ text: 'A reply long enough that it wraps differently once the terminal becomes much narrower than before.' }]), { columns: 100 });
  await c.type('hi\r');
  await c.until((t) => t.includes('✓ done'), 'the turn');
  await c.type('draft text');
  c.stdout.setSize(40, 30);
  await new Promise((r) => setTimeout(r, 120));
  const screen = c.stdout.vt.text().split('\n');
  assert.ok(screen.every((l) => [...l].length <= 40), `every row fits:\n${screen.join('\n')}`);
  assert.match(c.stdout.vt.text(), /◆ A reply long enough that it wraps\n  differently/);
  assert.equal(count(c.stdout.vt.text(), '› draft text'), 1, 'the input is drawn once');
  await c.type('\x15\x04');
  assert.equal(await c.done, 0);
});

test('escape sequences in model text, tool calls and approvals are shown, never sent to the terminal', async () => {
  const evil = 'x\x1b[2K\rHIDDEN\x1b]52;c;cHduZWQ=\x07';
  const model = new FakeModel([
    { text: `Look: ${evil}`, toolCalls: [{ name: 'write_file', input: { path: `a${evil}.md`, content: 'x' } }] },
    { text: 'ok' },
  ]);
  const c = start(model, { columns: 120 });
  await c.type('go\r');
  await c.until((t) => t.includes('Allow? y allow once'), 'the approval prompt');
  await c.type('n');
  await c.until((t) => t.includes('✓ done') || t.includes('■'), 'the end of the turn');
  assert.ok(!c.stdout.raw.includes('\x1b[2K'), 'no line erase from content');
  assert.ok(!c.stdout.raw.includes('\x1b]52'), 'no clipboard write from content');
  assert.match(c.text(), /◆ Look: x␛\[2K\n  HIDDEN␛\]52;c;cHduZWQ=␇/, 'a lone CR in model text is a line break; ESC and BEL are shown');
  assert.match(c.text(), /│ .*ax␛\[2K␍HIDDEN␛\]52;c;cHduZWQ=␇\.md/, 'the approval summary shows the control characters');
  await c.type('\x04');
  assert.equal(await c.done, 0);
});

test('/help redrawn at a narrower width keeps its layout', async () => {
  const c = start(new FakeModel(), { columns: 100 });
  await c.type('/help\r');
  await c.until((t) => t.includes('Keys'), 'help');
  c.stdout.setSize(60, 30);
  await new Promise((r) => setTimeout(r, 120));
  const rows = c.stdout.vt.text().split('\n');
  const i = rows.findIndex((r) => r.includes('Up / Down'));
  assert.ok(i >= 0, rows.join('\n'));
  assert.match(rows[i + 1]!, /^ {26}\S/, `continuation rows keep the hanging indent:\n${rows.join('\n')}`);
  await c.type('\x04');
  assert.equal(await c.done, 0);
});

test('without a terminal, chat is plain: replies on stdout, everything else on stderr', async () => {
  const home = tempDir();
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const model = new FakeModel([
    { toolCalls: [{ name: 'write_file', input: { path: 'p.md', content: 'x' } }] },
    { text: 'Wrote it.' },
  ]);
  const done = chat([], { out: (t) => out.push(t), err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {}, model }) });
  stdin.end('write it\ny\n/usage\nhello\n');
  assert.equal(await done, 0);
  assert.equal(out.join(''), 'Wrote it.\nYou said: hello\n');
  const e = err.join('');
  assert.match(e, /\? write_file wants fs\.write/);
  assert.match(e, /\[tool\] write_file p\.md/);
  assert.match(e, /Budget per task/);
  assert.ok(!/\x1b\[/.test(out.join('') + e), 'no escape sequences');
  assert.ok(existsSync(join(home, 'workspace', 'p.md')));
});

test('plain chat: /attach sends a file with the next message; unreadable files get an honest answer', async () => {
  const home = tempDir();
  const files = tempDir();
  writeFileSync(join(files, 'my notes.md'), '# Notes\n- buy milk\n');
  writeFileSync(join(files, 'voice.ogg'), readFileSync(join(import.meta.dirname, '..', '..', '..', 'test', 'media', 'voice.ogg')));
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const show = (req: ModelRequest) => ({ text: JSON.stringify(req.messages.at(-1)!.content.map((b) => (b.type === 'text' ? b.text : b.type))) });
  const model = new FakeModel([show, show]);
  const done = chat([], { out: (t) => out.push(t), err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {}, model }) });
  stdin.end(`/attach '${join(files, 'my notes.md')}'\n/attach\nsummarize\n/attach ${join(files, 'voice.ogg')}\nlisten\n/attach /nope/missing.txt\n`);
  assert.equal(await done, 0);
  const e = err.join('');
  assert.match(e, /Attached my notes\.md \(text\/markdown, 19 B\)\. It goes with your next message\./);
  assert.match(e, /· my notes\.md text\/markdown, 19 B/);
  assert.match(e, /Cannot read \/nope\/missing\.txt/);
  const o = out.join('');
  assert.match(o, /summarize/);
  assert.match(o, /\[Document attached: \\"my notes.md\\", text\/markdown, 19 B; id med_[a-f0-9]+\]\\n# Notes\\n- buy milk/);
  assert.match(o, /"listen","\[Audio attached: \\"voice.ogg\\", audio\/ogg, 47 B; id med_[a-f0-9]+\]\\n\(No transcription backend is configured/, 'with text, the model runs and is told why it cannot hear the audio');
});

test('plain chat: an "always" answer does not cover a call made after the session read untrusted content', async () => {
  const home = tempDir();
  const stdin = new PassThrough();
  const err: string[] = [];
  const call = { toolCalls: [{ name: 'write_file', input: { path: 'p.md', content: 'x' } }] };
  let garnet: ReturnType<typeof createGarnet> | undefined;
  const model = new FakeModel([
    call,
    { text: 'one' },
    () => {
      const id = garnet!.store.listSessions()[0]!.id;
      garnet!.store.append(id, { type: 'tainted', source: 'web_fetch https://evil.example/', callId: 'c1' });
      return call;
    },
    { text: 'two' },
  ]);
  const done = chat([], { out: () => {}, err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => (garnet = createGarnet({ ...o, home, env: {}, model })) });
  stdin.end('first\na\nsecond\nn\n');
  assert.equal(await done, 0);
  assert.equal((err.join('').match(/\? write_file wants fs\.write/g) ?? []).length, 2, 'the second call prompts again');
});
