import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VirtualTerminal } from '../../../test/vt.ts';
import type { SessionEvent, TaskRecord, ToolCallBlock, ToolResult } from '../../contracts/index.ts';
import { COMMANDS } from './commands.ts';
import { approvalChoices, approvalRows, describeCall, footer, fullscreenFooter, helpRows, scrollIndicator, sessionTotals, statusBar, suggestionRows, toolDoneRows, transcriptRows, turnSummary } from './render.ts';
import { Screen } from './screen.ts';
import { displayWidth, stripAnsi } from './text.ts';
import { makeTheme } from './theme.ts';

const plain = makeTheme({ styled: false, color: false, truecolor: false });
const call: ToolCallBlock = { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'notes.md' } };
const ok = (content: string): ToolResult => ({ status: 'ok', content, truncated: false, durationMs: 12 });

test('tool calls show the name, the telling argument, and a status in words', () => {
  assert.equal(describeCall(call), 'read_file notes.md');
  assert.equal(describeCall({ ...call, name: 'run_command', input: { command: 'ls  -la\n' } }), 'run_command ls -la ');
  assert.equal(describeCall({ ...call, name: 'x', input: { a: 1 } }), 'x {"a":1}');
  const done = toolDoneRows(call, ok('l1\nl2\nl3\nl4\nl5'), plain, 60);
  assert.deepEqual(done, ['  ✓ read_file notes.md · 12ms', '    ⎿ l1', '      l2', '      l3', '      … 2 more lines (/expand)']);
  const failed = toolDoneRows(call, { status: 'error', category: 'denied', content: 'The owner declined.', durationMs: 0 }, plain, 60);
  assert.equal(failed[0], '  ✗ read_file notes.md denied');
  const timeout = toolDoneRows(call, { status: 'error', category: 'timeout', content: 'timed out', durationMs: 0 }, plain, 60);
  assert.match(timeout[0]!, /failed \(timeout\)/);
  for (const r of toolDoneRows(call, ok('x'.repeat(500)), plain, 30)) assert.ok(displayWidth(r) <= 30, r);
});

test('approval prompts show the whole summary and the choices', () => {
  const summary = `run_command: ${'rm -rf ./build && '.repeat(10)}echo done`;
  const rows = approvalRows({ sessionId: 's', callId: 'c', tool: 'run_command', capability: 'exec', targets: [], input: {}, summary }, plain, 40);
  const shown = rows.map((r) => r.replace(/^ {4}│ /, '')).join('');
  assert.ok(shown.includes('echo done'), 'commands are never truncated in approvals');
  assert.ok(rows.every((r) => displayWidth(r) <= 40));
  const choices = approvalChoices({ sessionId: 's', callId: 'c', tool: 'run_command', capability: 'exec', targets: [], input: {}, summary }, plain, 200).join(' ');
  assert.match(choices, /y allow once · a always allow this exact command in this chat · n deny/);
});

const usage = (input: number | null, output: number | null) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: null, cacheWriteTokens: null });
const ev = (seq: number, payload: object) => ({ sessionId: 's', seq, at: '2026-01-01T00:00:00Z', ...payload }) as SessionEvent;

test('session totals add known usage and keep unknown as unknown', () => {
  const events = [
    ev(1, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, source: 'cli' }),
    ev(2, { type: 'assistant_message', message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage: usage(100, 20), model: 'm' }),
    ev(3, { type: 'assistant_message', message: { role: 'assistant', content: [] }, stopReason: 'end_turn', usage: usage(null, null), model: 'm' }),
  ];
  const t = sessionTotals(events);
  assert.equal(t.usage.inputTokens, 100);
  assert.equal(t.usage.cacheReadTokens, null);
  assert.equal(t.contextTokens, null, 'the latest request did not report usage');
  assert.equal(sessionTotals(events.slice(0, 2)).contextTokens, 120);
});

test('the footer keeps the most useful parts when narrow', () => {
  const totals = { usage: usage(1000, 200), contextTokens: 1200, turns: 1, untrusted: [], costUsd: null };
  const info = { model: 'anthropic:claude-x', sessionId: 'ses_0123456789abcdef', totals, contextWindow: 200_000 };
  assert.equal(footer(info, plain, 200), '  anthropic:claude-x · ses_0123456789abcdef · context 1.2k/200k (1%) · 1.2k tokens · /help');
  assert.equal(footer(info, plain, 64), '  ses_0123456789abcdef · context 1.2k/200k (1%) · 1.2k tokens');
  assert.equal(footer(info, plain, 60), '  anthropic:claude-x · context 1.2k/200k (1%) · 1.2k tokens');
  assert.equal(footer(info, plain, 40), '  context 1.2k/200k (1%) · 1.2k tokens');
  assert.equal(footer({ ...info, notice: 'Press Ctrl+C again to exit' }, plain, 80), '  Press Ctrl+C again to exit');
});

