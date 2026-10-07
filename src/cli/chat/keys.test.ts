import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyParser, type Key } from './keys.ts';

const parse = (...chunks: string[]): Key[] => {
  const p = new KeyParser();
  return [...chunks.flatMap((c) => p.feed(c)), ...p.flush()];
};
const names = (keys: Key[]) => keys.map((k) => `${k.ctrl ? 'C-' : ''}${k.meta ? 'M-' : ''}${k.shift ? 'S-' : ''}${k.name}${k.text !== undefined ? `:${k.text}` : ''}`);

test('typed text is grouped; control bytes are named keys', () => {
  assert.deepEqual(names(parse('héllo 日本')), ['text:héllo 日本']);
  assert.deepEqual(names(parse('a\rb')), ['text:a', 'enter', 'text:b']);
  assert.deepEqual(names(parse('\x03\x04\x01\x05\x0b\x15\x17\x0c\x1a')), ['C-c', 'C-d', 'C-a', 'C-e', 'C-k', 'C-u', 'C-w', 'C-l', 'C-z']);
  assert.deepEqual(names(parse('\t\x7f\b\n')), ['tab', 'backspace', 'backspace', 'linefeed']);
});

test('cursor and editing keys, with xterm modifiers', () => {
  assert.deepEqual(names(parse('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F')), ['up', 'down', 'right', 'left', 'home', 'end']);
  assert.deepEqual(names(parse('\x1bOA\x1bOH')), ['up', 'home'], 'SS3 (application mode)');
  assert.deepEqual(names(parse('\x1b[3~\x1b[1~\x1b[4~\x1b[5~')), ['delete', 'home', 'end', 'pageup']);
  assert.deepEqual(names(parse('\x1b[1;5C\x1b[1;3D\x1b[1;2A\x1b[Z')), ['C-right', 'M-left', 'S-up', 'S-tab']);
});

test('Alt+key arrives ESC-prefixed', () => {
  assert.deepEqual(names(parse('\x1bb\x1bf\x1b\r\x1b\x7f')), ['M-b', 'M-f', 'M-enter', 'M-backspace']);
});

test('Shift+Enter from the kitty protocol and xterm modifyOtherKeys', () => {
  assert.deepEqual(names(parse('\x1b[13;2u')), ['S-enter']);
  assert.deepEqual(names(parse('\x1b[27;2;13~')), ['S-enter']);
  assert.deepEqual(names(parse('\x1b[99;5u\x1b[27u\x1b[97u')), ['C-c', 'escape', 'text:a'], 'kitty disambiguated keys');
});

test('escape sequences split across reads are reassembled', () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed('x\x1b['), [{ name: 'text', ctrl: false, meta: false, shift: false, text: 'x' }]);
  assert.ok(p.pendingEscape);
  assert.deepEqual(names(p.feed('A')), ['up']);
  assert.ok(!p.pendingEscape);
});

test('a lone Escape is emitted on flush (after a short timeout)', () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed('\x1b'), []);
  assert.deepEqual(names(p.flush()), ['escape']);
});

test('bracketed paste is one key, even across reads, with newlines normalized', () => {
  assert.deepEqual(names(parse('\x1b[200~line 1\r\nline 2\x1b[201~')), ['paste:line 1\nline 2']);
  const p = new KeyParser();
  assert.deepEqual(p.feed('\x1b[200~first\x1b[2'), []);
  assert.deepEqual(names(p.feed('01~after')), ['paste:first', 'text:after']);
  assert.deepEqual(names(parse('\x1b[200~a\x1b[Ab\x1b[201~')), ['paste:a\x1b[Ab'], 'escape bytes inside a paste are text');
});

test('malformed or out-of-range key codes become unknown keys instead of throwing', () => {
  assert.deepEqual(names(parse('\x1b[1114112u\x1b[u\x1b[27;5;99999999~x')), ['unknown', 'unknown', 'unknown', 'text:x']);
});

test('mouse reports: the wheel is a key, other mouse events are ignorable, nothing leaks into text', () => {
  assert.deepEqual(names(parse('\x1b[<64;10;5M\x1b[<65;10;5M')), ['wheelup', 'wheeldown'], 'SGR wheel');
  assert.deepEqual(names(parse('\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<68;1;1M')), ['mouse', 'mouse', 'S-wheelup'], 'SGR click, release, Shift+wheel');
  assert.deepEqual(names(parse('\x1b[M`!!\x1b[Ma!!x')), ['wheelup', 'wheeldown', 'text:x'], 'legacy X10 reports');
  assert.deepEqual(names(parse('\x1b[<6', '5;2;2M', 'y')), ['wheeldown', 'text:y'], 'split across reads');
  const p = new KeyParser();
  assert.deepEqual(p.feed('\x1b[M'), [], 'an X10 report split across reads waits for its bytes');
  assert.deepEqual(names(p.feed('`!!')), ['wheelup']);
});

test('an escape sequence cut off by the flush timeout is dropped, and its late remainder is swallowed', () => {
  const p = new KeyParser();
  assert.deepEqual(p.feed('\x1b[<0;1'), []);
  assert.deepEqual(names(p.flush()), [], 'an incomplete mouse report is not text');
  assert.deepEqual(names(p.feed(';1M')), [], 'the rest of it arrives later and is swallowed');
  assert.deepEqual(names(p.feed('\x04')), ['C-d'], 'later keys work as usual');

  const q = new KeyParser();
  q.feed('\x1b[<0;1');
  q.flush();
  assert.deepEqual(names(q.feed(';1Mhi')), ['text:hi'], 'text after the swallowed remainder is kept');
  assert.deepEqual(names(q.feed('x')), ['text:x'], 'only the next read can continue a dropped sequence');

  const x = new KeyParser();
  x.feed('\x1b[M`');
  assert.deepEqual(names(x.flush()), []);
  assert.deepEqual(names(x.feed('!!y')), ['text:y'], 'an X10 report: its remaining bytes are swallowed');

  const alt = new KeyParser();
  alt.feed('\x1b[');
  assert.deepEqual(names(alt.flush()), ['M-['], 'a bare ESC [ is still Alt+[');
  assert.deepEqual(names(alt.feed('a')), ['text:a'], 'and the next key is not swallowed');
});

test('the flush timeout is short for a lone Escape and longer for a started sequence', () => {
  const p = new KeyParser();
  p.feed('\x1b');
  assert.equal(p.pendingTimeoutMs, 30);
  p.feed('[<0;1');
  assert.ok(p.pendingTimeoutMs > 30);
});

test('function keys F1-F4', () => {
  assert.deepEqual(names(parse('\x1bOP\x1bOQ\x1b[12~\x1b[1;2Q')), ['f1', 'f2', 'f2', 'S-f2']);
});
