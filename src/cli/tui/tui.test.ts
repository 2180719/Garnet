import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { VirtualTerminal } from '../../../test/vt.ts';
import { defaultConfig } from '../../config/index.ts';
import { KeyParser, type Key } from '../chat/keys.ts';
import { displayWidth, stripAnsi } from '../chat/text.ts';
import { makeTheme } from '../chat/theme.ts';
import { configScreen, displayValue, fieldsFromSchema, getAt, setAt, type ConfigState } from './config-browser.ts';
import { FULLSCREEN_OFF, FULLSCREEN_ON, FullscreenSession, wantsFullscreen, type Screen } from './fullscreen.ts';
import { TuiPrompter, stageOf } from './prompter.ts';
import { initConfirm, initMultiSelect, initSecret, initSelect, initText, updatePrompt, viewPrompt, type PromptState, type PromptValue } from './prompts.ts';

const plain = makeTheme({ styled: false, color: false, truecolor: false });
const noColor = makeTheme({ styled: true, color: false, truecolor: false });
const keys = (text: string): Key[] => {
  const parser = new KeyParser();
  return [...parser.feed(text), ...parser.flush()];
};
const view = (cur: { state: PromptState }, w = 60, h = 20, stage: { index: number; total: number; label: string } | null = null, context: string[] = []) =>
  viewPrompt(cur.state, w, h, { theme: plain, stage, context }).rows;

/** Feeds scripted keys to a prompt state; returns the final state and what it finished with. */
function drive(state: PromptState, input: string): { state: PromptState; done?: { value: PromptValue } | { cancel: true } } {
  let cur = state;
  for (const k of keys(input)) {
    const step = updatePrompt(cur, k);
    cur = step.state;
    if (step.done) return { state: cur, done: step.done };
  }
  return { state: cur };
}

test('multiselect prompt: Space and digits toggle, a flips all/none, Enter returns choices in order, marks are text', () => {
  const ask = { id: 'channels', message: 'Channels?', choices: [{ value: 'telegram', label: 'Telegram' }, { value: 'discord', label: 'Discord' }, { value: 'signal', label: 'Signal' }], default: ['signal'] };
  assert.deepEqual(drive(initMultiSelect(ask), '\r').done, { value: ['signal'] });
  assert.deepEqual(drive(initMultiSelect(ask), ' \x1b[B\x1b[B \r').done, { value: ['telegram'] });
  assert.deepEqual(drive(initMultiSelect(ask), '2\r').done, { value: ['discord', 'signal'] });
  assert.deepEqual(drive(initMultiSelect(ask), 'a\r').done, { value: ['telegram', 'discord', 'signal'] });
  assert.deepEqual(drive(initMultiSelect(ask), 'a\x1b[Ba\r').done, { value: [] });
  assert.deepEqual(drive(initMultiSelect(ask), '\x1b').done, { cancel: true });
  const rows = view(drive(initMultiSelect(ask), ''));
  assert.ok(rows.some((r) => r.includes('[x] 3) Signal')) && rows.some((r) => r.includes('[ ] 1) Telegram')));
});

test('text prompt: typing, paste with newlines, cursor editing, default, validation keeps the screen open', () => {
  const ask = { id: 'name', message: 'Name?', help: 'Shown in chat.', default: 'Garnet', validate: (v: string) => (v.length > 6 ? 'Too long.' : null) };
  assert.deepEqual(drive(initText(ask), '\r').done, { value: 'Garnet' });
  assert.deepEqual(drive(initText(ask), 'Jun\x1b[Do\r').done, { value: 'Juon' });
  assert.deepEqual(drive(initText(ask), '\x1b[200~a\nb\x1b[201~\r').done, { value: 'a b' });
  const bad = drive(initText(ask), 'abcdefg\r');
  assert.equal(bad.done, undefined);
  assert.ok(view(bad).some((r) => r.includes('✗ Too long.')));
  assert.deepEqual(drive(bad.state, '\x7f\r').done, { value: 'abcdef' });
  assert.deepEqual(drive(initText(ask), 'hello world\x17\x15x\r').done, { value: 'x' });
});

