import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VirtualTerminal } from '../../../test/vt.ts';
import { FULLSCREEN_OFF, FullScreen } from './fullscreen.ts';

function surface() {
  const vt = new VirtualTerminal(30, 6);
  let raw = '';
  const out = { columns: 30, rows: 6, write: (s: string) => ((raw += s), vt.write(s), true) };
  return { vt, s: new FullScreen(out), raw: () => raw, reset: () => (raw = '') };
}

test('frames are drawn on the alternate screen, rewriting only rows that changed', () => {
  const { vt, s, raw, reset } = surface();
  vt.write('shell prompt$ ');
  s.enter(true);
  assert.ok(vt.alternate && vt.modes.has(1000) && vt.modes.has(1006));
  s.draw(['header', 'a', 'b', '', 'input', 'footer'], { row: 4, col: 2 });
  assert.deepEqual(vt.screen(), ['header', 'a', 'b', '', 'input', 'footer']);
  assert.deepEqual(vt.cursor, { row: 4, col: 2 });
  reset();
  s.draw(['header', 'a', 'c', '', 'input', 'footer'], null);
  assert.equal(vt.screen()[2], 'c');
  assert.ok(!raw().includes('header') && raw().includes('\x1b[3;1Hc'), 'only the changed row is written');
  assert.ok(!vt.cursorVisible, 'a null cursor is hidden');
  s.setMouse(false);
  assert.ok(!vt.modes.has(1000));
  s.leave();
  assert.ok(!vt.alternate, 'back on the normal screen');
  assert.ok(vt.cursorVisible);
  assert.equal(vt.text(), 'shell prompt$', 'the normal screen is as it was');
  reset();
  s.leave();
  s.draw(['x'], null);
  assert.equal(raw(), '', 'nothing is written once left');
  assert.equal(FULLSCREEN_OFF, '\x1b[?1006l\x1b[?1000l\x1b[?1049l');
});
