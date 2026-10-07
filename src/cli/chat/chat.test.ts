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
import { CONFIG_VERSION, loadConfig, parseConfig, readPersona } from '../../config/index.ts';
import { githubTool } from '../../connectors/index.ts';
import { Policy, type ApprovalRequest } from '../../policy/index.ts';
import { ToolExecutor, ToolRegistry, type WebFetcher } from '../../tools/index.ts';
import { alwaysKey } from './app.ts';
import { approvalRows } from './render.ts';
import { makeTheme } from './theme.ts';
import { onboardingScript } from '../../models/index.ts';
import { AnswerPrompter, type Prompter } from '../setup/prompt.ts';
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

type StartOptions = { home?: string; args?: string[]; env?: NodeJS.ProcessEnv; columns?: number; rows?: number; formPrompter?: Prompter; fullscreen?: boolean; processHooks?: boolean; /** Build the model from config with this environment instead of injecting `model` (provider swapping needs a configured one). */ configured?: NodeJS.ProcessEnv };

/** Starts the chat on a fake terminal: inline (`--inline`) unless `fullscreen` is set, then with the default mode. */
function start(model: ModelAdapter, options: StartOptions = {}): Started {
  const home = options.home ?? tempDir();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(options.columns ?? 80, options.rows ?? 30);
  const err: string[] = [];
  const done = chat(
    [...(options.fullscreen ? [] : ['--inline']), ...(options.args ?? [])],
    { out: () => {}, err: (t) => err.push(t), stdin, stdout, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...options.env } },
    { createGarnet: (o) => createGarnet({ ...o, home, env: options.configured ?? {}, ...(options.configured ? {} : { model }) }), processHooks: options.processHooks ?? false, ...(options.formPrompter ? { formPrompter: options.formPrompter } : {}) },
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

test('wake-up in the terminal UI: the agent speaks first, the tool calls are on screen, and the answers are saved', async () => {
  const c = start(new FakeModel(onboardingScript()), { args: ['--onboard'] });
  await c.until((t) => t.includes('I have just woken up'), 'the first message, before the owner typed anything');
  assert.doesNotMatch(c.text(), /\(The owner has just opened this chat/, 'the kickoff is not shown as if the owner typed it');
  for (const a of ['Ruby', 'call me Sam', 'Brief answers', 'Europe/Lisbon']) {
    await c.type(`${a}\r`);
    await c.until((t) => t.includes(`› ${a}`), `the answer ${a}`);
  }
  await c.type('planning my week\r');
  await c.until((t) => t.includes('Tool check passed'), 'the tool check');
  const t = c.text();
  assert.match(t, /✓ set_profile/);
  assert.match(t, /✓ memory/);
  assert.match(t, /Tool check passed: the model used real tools \(set_profile, memory\)/);
  await c.type('/exit\r');
  assert.equal(await c.done, 0);
  assert.deepEqual(readPersona(loadConfig(c.home).config.persona), { name: 'Ruby', owner: 'Sam', notes: 'Brief answers' });
});

test('wake-up in the terminal UI: an answer typed while the agent is still greeting is sent, not left in the queue', async () => {
  // The first model call is slow; the owner types the first answer before the greeting is done.
  const c = start(new SlowModel(onboardingScript(), 400), { args: ['--onboard'] });
  await c.until((t) => t.includes('I have just woken up'), 'the greeting');
  await c.type('Ruby\r');
  await c.until((t) => t.includes('↳ queued: Ruby'), 'the answer waiting behind the greeting');
  await c.until((t) => t.includes('And what should I call you?') || t.includes('what should I call you?'), 'the second question, so the queued answer was sent');
  assert.match(c.text(), /› Ruby/);
  await c.type('/exit\r');
  assert.equal(await c.done, 0);
});

test('wake-up in the terminal UI: /new and /resume are refused, so there is only the one onboarding session', async () => {
  const c = start(new FakeModel(onboardingScript()), { args: ['--onboard'] });
  await c.until((t) => t.includes('I have just woken up'), 'the greeting');
  await c.until((t) => !t.includes('thinking'), 'the greeting is done');
  await c.type('/new\r');
  await c.until((t) => t.includes('/new is not available in the wake-up chat'), 'the refusal');
  await c.type('/resume nothing\r');
  await c.until((t) => t.includes('/resume is not available in the wake-up chat'), 'the refusal');
  await c.type('/exit\r');
  assert.equal(await c.done, 0);
  const g = createGarnet({ home: c.home, env: {}, noModel: true });
  try {
    assert.deepEqual(g.store.listSessions().map((s) => s.title), ['Wake-up']);
  } finally {
    g.close();
  }
});

test('wake-up in the terminal UI: failing tools end the chat and the same questions are asked as a form', async () => {
  const form = new AnswerPrompter({ name: 'Opal', owner: 'Alex', notes: 'Be brief' }, { interactive: true });
  const c = start(new FakeModel(onboardingScript('broken-tools')), { args: ['--onboard'], formPrompter: form });
  await c.until((t) => t.includes('I have just woken up'), 'the first message');
  for (const a of ['Ruby', 'Sam', 'Brief', 'Lisbon', 'planning', 'try again']) {
    await c.type(`${a}\r`);
    await c.until((t) => t.includes(`› ${a}`), `the answer ${a}`);
  }
  assert.equal(await c.done, 0, 'the chat ended by itself');
  assert.match(c.text(), /Setup chat is stopping because saving kept failing/);
  assert.deepEqual(form.asked, ['name', 'owner', 'notes', 'timezone']);
  assert.deepEqual(readPersona(loadConfig(c.home).config.persona), { name: 'Opal', owner: 'Alex', notes: 'Be brief' });
  assert.equal(c.stdin.raw, false, 'the terminal was restored before the form');
});

test('garnet chat --onboard --fake runs the offline scripted wake-up with no other setup', async () => {
  const home = tempDir();
  const stdin = new PassThrough();
  const err: string[] = [];
  const done = chat(['--onboard', '--fake'], { out: () => {}, err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {} }) });
  stdin.end('Ruby\nSam\nBrief\nskip\nwriting\n/exit\n');
  assert.equal(await done, 0);
  assert.match(err.join(''), /Tool check passed/);
  assert.deepEqual(readPersona(loadConfig(home).config.persona), { name: 'Ruby', owner: 'Sam', notes: 'Brief' });
});