test('untrusted content is shown in words in the footer, rows and approval choices', () => {
  const events = [
    ev(1, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, source: 'cli' }),
    ev(2, { type: 'tainted', source: 'web_fetch https://example.com/', callId: 'c1' }),
    ev(3, { type: 'tainted', source: 'web_fetch https://example.com/', callId: 'c2' }),
  ];
  const totals = sessionTotals(events);
  assert.deepEqual(totals.untrusted, ['web_fetch https://example.com/']);
  const info = { model: 'm', sessionId: 's', totals, contextWindow: 200_000 };
  assert.match(footer(info, plain, 200), /⚠ untrusted content read/);
  assert.match(footer(info, plain, 30), /untrusted/, 'kept when narrow');
  assert.match(transcriptRows(events, plain, 100).join('\n'), /Read untrusted content: web_fetch https:\/\/example\.com\//);
  const req = { sessionId: 's', callId: 'c', tool: 'write_file', capability: 'fs.write' as const, targets: [], input: {}, summary: 'x' };
  assert.match(approvalChoices(req, plain, 100).join(' '), /always allow/);
  const tainted = approvalChoices({ ...req, taint: ['web_fetch https://example.com/'] }, plain, 100).join(' ');
  assert.doesNotMatch(tainted, /always/, 'no standing approval after untrusted content');
  assert.match(tainted, /allow once/);
});

test('turn summaries spell out the status and show unknown usage as ?', () => {
  const task = { status: 'cancelled', reason: 'Cancelled by the owner.', usage: usage(null, 5), toolCalls: 1 } as TaskRecord;
  const text = turnSummary(task, 1500, plain, 100).join('\n');
  assert.match(text, /■ interrupted · 1\.5s · 1 tool call · \? in · 5 out — Cancelled by the owner\./);
});

test('turn summaries show dollar cost, or ? without a price or with unknown tokens', () => {
  const pricing = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
  const known = { status: 'completed', reason: null, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, toolCalls: 0, modelCalls: 1 } as TaskRecord;
  assert.match(turnSummary(known, 1000, plain, 100, pricing).join('\n'), /1k in · 200 out · \$0\.02/);
  assert.match(turnSummary(known, 1000, plain, 100).join('\n'), /200 out · \?/);
  const unknown = { ...known, usage: usage(null, 5) } as TaskRecord;
  assert.match(turnSummary(unknown, 1000, plain, 100, pricing).join('\n'), /\? in · 5 out · \?/);
});

test('resumed transcripts show recent turns and say how many are hidden', () => {
  const events: SessionEvent[] = [];
  let seq = 0;
  for (let i = 1; i <= 8; i++) {
    events.push(ev(++seq, { type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }] }, source: i === 8 ? 'telegram' : 'cli' }));
    events.push(ev(++seq, { type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: `**answer** ${i}` }] }, stopReason: 'end_turn', usage: usage(1, 1), model: 'm' }));
  }
  const text = transcriptRows(events, plain, 60).join('\n');
  assert.match(text, /2 earlier turns not shown/);
  assert.ok(!text.includes('question 2\n') && text.includes('question 3'));
  assert.match(text, /› question 8 \[telegram\]/);
  assert.match(text, /◆ answer 8/);
  assert.deepEqual(transcriptRows([], plain, 60), []);
});

test('the screen redraws its live region in place and keeps committed rows', () => {
  const vt = new VirtualTerminal(40, 10);
  const screen = new Screen(vt);
  screen.setLive(['> typing', 'footer'], { row: 0, col: 8 });
  screen.setLive(['> typing more', 'footer'], { row: 0, col: 13 }, ['committed one']);
  screen.setLive(['> ', 'footer'], { row: 0, col: 2 }, ['committed two']);
  assert.equal(vt.text(), 'committed one\ncommitted two\n>\nfooter');
  assert.deepEqual(vt.cursor, { row: 2, col: 2 });
  screen.release();
  assert.equal(vt.text(), 'committed one\ncommitted two', 'release erases the live region');
});

