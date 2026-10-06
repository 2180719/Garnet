import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appended, FOLLOW, following, maxTop, rewrapped, scrollBy, scrollToTop, topOf, trimmed, view } from './viewport.ts';

const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

test('following shows the last rows and stays at the bottom as rows arrive', () => {
  assert.deepEqual(view(rows(5), FOLLOW, 10), { rows: rows(5), below: 0, indicator: false }, 'short content starts at the top');
  assert.deepEqual(view(rows(30), FOLLOW, 10).rows, rows(30).slice(20));
  assert.equal(appended(FOLLOW, 5), FOLLOW, 'following has nothing unseen');
  assert.equal(maxTop(30, 10), 20);
  assert.equal(maxTop(3, 10), 0);
});

test('scrolling up pins the view; new rows are counted, not shown, and the indicator takes the last row', () => {
  let s = scrollBy(FOLLOW, -8, 30, 10);
  assert.deepEqual(s, { top: 12, unseen: 0 });
  assert.ok(!following(s));
  let v = view(rows(30), s, 10);
  assert.deepEqual(v.rows, rows(30).slice(12, 21), 'nine rows and the indicator');
  assert.equal(v.indicator, true);
  assert.equal(v.below, 9);
  s = appended(s, 4);
  assert.deepEqual(s, { top: 12, unseen: 4 }, 'the view does not move');
  v = view(rows(34), s, 10);
  assert.deepEqual(v.rows[0], 'r12');
  assert.equal(v.below, 13);
});

test('scrolling down to the bottom follows again; scrolling never passes the top', () => {
  const up = scrollBy(FOLLOW, -5, 30, 10);
  assert.equal(scrollBy(up, 5, 30, 10), FOLLOW);
  assert.equal(scrollBy(up, 500, 30, 10), FOLLOW);
  assert.deepEqual(scrollBy(up, -500, 30, 10), { top: 0, unseen: 0 });
  assert.equal(scrollBy(FOLLOW, -3, 5, 10), FOLLOW, 'nothing to scroll when everything fits');
  assert.deepEqual(scrollToTop(FOLLOW, 30, 10), { top: 0, unseen: 0 });
  assert.equal(scrollToTop(FOLLOW, 5, 10), FOLLOW);
});

test('a pinned top is clamped when the content shrinks, kept in proportion on re-wrap, and moved on trimming', () => {
  assert.equal(topOf({ top: 50, unseen: 0 }, 30, 10), 20);
  assert.deepEqual(rewrapped({ top: 10, unseen: 2 }, 40, 80), { top: 20, unseen: 2 });
  assert.equal(rewrapped(FOLLOW, 40, 80), FOLLOW);
  assert.deepEqual(trimmed({ top: 10, unseen: 0 }, 4), { top: 6, unseen: 0 });
  assert.deepEqual(trimmed({ top: 2, unseen: 0 }, 4), { top: 0, unseen: 0 });
  assert.equal(trimmed(FOLLOW, 4), FOLLOW);
  assert.deepEqual(view(rows(30), { top: 25, unseen: 0 }, 10), { rows: rows(30).slice(20), below: 0, indicator: false }, 'at the bottom: no indicator');
});
