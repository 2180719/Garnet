import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownStream, renderInline, renderMarkdown } from './markdown.ts';
import { displayWidth, stripAnsi } from './text.ts';
import { makeTheme } from './theme.ts';

const plain = makeTheme({ styled: false, color: false, truecolor: false });
const color = makeTheme({ styled: true, color: true, truecolor: true });
const noColor = makeTheme({ styled: true, color: false, truecolor: false });
const md = (text: string, width = 60, theme = plain) => renderMarkdown(text, width, theme).map(stripAnsi);

test('inline styles: bold, italic, strike, code and links', () => {
  assert.equal(renderInline('**b** *i* ~~s~~', color), '\x1b[1mb\x1b[22m \x1b[3mi\x1b[23m \x1b[9ms\x1b[29m');
  assert.equal(stripAnsi(renderInline('use `npm **test**` now', color)), 'use npm **test** now', 'code spans are not styled inside');
  assert.equal(renderInline('use `x`', noColor), 'use `x`', 'without color, backticks stay so code remains visible');
  assert.equal(stripAnsi(renderInline('see [docs](https://example.com)', color)), 'see docs (https://example.com)');
  assert.equal(renderInline('snake_case_name and 2*3*4', plain), 'snake_case_name and 2*3*4', 'no false emphasis');
});

test('block elements: headings, lists, quotes, rules', () => {
  assert.deepEqual(md('# Title\nText'), ['Title', 'Text']);
  assert.deepEqual(md('- one\n* two\n1. three\n- [x] done\n- [ ] todo'), ['• one', '• two', '1. three', '☑ done', '☐ todo']);
  assert.deepEqual(md('> quoted'), ['│ quoted']);
  assert.deepEqual(md('---'), ['─'.repeat(40)]);
});

test('list items wrap with a hanging indent', () => {
  const rows = md('- a list item that is long enough to wrap around', 20);
  assert.deepEqual(rows, ['• a list item that', '  is long enough to', '  wrap around']);
  const nested = md('  - nested item that wraps here', 16);
  assert.ok(nested[1]!.startsWith('    '), 'continuation aligns under the nested text');
});

test('fenced code keeps spacing, is not markdown-styled, and is framed', () => {
  const rows = md('```ts\nconst  a = **b**;\n\n```\nafter');
  assert.deepEqual(rows, ['╭─ ts', '│ const  a = **b**;', '│ ', '╰─', 'after']);
  const long = md('```\n' + 'x'.repeat(30) + '\n```', 20);
  assert.ok(long.every((r) => displayWidth(r) <= 20), 'long code lines hard-wrap inside the frame');
});

test('tables are aligned when they fit and fall back to rows when they do not', () => {
  const table = '| name | qty |\n| --- | --: |\n| milk | 2 |\n| eggs | 12 |';
  assert.deepEqual(md(table), ['name │ qty', '─────┼────', 'milk │ 2', 'eggs │ 12']);
  const narrow = md('| a long header | another long header |\n|---|---|\n| x | y |', 20);
  assert.ok(narrow.every((r) => displayWidth(r) <= 20));
  assert.ok(narrow.join(' ').includes('x │ y'));
});

test('blank lines collapse and leading/trailing blanks are dropped', () => {
  assert.deepEqual(md('\n\npara one\n\n\n\npara two\n\n'), ['para one', '', 'para two']);
});

test('streaming in any chunking renders exactly like the whole document', () => {
  const doc = '# Plan\n\nSome **bold** text that is long enough to wrap at forty columns.\n\n- item `one`\n- item two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\nDone.';
  const whole = renderMarkdown(doc, 40, color);
  for (const size of [1, 3, 7, 50]) {
    const stream = new MarkdownStream({ width: 40, theme: color });
    const rows: string[] = [];
    for (let i = 0; i < doc.length; i += size) rows.push(...stream.push(doc.slice(i, i + size)));
    rows.push(...stream.finish());
    assert.deepEqual(rows, whole, `chunk size ${size}`);
  }
});

test('pending shows the partial line and an unfinished table without committing them', () => {
  const s = new MarkdownStream({ width: 40, theme: plain });
  assert.deepEqual(s.push('Hello **wor'), []);
  assert.deepEqual(s.pending(), ['Hello **wor']);
  assert.deepEqual(s.push('ld**\n| a | b |\n'), ['Hello world']);
  assert.deepEqual(s.pending(), ['| a | b |'], 'a table is held until it ends');
  assert.deepEqual(s.push('|---|---|\n| 1 | 2 |\nnext\n'), ['a │ b', '──┼──', '1 │ 2', 'next']);
  assert.deepEqual(s.push('```\ncode'), ['╭─']);
  assert.deepEqual(s.pending(), ['│ code'], 'a partial line inside a fence renders as code');
});
