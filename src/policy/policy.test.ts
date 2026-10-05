import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import { Policy, resolveInWorkspace } from './index.ts';

test('paths cannot escape the workspace', () => {
  const root = tempDir();
  const ws = join(root, 'ws');
  mkdirSync(ws);
  symlinkSync(root, join(ws, 'link'));
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), join(ws, 'a/b.txt'));
  assert.throws(() => resolveInWorkspace(ws, '../x'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, 'link/escape.txt'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, 'link/new/dir/file.txt'), /outside the workspace/);
});

test('intersection grants the stricter permission', () => {
  const owner = new Policy(defaultConfig().permissions); // fs.write: ask
  const job = new Policy({ ...defaultConfig().permissions, 'fs.write': 'allow', 'fs.read': 'deny' });
  const effective = owner.intersect(job);
  assert.equal(effective.check('fs.write').verdict, 'ask');
  assert.equal(effective.check('fs.read').verdict, 'deny');
});