test('a live region taller than the terminal keeps its bottom rows', () => {
  const vt = new VirtualTerminal(40, 5);
  const screen = new Screen(vt);
  screen.setLive(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { row: 6, col: 0 });
  assert.equal(stripAnsi(vt.text()), 'd\ne\nf\ng');
  screen.setLive(['x'], null);
  assert.equal(vt.text(), 'x');
});

test('command suggestions drop descriptions before names when narrow', () => {
  const wide = suggestionRows(COMMANDS.slice(0, 2), plain, 80);
  assert.match(wide[0]!, /^ {2}\/help\s+Show commands/);
  const narrow = suggestionRows(COMMANDS, plain, 24);
  assert.ok(narrow.every((r) => displayWidth(r) <= 24 && !r.includes('…')), narrow.join('\n'));
  assert.ok(narrow.includes('  /resume <session-id>'));
});

test('the fullscreen status bar: name, model, session and state in words; usage, cost (or ?) and the taint warning', () => {
  const totals = { usage: usage(1000, 200), contextTokens: 1200, turns: 1, untrusted: [] as string[], costUsd: null };
  const info = { name: 'Ruby', model: 'anthropic:claude-x', sessionId: 'ses_0123456789abcdef', totals, contextWindow: 200_000, state: 'ready', busy: false, approval: false };
  const bar = statusBar(info, plain, 100);
  assert.equal(bar.full.length, 3);
  assert.match(bar.full[0]!, /^ {2}◆ Ruby · anthropic:claude-x · ses_0123456789abcdef +○ ready$/);
  assert.equal(displayWidth(bar.full[0]!), 100, 'the state is right-aligned');
  assert.equal(bar.full[1], '  context 1.2k/200k (1%) · 1.2k tokens · cost ?', 'an unknown cost is ?, never $0');
  assert.match(statusBar({ ...info, totals: { ...totals, costUsd: 0.5 } }, plain, 100).full[1]!, /\$0\.50/);
  assert.equal(statusBar({ ...info, totals: { ...totals, turns: 0, contextTokens: null } }, plain, 100).full[1], '  /help for commands');
  const busy = statusBar({ ...info, state: 'thinking 2s', busy: true }, plain, 100).full[0]!;
  assert.match(busy, /● thinking 2s$/);
  assert.match(statusBar({ ...info, state: 'waiting for your approval', approval: true }, plain, 100).full[0]!, /\? waiting for your approval$/);
  const tainted = statusBar({ ...info, totals: { ...totals, untrusted: ['web_fetch x'] } }, plain, 40);
  assert.match(tainted.full[1]!, /^ {2}⚠ untrusted content read/, 'the warning comes first');
  assert.match(tainted.compact[0]!, /⚠ untrusted content read/, 'and stays in the one-row form');
  for (const w of [30, 40, 60, 100]) {
    for (const r of [...statusBar(info, plain, w).full, ...statusBar(info, plain, w).compact]) assert.ok(displayWidth(r) <= w, `${w}: ${r}`);
    assert.match(statusBar(info, plain, w).full[0]!, /ready/, `the state is kept at ${w}`);
  }
  const narrow = statusBar(info, plain, 40).full[0]!;
  assert.match(narrow, /◆ Ruby/);
  assert.doesNotMatch(narrow, /ses_/, 'the session goes first when narrow');
  assert.match(statusBar({ ...info, name: 'R\x1b[2Jx' }, plain, 100).full[0]!, /◆ R␛\[2Jx/, 'the name is sanitized');
});

test('the scroll indicator says what is below and how to get back; the fullscreen footer names the keys', () => {
  assert.equal(scrollIndicator(12, 0, plain, 80), '  ↓ 12 lines below · PgDn or Ctrl+End to follow');
  assert.equal(scrollIndicator(1, 3, plain, 80), '  ↓ new messages below (1 line) · PgDn or Ctrl+End to follow');
  assert.ok(displayWidth(scrollIndicator(12, 3, plain, 20)) <= 20);
  assert.equal(fullscreenFooter({ mouse: true }, plain, 80), '  PgUp/PgDn scroll · F2 mouse on · /help · Ctrl+D exits');
  assert.equal(fullscreenFooter({ mouse: false }, plain, 50), '  PgUp/PgDn scroll · F2 mouse off · /help');
  assert.equal(fullscreenFooter({ mouse: false, notice: 'hi' }, plain, 40), '  hi');
  assert.doesNotMatch(helpRows(plain, 100).join('\n'), /Scrolling/);
  assert.match(helpRows(plain, 100, true).join('\n'), /Scrolling[\s\S]*PgUp \/ PgDn[\s\S]*F2 or Alt\+M/);
});
