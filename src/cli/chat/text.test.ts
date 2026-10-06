import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayWidth, formatDuration, formatTokens, graphemes, padEnd, stripAnsi, truncate, wrapText } from './text.ts';

test('display width counts terminal cells, not code units', () => {
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('日本語'), 6, 'CJK is double width');
  assert.equal(displayWidth('🎉'), 2, 'emoji presentation is double width');
  assert.equal(displayWidth('👨‍👩‍👧'), 2, 'a ZWJ family is one double-width grapheme');
  assert.equal(displayWidth('🇳🇿'), 2, 'a flag is one double-width grapheme');
  assert.equal(displayWidth('é'), 1, 'combining marks take no cell');
  assert.equal(displayWidth('❤️'), 2, 'text-default symbol with VS16 renders as emoji');
  assert.equal(displayWidth('\x1b[1;38;2;1;2;3mred\x1b[0m'), 3, 'ANSI styles take no cells');
  assert.equal(displayWidth('\x1b]8;;https://x\x07link\x1b]8;;\x07'), 4, 'OSC hyperlinks take no cells');
  assert.deepEqual(graphemes('a👍🏽b'), ['a', '👍🏽', 'b']);
});

test('wrapText breaks at spaces and keeps every row within the width', () => {
  const rows = wrapText('the quick brown fox jumps over the lazy dog', 10);
  assert.deepEqual(rows, ['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog']);
  for (const r of wrapText('日本語のテキストを折り返す', 7)) assert.ok(displayWidth(r) <= 7, r);
});

test('wrapText hard-breaks words longer than a row and keeps indentation', () => {
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('    indented text here', 12), ['    indented', 'text here']);
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b'], 'newlines start rows');
  assert.deepEqual(wrapText('', 10), ['']);
});

test('wrapText carries styles across breaks so each row is self-contained', () => {
  const rows = wrapText('\x1b[1mbold words wrap\x1b[22m plain words', 10);
  assert.equal(rows.length, 3);
  assert.ok(rows[0]!.startsWith('\x1b[1m') && rows[0]!.endsWith('\x1b[0m'));
  assert.ok(rows[1]!.startsWith('\x1b[1m'), 'the style reopens on the next row');
  assert.deepEqual(rows.map(stripAnsi), ['bold words', 'wrap plain', 'words']);
  assert.ok(!rows[2]!.includes('\x1b[1m'), 'a closed style does not reopen');
});

test('truncate and padEnd are width-aware', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('short', 8), 'short');
  assert.equal(displayWidth(truncate('日本語日本語', 5)), 5);
  assert.equal(stripAnsi(truncate('\x1b[1mhello world\x1b[22m', 6)), 'hello…');
  assert.equal(padEnd('日本', 6), '日本  ');
});

test('formatTokens never shows unknown as zero', () => {
  assert.equal(formatTokens(null), '?');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(2000), '2k');
  assert.equal(formatTokens(34_400), '34k');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatDuration(450), '450ms');
  assert.equal(formatDuration(2400), '2.4s');
  assert.equal(formatDuration(125_000), '2m 5s');
});
