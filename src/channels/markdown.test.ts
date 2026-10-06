import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownToPlain, markdownToTelegramHtml, splitMarkdown } from './markdown.ts';

test('Telegram HTML: emphasis, code, links, lists, quotes and headings; everything else escaped', () => {
  const md = [
    '# Plan',
    'Use **bold**, *italic*, _also_, ~~old~~ and `a<b> && c`.',
    'snake_case_name and 2*3*4 stay as they are.',
    '- one',
    '- [x] done',
    '> quoted *text*',
    'See [docs](https://example.com/a_b?x=1&y="2") or https://example.com/_raw_.',
    'Bad [link](javascript:alert(1)) and <script>alert(1)</script>',
  ].join('\n');
  assert.equal(
    markdownToTelegramHtml(md),
    [
      '<b>Plan</b>',
      'Use <b>bold</b>, <i>italic</i>, <i>also</i>, <s>old</s> and <code>a&lt;b&gt; &amp;&amp; c</code>.',
      'snake_case_name and 2*3*4 stay as they are.',
      '• one',
      '☑ done',
      '<blockquote>quoted <i>text</i></blockquote>',
      'See <a href="https://example.com/a_b?x=1&amp;y=&quot;2&quot;">docs</a> or https://example.com/_raw_.',
      'Bad link (javascript:alert(1)) and &lt;script&gt;alert(1)&lt;/script&gt;',
    ].join('\n'),
  );
});

test('Telegram HTML: fenced code keeps its content verbatim; tables become monospace; tags never cross', () => {
  assert.equal(markdownToTelegramHtml('```ts\nconst a = x < y && **b**;\n```'), '<pre><code class="language-ts">const a = x &lt; y &amp;&amp; **b**;</code></pre>');
  assert.equal(markdownToTelegramHtml('```\nunclosed <b>'), '<pre>unclosed &lt;b&gt;</pre>');
  assert.equal(markdownToTelegramHtml('| a | b |\n|---|---|\n| 1 | 2 |'), '<pre>| a | b |\n| 1 | 2 |</pre>');
  assert.equal(markdownToTelegramHtml('**a *b* c** and *x **y** z*'), '<b>a <i>b</i> c</b> and *x <b>y</b> z*');
});

test('plain text drops the markers cleanly', () => {
  assert.equal(markdownToPlain('## Done\n**Saved** `notes.txt` to [the folder](https://x.y/z).\n- a\n```\ncode **raw**\n```'), 'Done\nSaved notes.txt to the folder (https://x.y/z).\n• a\ncode **raw**');
  assert.equal(markdownToPlain('a < b & c'), 'a < b & c');
});

test('splitMarkdown closes and reopens a code block cut between chunks', () => {
  const text = `intro\n\`\`\`js\n${'line\n'.repeat(40)}\`\`\`\nafter`;
  const chunks = splitMarkdown(text, 100);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.length <= 100, `${c.length}`);
    assert.equal((c.match(/^```/gm) ?? []).length % 2, 0, c);
  }
  assert.ok(chunks.slice(1, -1).every((c) => c.startsWith('```js\n')));
  assert.ok(chunks.at(-1)!.endsWith('```\nafter'));
  assert.deepEqual(splitMarkdown('x'.repeat(250), 100).map((c) => c.length), [100, 100, 50], 'no fences: plain splitting');
});