// ── fullscreen (the default on a terminal) ─────────────────────────────

const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const CTRL_END = '\x1b[1;5F';
const HOME = '\x1b[H';
const WHEEL_UP = '\x1b[<64;10;10M';
const WHEEL_DOWN = '\x1b[<65;10;10M';
const longReply = (n: number) => Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join('\n');

test('fullscreen: the status bar is there from the start, the transcript scrolls, follows, and says when there is more below', async () => {
  const c = start(new SlowModel([{ text: longReply(40) }, { text: 'Second reply.' }], 300), { fullscreen: true, rows: 20 });
  const screen = () => c.stdout.vt.screen();
  await c.until(() => /◆ Garnet · fake:scripted · ses_\w+ +○ ready/.test(screen()[0] ?? ''), 'the status bar on the first row before anything is typed');
  assert.ok(c.stdout.vt.alternate, 'the alternate screen is used');
  assert.ok(c.stdout.vt.modes.has(1000) && c.stdout.vt.modes.has(1006), 'SGR mouse reporting is on');
  assert.ok(c.stdout.vt.modes.has(2004), 'bracketed paste is on');
  assert.equal(screen().length, 20);
  assert.match(screen()[1]!, /\/help for commands/);
  assert.match(screen().at(-1)!, /PgUp\/PgDn scroll · F2 mouse on/);
  assert.match(screen().join('\n'), /◆ GARNET \/ terminal chat/, 'the banner opens the transcript');

  await c.type('hi\r');
  await c.until((t) => t.includes('✓ done'), 'the first turn');
  assert.match(screen()[0]!, /○ ready/);
  assert.match(screen()[1]!, /tokens/, 'usage appears in the status bar after a turn');
  assert.match(screen().join('\n'), /• item 40/);
  assert.doesNotMatch(screen().join('\n'), /• item 20\n/, 'older rows are above the view');

  await c.type(PAGE_UP);
  await c.until((t) => /↓ \d+ lines below · PgDn or Ctrl\+End to follow/.test(t), 'the indicator after PgUp');
  assert.doesNotMatch(c.text(), /✓ done/, 'the bottom is out of view');
  await c.type(PAGE_DOWN + PAGE_DOWN);
  await c.until((t) => t.includes('✓ done') && !t.includes('lines below'), 'following again after PgDn');

  await c.type(HOME);
  await c.until((t) => t.includes('◆ GARNET / terminal chat') && t.includes('lines below'), 'the top after Home on an empty input');
  await c.type(CTRL_END);
  await c.until((t) => t.includes('✓ done') && !t.includes('below'), 'the bottom after Ctrl+End');

  await c.type(WHEEL_UP);
  await c.until((t) => t.includes('lines below'), 'scrolled by the wheel');
  for (let i = 0; i < 5; i++) await c.type(WHEEL_DOWN);
  await c.until((t) => !t.includes('below'), 'back at the bottom by the wheel');

  // Output that arrives while scrolled up does not move the view; the indicator says it is there.
  await c.type('second\r');
  await c.until((t) => t.includes('Second reply.'), 'the second reply streaming');
  await c.type('\x1b[1;2A'); // Shift+Up: half a page
  await c.until((t) => t.includes('new messages below'), 'the new-messages indicator');
  await c.type(CTRL_END);
  await c.until((t) => t.includes('✓ done') && t.includes('Second reply.') && !t.includes('below'), 'following after Ctrl+End');

  await c.type('\x1bOQ'); // F2
  await c.until((t) => t.includes('Mouse reporting off'), 'the mouse notice');
  assert.ok(!c.stdout.vt.modes.has(1000), 'mouse reporting is off, so the terminal selects text');

  await c.type('\x04');
  assert.equal(await c.done, 0);
  const vt = c.stdout.vt;
  assert.ok(!vt.alternate, 'back on the normal screen');
  for (const m of [1049, 1000, 1006, 2004]) assert.ok(!vt.modes.has(m), `mode ${m} is off`);
  assert.ok(vt.cursorVisible, 'the cursor is shown');
  assert.ok(!c.stdin.raw, 'raw mode is off');
  assert.match(vt.text(), /◆ Continue this chat: garnet chat --session ses_\w+$/, 'a pointer back to the session on the normal screen');
});