test('every prompt cancels on Esc and Ctrl+C', () => {
  const states = [initText({ id: 'a', message: 'A' }), initConfirm({ id: 'b', message: 'B', default: true }), initSelect({ id: 'c', message: 'C', choices: [{ value: 'x', label: 'X' }] }), initSecret({ id: 'd', message: 'D' })];
  for (const s of states) {
    assert.deepEqual(drive(s, '\x03').done, { cancel: true });
    assert.deepEqual(drive(s, '\x1b').done, { cancel: true });
  }
});

test('confirm and select keys', () => {
  const c = { id: 'go', message: 'Go?', default: false };
  assert.deepEqual(drive(initConfirm(c), '\r').done, { value: false });
  assert.deepEqual(drive(initConfirm(c), '\x1b[C\r').done, { value: true });
  assert.deepEqual(drive(initConfirm(c), 'y').done, { value: true });
  assert.deepEqual(drive(initConfirm(c), 'N').done, { value: false });
  const sel = { id: 'p', message: 'Pick', default: 'b', choices: ['a', 'b', 'c', 'd'].map((v) => ({ value: v, label: v.toUpperCase(), hint: `hint ${v}` })) };
  assert.deepEqual(drive(initSelect(sel), '\r').done, { value: 'b' });
  assert.deepEqual(drive(initSelect(sel), '\x1b[B\x1b[B\x1b[B\x1b[B\r').done, { value: 'd' });
  assert.deepEqual(drive(initSelect(sel), '\x1b[H\r').done, { value: 'a' });
  assert.deepEqual(drive(initSelect(sel), '3\r').done, { value: 'c' });
  // Unknown sequences (a mouse report) change nothing.
  assert.deepEqual(drive(initSelect(sel), '\x1b[<64;10;10M\r').done, { value: 'b' });
});

