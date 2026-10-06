import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, regions } from './layout.ts';

const header = { full: ['H1', 'H2', '──'], compact: ['h'] };

test('regions: the header shrinks before the transcript does, and the dock keeps at most half the screen', () => {
  assert.deepEqual(regions(30, 3, 3), { header: 3, body: 24, dock: 3 });
  assert.deepEqual(regions(10, 3, 3), { header: 1, body: 6, dock: 3 }, 'short: the compact header');
  assert.deepEqual(regions(5, 3, 3), { header: 1, body: 2, dock: 2 }, 'tiny: the dock is cut to half');
  assert.deepEqual(regions(3, 3, 3), { header: 0, body: 2, dock: 1 });
  assert.deepEqual(regions(30, 40, 3), { header: 3, body: 12, dock: 15 }, 'a long draft cannot push the transcript off');
});

test('compose: header, body padded to its height, dock; the cursor is mapped onto the screen', () => {
  const heights: number[] = [];
  const f = compose({
    height: 12,
    header,
    dock: ['──', '› hi', '  footer'],
    cursor: { row: 1, col: 4 },
    body: (h) => (heights.push(h), ['a', 'b']),
  });
  assert.deepEqual(heights, [6]);
  assert.deepEqual(f.rows, ['H1', 'H2', '──', 'a', 'b', '', '', '', '', '──', '› hi', '  footer']);
  assert.deepEqual(f.cursor, { row: 10, col: 4 });
  assert.equal(f.body, 6);
});

test('compose: a cut dock keeps its bottom; a cursor cut off is hidden', () => {
  const dock = ['──', 'line 1', 'line 2', 'line 3', 'line 4', 'footer'];
  const f = compose({ height: 8, header, dock, cursor: { row: 1, col: 2 }, body: () => ['x'] });
  assert.equal(f.rows.length, 8);
  assert.deepEqual(f.rows.slice(-4), ['line 2', 'line 3', 'line 4', 'footer']);
  assert.equal(f.cursor, null);
  const g = compose({ height: 8, header, dock, cursor: { row: 4, col: 2 }, body: () => ['x'] });
  assert.deepEqual(g.cursor, { row: 6, col: 2 });
  assert.equal(g.rows[g.cursor!.row], 'line 4');
});