test('fullscreen: a resize re-wraps the transcript and keeps the status bar, input and footer in place', async () => {
  const c = start(new FakeModel([{ text: 'A reply long enough that it wraps differently once the terminal becomes much narrower than before.' }]), { fullscreen: true, columns: 100, rows: 24 });
  await c.type('hi\r');
  await c.until((t) => t.includes('✓ done'), 'the turn');
  await c.type('draft text');
  c.stdout.setSize(40, 16);
  await new Promise((r) => setTimeout(r, 60));
  const rows = c.stdout.vt.screen();
  assert.equal(rows.length, 16);
  assert.ok(rows.every((l) => [...l].length <= 40), `every row fits:\n${rows.join('\n')}`);
  assert.match(rows[0]!, /◆ Garnet/);
  assert.match(rows.join('\n'), /◆ A reply long enough that it wraps\n  differently/);
  assert.equal(count(rows.join('\n'), '› draft text'), 1, 'the input is drawn once');
  assert.match(rows.at(-1)!, /PgUp/);
  c.stdout.setSize(30, 8);
  await new Promise((r) => setTimeout(r, 30));
  const tiny = c.stdout.vt.screen();
  assert.equal(tiny.length, 8);
  assert.match(tiny[0]!, /◆ Garnet.*ready/, 'a short terminal keeps a one-row status bar');
  await c.type('\x15\x04');
  assert.equal(await c.done, 0);
});