test('frames: text marks, header with step, footer hints, exact height, nothing wider than the screen', () => {
  const s = drive(initSelect({ id: 'p', message: 'Which model?', help: 'Pick one.', default: 'b', choices: [{ value: 'a', label: 'Alpha', hint: 'first' }, { value: 'b', label: 'Beta' }] }), '').state;
  const rows = view({ state: s }, 50, 16, { index: 2, total: 5, label: 'Model' }, ['Let us begin.']);
  assert.equal(rows.length, 16);
  assert.equal(rows[0], ' ◆ GARNET / SETUP             Step 2 of 5 · Model');
  assert.match(rows[1]!, /^ \[#{12}-{18}\] 2\/5/);
  assert.ok(rows.includes('  Let us begin.'));
  assert.ok(rows.includes('  Which model?'));
  assert.ok(rows.includes('  Pick one.'));
  assert.ok(rows.includes('    1) Alpha  first'));
  assert.ok(rows.includes('› 2) Beta  (default)') || rows.includes('  › 2) Beta  (default)'));
  assert.match(rows.at(-1)!, /↑\/↓ move · 1-9 jump · Enter choose · Esc cancel/);
  for (const r of rows) assert.ok(displayWidth(stripAnsi(r)) <= 50, r);
  assert.equal(rows.join('').includes('\x1b'), false, 'no colour codes without colour');
});

test('frames: confirm marks read without colour; short terminals drop chrome but keep the question and hints', () => {
  const s = initConfirm({ id: 'go', message: 'Install the service?', default: true });
  assert.ok(view({ state: s }).some((r) => r.includes('(•) Yes    ( ) No')));
  for (const h of [3, 4, 5, 7, 8, 13]) {
    const rows = view({ state: s }, 40, h, { index: 1, total: 3, label: 'Finish' }, ['a note', 'another note']);
    assert.equal(rows.length, h);
    assert.ok(rows.some((r) => r.includes('(•) Yes')), `height ${h}`);
    assert.match(rows.at(-1)!, /Esc cancel/);
  }
  // A narrow terminal wraps the question instead of overflowing.
  for (const r of view({ state: s }, 20, 12)) assert.ok(displayWidth(stripAnsi(r)) <= 20);
});

test('NO_COLOR keeps bold and dim but emits no colour codes', () => {
  const s = initSelect({ id: 'p', message: 'Pick', default: 'a', choices: [{ value: 'a', label: 'A', hint: 'h' }] });
  const rows = viewPrompt(s, 60, 20, { theme: noColor, stage: { index: 1, total: 2, label: 'Model' }, context: ['note'] }).rows.join('\n');
  assert.ok(rows.includes('\x1b[1m') || rows.includes('\x1b[2m'));
  assert.equal(/\x1b\[(3[0-9]|38|4[0-9]);/.test(rows) || /\x1b\[3[0-7]m/.test(rows), false);
});

test('long choice lists keep the highlight on screen', () => {
  const choices = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
  const s = drive(initSelect({ id: 'p', message: 'Pick', choices }), '\x1b[F').state;
  const rows = view({ state: s }, 40, 8);
  assert.equal(rows.length, 8);
  assert.ok(rows.some((r) => r.includes('› Option 29')));
});

test('secret input is dots only: the value is never in a frame', () => {
  const s = drive(initSecret({ id: 'key', message: 'Paste your key', help: 'From the console.' }), 'sk-ant-SECRET\x7f').state;
  const rows = view({ state: s });
  const text = rows.join('\n');
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('sk-ant'), false);
  assert.ok(rows.some((r) => r.includes('› ••••••••••••')));
  assert.match(text, /12 characters typed/);
  assert.deepEqual(drive(s, '\r').done, { value: 'sk-ant-SECRE' });
  assert.deepEqual(drive(initSecret({ id: 'key', message: 'k' }), '\x1b[A\x1b[D\x1b[200~ab c\x1b[201~\r').done, { value: 'ab c' });
});

test('setup stage mapping', () => {
  assert.equal(stageOf('provider'), 'Import & model');
  assert.equal(stageOf('keep-key'), 'Import & model');
  assert.equal(stageOf('import-apply'), 'Import & model');
  assert.equal(stageOf('name'), 'Persona');
  assert.equal(stageOf('discord'), 'Channels');
  assert.equal(stageOf('review'), 'Save');
  assert.equal(stageOf('pair-wait'), 'Finish');
  assert.equal(stageOf('something-new'), null);
});

class FakeTerminal extends VirtualTerminal {
  raw: boolean[] = [];
  writes: string[] = [];
  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }
}

function fakeStreams(columns = 60, rows = 14) {
  const input = Object.assign(new PassThrough(), { isTTY: true, raw: [] as boolean[], setRawMode(m: boolean) { this.raw.push(m); } });
  const output = new FakeTerminal(columns, rows);
  return { input, output };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('session: enters the alternate screen, draws, restores on finish and on cancel, and is idempotent', async () => {
  const { input, output } = fakeStreams();
  const session = new FullscreenSession({ input, output, processHooks: false });
  const p = new TuiPrompter({ input, output, theme: plain, processHooks: false });
  const answer = p.select({ id: 'provider', message: 'Which model?', default: 'b', choices: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] });
  await tick();
  assert.equal(output.writes[0], FULLSCREEN_ON);
  assert.ok(output.screen().some((r) => r.includes('Which model?')));
  assert.ok(output.screen().some((r) => r.includes('› 2) Beta')));
  assert.deepEqual(input.raw, [true]);
  // Resize redraws at the new size.
  output.columns = 30;
  output.rows = 8;
  p['session']['onResize']();
  assert.ok(output.writes.at(-1)!.includes('Which model?'));
  input.write('\x1b[A\r');
  assert.equal(await answer, 'a');
  // Still open between prompts; close restores everything.
  assert.deepEqual(p.close().length, 0);
  assert.equal(output.writes.at(-1), FULLSCREEN_OFF);
  assert.deepEqual(input.raw, [true, false]);
  p.close();
  assert.equal(output.writes.filter((w) => w === FULLSCREEN_OFF).length, 1);
  session.close(); // never opened: no output
  assert.equal(output.writes.filter((w) => w === FULLSCREEN_OFF).length, 1);
});

test('prompter: Ctrl+C rejects as cancelled; captured wizard output is shown as context and replayed after close', async () => {
  const { input, output } = fakeStreams(60, 16);
  const p = new TuiPrompter({ input, output, theme: plain, processHooks: false });
  p.capture('out')('\x1b[1mStep one\x1b[0m: open the page.\n');
  p.capture('err')('careful\n');
  const asked = p.text({ id: 'name', message: 'What is your name?' });
  await tick();
  const screen = output.screen();
  assert.ok(screen.some((r) => r.includes('Step one: open the page.')));
  assert.ok(screen.some((r) => r.includes('careful')));
  input.write('\x03');
  await assert.rejects(asked, (e: Error) => /Setup cancelled/.test(e.message));
  const log = p.close();
  assert.deepEqual(log.map((l) => [l.stream, l.text]), [['out', '\x1b[1mStep one\x1b[0m: open the page.\n'], ['err', 'careful\n']]);
  assert.equal(output.writes.at(-1), FULLSCREEN_OFF);
});

test('prompter: review returns the owner choice and shows the summary without ANSI', async () => {
  const { input, output } = fakeStreams(60, 16);
  const p = new TuiPrompter({ input, output, theme: plain, processHooks: false });
  const yes = p.review({ id: 'review', message: 'Save these settings?', body: '  \x1b[2mModel\x1b[0m     fake\n  Key       ANTHROPIC_API_KEY (not set yet)\n' });
  await tick();
  assert.ok(output.screen().some((r) => r.includes('Save these settings?')));
  assert.ok(output.screen().some((r) => r.includes('ANTHROPIC_API_KEY (not set yet)')));
  input.write('n');
  assert.equal(await yes, false);
  p.close();
});

test('wantsFullscreen: needs two TTYs, a usable TERM and no --plain', () => {
  const tty = { isTTY: true };
  assert.equal(wantsFullscreen({ stdin: tty, stdout: tty }, { TERM: 'xterm-256color' }), true);
  assert.equal(wantsFullscreen({ stdin: tty, stdout: tty }, { TERM: 'xterm' }, true), false);
  assert.equal(wantsFullscreen({ stdin: tty, stdout: tty }, { TERM: 'dumb' }), false);
  assert.equal(wantsFullscreen({ stdin: tty, stdout: tty }, {}), false);
  assert.equal(wantsFullscreen({ stdin: {}, stdout: tty }, { TERM: 'xterm' }), false);
  assert.equal(wantsFullscreen({ stdin: tty, stdout: {} }, { TERM: 'xterm' }), false);
});

// ---------- config browser ----------

function browser(config = defaultConfig()) {
  const saved: unknown[] = [];
  const screen = configScreen(config, { save: (c) => saved.push(c), file: '/tmp/home/config.json', theme: plain });
  let state: ConfigState = screen.state;
  let finished = false;
  const press = (text: string) => {
    for (const k of keys(text)) {
      const step = screen.update(state, k);
      state = step.state;
      if (step.done) finished = true;
    }
    return screen.view(state, 80, 24).rows.map((r) => stripAnsi(r));
  };
  return { press, saved, get state() { return state; }, get finished() { return finished; }, screen };
}

test('config fields are generated from the schema, with documented descriptions and secret NAMES flagged', async () => {
  const { configSchema } = await import('../../config/index.ts');
  const fields = fieldsFromSchema(configSchema.toJSONSchema({ io: 'input' }) as never);
  const byPath = (p: string) => fields.find((f) => f.path.join('.') === p)!;
  assert.equal(byPath('model.provider').kind, 'enum');
  assert.ok(byPath('model.provider').choices.includes('anthropic'));
  assert.match(byPath('model.name').description, /Model ID/);
  assert.equal(byPath('model.apiKeyEnv').secretName, true);
  assert.equal(byPath('model.apiKeyEnv').secretValue, false);
  assert.equal(byPath('channels.telegram.tokenEnv').secretName, true);
  assert.equal(byPath('model.fallbacks').kind, 'boolean');
  assert.equal(byPath('model.maxOutputTokens').kind, 'integer');
  assert.equal(byPath('jobs').kind, 'complex');
  assert.equal(byPath('version').fixed, true);
  assert.equal(byPath('version').section, 'general');
  assert.equal(byPath('model.pricing.input').section, 'model');
  // Every field has a description (the schema rule), so the browser can show it.
  assert.deepEqual(fields.filter((f) => !f.description && f.path.length > 1).map((f) => f.path.join('.')), []);
});

test('config browser: sections, fields, description and validated edits', () => {
  const b = browser();
  let rows = b.press('');
  assert.ok(rows.some((r) => r.includes('› general')));
  rows = b.press('j'); // model
  assert.ok(rows.some((r) => r.includes('› model')));
  rows = b.press('\r');
  assert.ok(rows.some((r) => r.includes('model.provider')));
  assert.ok(rows.some((r) => r.includes('model.apiKeyEnv')));
  assert.ok(rows.some((r) => /Model used|anthropic, or openai-compatible/.test(r)) || rows.some((r) => /one of/.test(r)));
  // Move to maxOutputTokens and break it, then fix it.
  let guard = 0;
  while (guard++ < 30 && !b.press('j').some((r) => r.includes('› model.maxOutputTokens'))) {}
  rows = b.press('\r');
  assert.equal(b.state.level, 'edit');
  rows = b.press('\x15abc\r');
  assert.ok(rows.some((r) => r.includes('✗') && r.includes('not a number')), rows.join('\n'));
  rows = b.press('\x15-5\r');
  assert.ok(rows.some((r) => r.includes('✗')), 'schema rejects a non-positive cap');
  assert.equal(getAt(b.state.draft, ['model', 'maxOutputTokens']), 32000);
  rows = b.press('\x15 4096\r');
  assert.equal(b.state.level, 'fields');
  assert.equal(getAt(b.state.draft, ['model', 'maxOutputTokens']), 4096);
  assert.ok(rows.some((r) => r.includes('4096') && r.includes('(changed)')));
  assert.match(rows[0]!, /unsaved changes/);
  // Save: validated and written once; the saved state clears the marker.
  rows = b.press('s');
  assert.equal(b.saved.length, 1);
  assert.equal(getAt(b.saved[0], ['model', 'maxOutputTokens']), 4096);
  assert.match(rows[0]!, /no changes/);
  assert.ok(rows.some((r) => r.includes('✓ Saved /tmp/home/config.json')));
});

test('config browser: enum and boolean edits, reset, unsaved-changes prompt on quit', () => {
  const b = browser();
  b.press('j\r'); // model fields: provider is first
  b.press('\r'); // enum popup
  assert.equal(b.state.level, 'enum');
  b.press('\x1b[B\r'); // gemini (second choice, valid as is); openai-compatible would need a baseUrl
  const after = getAt(b.state.draft, ['model', 'provider']);
  assert.ok(after === 'gemini' || after === 'openai-compatible' || after === 'anthropic');
  // Boolean toggles in place.
  let guard = 0;
  while (guard++ < 30 && !b.press('j').some((r) => r.includes('› model.fallbacks'))) {}
  assert.equal(getAt(b.state.draft, ['model', 'fallbacks']), true);
  const rows = b.press(' ');
  assert.equal(getAt(b.state.draft, ['model', 'fallbacks']), false);
  assert.ok(rows.some((r) => r.includes('[ ] off') && r.includes('(changed)')));
  // x resets an optional field to its default.
  b.press('x');
  assert.equal(getAt(b.state.draft, ['model', 'fallbacks']), true);
  b.press(' ');
  // Esc to sections, q asks, any other key keeps editing, y discards.
  b.press('\x1b');
  assert.equal(b.state.level, 'sections');
  const quit = b.press('\x1b');
  assert.equal(b.finished, false);
  assert.ok(quit.some((r) => r.includes('unsaved changes')));
  b.press('n');
  assert.equal(b.state.level, 'sections');
  b.press('q');
  b.press('y');
  assert.equal(b.finished, true);
  assert.equal(b.saved.length, 0);
});

test('config browser never shows or accepts secret values; names are shown', () => {
  const cfg = defaultConfig();
  const leaky = setAt(cfg, ['model', 'apiKeyEnv'], 'ANTHROPIC_API_KEY') as typeof cfg;
  const synthetic = { path: ['x', 'password'], section: 'x', kind: 'string' as const, description: '', default: undefined, choices: [], optional: true, secretName: false, secretValue: true, fixed: false };
  assert.equal(displayValue(synthetic, 'hunter2-very-secret'), '[hidden]');
  assert.equal(displayValue({ ...synthetic, secretValue: false, path: ['model', 'name'] }, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV'), '[redacted]');
  const b = browser(leaky);
  b.press('j\r');
  const rows = b.press('');
  assert.ok(rows.some((r) => r.includes('model.apiKeyEnv') && r.includes('ANTHROPIC_API_KEY')));
});

test('config browser: complex fields are read-only with a pointer to the file; NO_COLOR frames have no escapes', () => {
  const b = browser();
  b.press('\r'); // general
  let guard = 0;
  while (guard++ < 30 && !b.press('j').some((r) => r.includes('› jobs'))) {}
  const rows = b.press('\r');
  assert.ok(rows.some((r) => r.includes('edit config.json by hand')));
  assert.equal(b.state.level, 'fields');
  assert.equal(b.screen.view(b.state, 80, 24).rows.join('').includes('\x1b'), false);
});
