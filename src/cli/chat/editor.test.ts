import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyKey, emptyEditor, layoutEditor, type EditorState } from './editor.ts';
import type { Key } from './keys.ts';

const k = (name: string, mods: Partial<Key> = {}): Key => ({ name, ctrl: false, meta: false, shift: false, ...mods });
const text = (t: string): Key => k('text', { text: t });

function type(keys: Key[], start: EditorState = emptyEditor(), history: string[] = []): EditorState {
  let s = start;
  for (const key of keys) s = applyKey(s, key, history).state;
  return s;
}
const at = (t: string, cursor = t.length): EditorState => ({ ...emptyEditor(), text: t, cursor });

test('typing inserts at the cursor; movement is by grapheme', () => {
  const s = type([text('helo'), k('left'), text('l')]);
  assert.deepEqual([s.text, s.cursor], ['hello', 4]);
  const emoji = type([k('backspace')], at('a👍🏽'));
  assert.equal(emoji.text, 'a', 'backspace removes a whole grapheme (emoji with skin tone)');
  const moved = type([k('left')], at('a👨‍👩‍👧'));
  assert.equal(moved.cursor, 1, 'left skips a ZWJ sequence');
});

test('word and line editing', () => {
  assert.equal(type([k('w', { ctrl: true })], at('one two three')).text, 'one two ');
  assert.equal(type([k('backspace', { meta: true })], at('one two')).text, 'one ');
  assert.equal(type([k('u', { ctrl: true })], at('one two', 4)).text, 'two');
  assert.equal(type([k('k', { ctrl: true })], at('one two', 3)).text, 'one');
  assert.equal(type([k('a', { ctrl: true })], at('one\ntwo')).cursor, 4, 'Ctrl+A goes to the start of the current line');
  assert.equal(type([k('left', { ctrl: true })], at('one two')).cursor, 4);
  assert.equal(type([k('b', { meta: true })], at('one two')).cursor, 4);
  assert.equal(type([k('delete')], at('abc', 1)).text, 'ac');
  assert.equal(type([k('d', { ctrl: true })], at('abc', 1)).text, 'ac', 'Ctrl+D deletes forward when there is text');
});

test('Enter submits; Shift/Alt+Enter, Ctrl+J and a trailing backslash add a line', () => {
  assert.equal(applyKey(at('hi'), k('enter')).action, 'submit');
  assert.equal(type([k('enter', { shift: true })], at('a')).text, 'a\n');
  assert.equal(type([k('enter', { meta: true })], at('a')).text, 'a\n');
  assert.equal(type([k('linefeed')], at('a')).text, 'a\n');
  assert.equal(type([k('j', { ctrl: true })], at('a')).text, 'a\n');
  const cont = applyKey(at('first \\'), k('enter'));
  assert.deepEqual([cont.action, cont.state.text], ['edit', 'first \n']);
});

test('typed newlines are dropped but pasted text keeps its lines', () => {
  assert.equal(type([text('a\nb')]).text, 'ab');
  assert.equal(type([k('paste', { text: 'a\r\nb' })]).text, 'a\nb');
});

test('up/down move between lines, then browse history keeping the draft', () => {
  const history = ['first', 'second'];
  let s: EditorState = { ...emptyEditor(history.length), text: 'draft', cursor: 5 };
  s = type([k('up')], s, history);
  assert.equal(s.text, 'second');
  s = type([k('up'), k('up')], s, history);
  assert.equal(s.text, 'first', 'stops at the oldest entry');
  s = type([k('down'), k('down')], s, history);
  assert.equal(s.text, 'draft', 'returns to the unsent draft');
  const multi = type([k('up')], { ...emptyEditor(2), text: 'ab\ncd', cursor: 4 }, history);
  assert.deepEqual([multi.text, multi.cursor], ['ab\ncd', 1], 'up inside a multi-line draft moves the cursor');
  assert.equal(type([k('p', { ctrl: true })], { ...emptyEditor(2), text: 'x', cursor: 1 }, history).text, 'second');
});

test('layout wraps rows, indents continuation lines and places the cursor', () => {
  const l = layoutEditor(at('hello world', 11), 10, '> ', '  ', 2);
  assert.deepEqual(l.rows, ['> hello wo', '  rld']);
  assert.deepEqual([l.cursorRow, l.cursorCol], [1, 5]);
  const nl = layoutEditor(at('a\nbc', 2), 20, '> ', '  ', 2);
  assert.deepEqual(nl.rows, ['> a', '  bc']);
  assert.deepEqual([nl.cursorRow, nl.cursorCol], [1, 2]);
  const full = layoutEditor(at('abcdefgh'), 10, '> ', '  ', 2);
  assert.deepEqual(full.rows, ['> abcdefgh', '  '], 'a cursor after a full row moves to a new row');
  assert.deepEqual([full.cursorRow, full.cursorCol], [1, 2]);
  const wide = layoutEditor(at('日本語', 2), 20, '> ', '  ', 2);
  assert.equal(wide.cursorCol, 2 + 4, 'wide characters advance the cursor by two cells');
  assert.deepEqual(layoutEditor(at('a\tb'), 20, '> ', '  ', 2).rows, ['> a    b']);
});