test('fullscreen: approvals are answered from the dock, even after scrolling; escape sequences stay visible', async () => {
  const evil = 'x\x1b[2K\rHIDDEN\x1b]52;c;cHduZWQ=\x07';
  const model = new FakeModel([
    { text: `Saving. ${evil}\n\n${longReply(30)}`, toolCalls: [{ name: 'write_file', input: { path: 'a.md', content: '- milk' } }] },
    { text: 'Saved.' },
  ]);
  const c = start(model, { fullscreen: true, rows: 20 });
  await c.type('save it\r');
  await c.until((t) => t.includes('Allow? y allow once'), 'the approval choices');
  assert.match(c.stdout.vt.screen()[0]!, /\? waiting for your approval/, 'the status bar says what it waits for');
  assert.match(c.text(), /\? write_file needs approval \(fs\.write\)/, 'the request is in view');
  await c.type(PAGE_UP);
  await c.until((t) => t.includes('lines below') && t.includes('Allow? y allow once'), 'scrolled, with the choices still shown');
  await c.type('y');
  await c.until((t) => t.includes('✓ done'), 'the end of the turn, in view again');
  assert.match(c.text(), /✓ approved \(once\)/);
  assert.ok(existsSync(join(c.home, 'workspace', 'a.md')));
  assert.ok(!c.stdout.raw.includes('\x1b[2K'), 'no line erase from content');
  assert.ok(!c.stdout.raw.includes('\x1b]52'), 'no clipboard write from content');
  await c.type(HOME);
  await c.until((t) => t.includes('HIDDEN'), 'the hostile text at the top');
  assert.match(c.text(), /x␛\[2K/);
  await c.type('/help\r');
  await c.until((t) => t.includes('F2 or Alt+M'), 'the scrolling keys in /help');
  await c.type('\x04');
  assert.equal(await c.done, 0);
});

test('"always" on a GitHub read never covers a GitHub comment (both ask): the comment asks as message.send', async () => {
  const config = parseConfig({ version: CONFIG_VERSION, permissions: { 'net.fetch': 'ask', 'message.send': 'ask' }, connectors: { github: { write: true } } });
  const tool = githubTool(config.connectors.github, { fetcher: {} as WebFetcher, secret: () => 'ghp_x', timeZone: 'UTC' });
  const asked: ApprovalRequest[] = [];
  const executor = new ToolExecutor({ registry: new ToolRegistry().register(tool), policy: new Policy(config.permissions), approver: async (r) => (asked.push(r), 'denied') });
  const call = (input: object) => executor.execute({ type: 'tool_call', id: 'c', name: 'github', input }, { sessionId: 's', workspace: '/w', memoryNamespace: 'default', signal: new AbortController().signal });
  await call({ action: 'issues', repo: 'org/app' });
  await call({ action: 'comment', repo: 'org/app', number: 1, body: 'hi' });
  const [read, comment] = asked;
  assert.equal(comment!.capability, 'message.send', 'the approval header names the write');
  assert.notEqual(alwaysKey(read!), alwaysKey(comment!));
  assert.match(approvalRows(comment!, makeTheme({ styled: false, color: false, truecolor: false }), 80).join('\n'), /github needs approval \(message\.send\)/);
});

test('fullscreen: a mouse report split across slow reads puts nothing in the input, and Ctrl+D still exits', async () => {
  const c = start(new FakeModel([]), { fullscreen: true });
  await c.until((t) => t.includes('›'), 'the prompt');
  c.stdin.write('\x1b[<0;1');
  await new Promise((r) => setTimeout(r, 400)); // longer than any flush timeout
  await c.type(';1M');
  assert.doesNotMatch(c.text(), /<0;1|;1M/, 'no part of the report reaches the editor');
  await c.type('\x04');
  assert.equal(await c.done, 0);
});

test('fullscreen: Esc interrupts a turn and drops the queue; Ctrl+C twice exits with the terminal restored', async () => {
  const hanging: ModelAdapter = {
    id: 'test:hang',
    capabilities: { streaming: true, promptCaching: false, contextWindow: 1000 },
    async *stream(req) {
      yield { type: 'text_delta', text: 'Thinking about it' };
      await new Promise((r) => req.signal?.addEventListener('abort', r));
      yield { type: 'error', category: 'cancelled', message: 'aborted' };
    },
  };
  const c = start(hanging, { fullscreen: true });
  await c.type('long task\r');
  await c.until((t) => t.includes('Thinking about it') && t.includes('esc to interrupt'), 'streamed text and the spinner');
  assert.match(c.stdout.vt.screen()[0]!, /● (thinking|writing)/, 'the status bar shows the turn in words');
  await c.type('next one\r');
  await c.until((t) => t.includes('↳ queued: next one'), 'the queued message');
  await c.type('\x1b');
  await c.until((t) => t.includes('■ interrupted'), 'the interrupted status');
  assert.doesNotMatch(c.text(), /queued/, 'the interrupt dropped the queue');
  assert.match(c.text(), /◆ Thinking about it/);
  await c.type('\x03');
  await c.until((t) => t.includes('Press Ctrl+C again to exit'), 'the exit hint');
  await c.type('\x03');
  assert.equal(await c.done, 0);
  assert.ok(!c.stdout.vt.alternate && !c.stdout.vt.modes.has(1000) && !c.stdin.raw);
});

test('fullscreen: SIGTERM and a crash both leave the terminal usable', async () => {
  const c = start(new FakeModel(), { fullscreen: true, processHooks: true });
  await c.until((t) => t.includes('○ ready'), 'the chat');
  const monitors = process.listenerCount('uncaughtExceptionMonitor');
  for (const l of process.listeners('uncaughtExceptionMonitor')) l(new Error('boom'), 'uncaughtException');
  assert.ok(!c.stdout.vt.alternate, 'a crash report would land on the normal screen');
  assert.ok(!c.stdout.vt.modes.has(1000) && c.stdout.vt.cursorVisible && !c.stdin.raw);
  await c.type('\x04');
  assert.equal(await c.done, 0);
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), monitors - 1, 'the hooks are removed on exit');

  const d = start(new FakeModel(), { fullscreen: true, processHooks: true });
  await d.until((t) => t.includes('○ ready'), 'the chat');
  process.emit('SIGTERM', 'SIGTERM');
  assert.equal(await d.done, 143);
  assert.ok(!d.stdout.vt.alternate && !d.stdout.vt.modes.has(1000) && !d.stdout.vt.modes.has(2004) && d.stdout.vt.cursorVisible && !d.stdin.raw);
});

