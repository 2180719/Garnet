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