test('fullscreen is the default; chat.fullscreen = false or --inline keeps the inline UI; --fullscreen overrides config', async () => {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, chat: { fullscreen: false } }));
  const inline = start(new FakeModel(), { home, fullscreen: true });
  await inline.until((t) => t.includes('◆ GARNET / terminal chat'), 'the banner');
  assert.ok(!inline.stdout.raw.includes('\x1b[?1049h'), 'config turned the alternate screen off');
  await inline.type('\x04');
  assert.equal(await inline.done, 0);

  const forced = start(new FakeModel(), { home, fullscreen: true, args: ['--fullscreen'] });
  await forced.until(() => forced.stdout.vt.alternate, 'the alternate screen');
  await forced.type('\x04');
  assert.equal(await forced.done, 0);

  const flag = start(new FakeModel());
  await flag.until((t) => t.includes('◆ GARNET / terminal chat'), 'the banner');
  assert.ok(!flag.stdout.raw.includes('\x1b[?1049h'), '--inline (added by start) keeps the inline UI');
  await flag.type('\x04');
  assert.equal(await flag.done, 0);

  const both = start(new FakeModel(), { fullscreen: true, args: ['--inline', '--fullscreen'] });
  assert.equal(await both.done, 2);
  assert.match(both.err.join(''), /cannot be combined/);
});

test('fullscreen wake-up: when tools fail, the chat leaves the alternate screen, says why, and asks the form', async () => {
  const form = new AnswerPrompter({ name: 'Opal', owner: 'Alex', notes: 'Be brief' }, { interactive: true });
  const c = start(new FakeModel(onboardingScript('broken-tools')), { args: ['--onboard'], formPrompter: form, fullscreen: true });
  await c.until((t) => t.includes('I have just woken up'), 'the first message');
  assert.match(c.stdout.vt.screen()[0]!, /◆ Garnet/);
  for (const a of ['Ruby', 'Sam', 'Brief', 'Lisbon', 'planning', 'try again']) {
    await c.type(`${a}\r`);
    await c.until((t) => t.includes(`› ${a}`) || !c.stdout.vt.alternate, `the answer ${a}`);
  }
  assert.equal(await c.done, 0, 'the chat ended by itself');
  assert.ok(!c.stdout.vt.alternate, 'the form is asked on the normal screen');
  assert.match(c.text(), /Setup chat is stopping because saving kept failing/);
  assert.deepEqual(form.asked, ['name', 'owner', 'notes', 'timezone']);
  assert.deepEqual(readPersona(loadConfig(c.home).config.persona), { name: 'Opal', owner: 'Alex', notes: 'Be brief' });
  assert.equal(c.stdin.raw, false);
});

for (const fullscreen of [true, false]) {
  test(`/provider in the ${fullscreen ? 'fullscreen' : 'inline'} chat lists, swaps from the next message and shows the provider in the status line`, async () => {
    const home = tempDir();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: CONFIG_VERSION, providers: { work: { provider: 'gemini', name: 'gemini-2.5-pro' } } }));
    const c = start(new FakeModel(), { home, fullscreen, rows: 24, configured: { ANTHROPIC_API_KEY: 'sk-ant-test', GEMINI_API_KEY: 'AIza-test' } });
    await c.until((t) => t.includes('anthropic:claude-opus-5-5'), 'the banner or status line with the default model');
    await c.type('/provider\r');
    await c.until((t) => t.includes('Providers') && t.includes('gemini · gemini-2.5-pro'), 'the provider list');
    await c.type('/provider work\r');
    await c.until((t) => t.includes('Now using work (gemini:gemini-2.5-pro)'), 'the swap confirmation');
    await c.until((t) => t.includes('work · gemini:gemini-2.5-pro'), 'the provider name beside the model');
    await c.type('/provider nope\r');
    await c.until((t) => t.includes('No provider named "nope"'), 'the refusal');
    await c.type('/exit\r');
    assert.equal(await c.done, 0);
    assert.equal(loadConfig(home).config.activeProvider, 'default', 'a swap in chat is not saved');
  });
}
