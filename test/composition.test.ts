// The composition root's own safety checks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { isRubyError } from '../src/contracts/index.ts';
import { createRuby } from '../src/main.ts';

const withWorkspace = (workspace: string) => {
  const home = join(tempDir(), 'ruby-home');
  const parent = dirname(home);
  return { home, parent, config: { version: 1, workspace: workspace.replace('{home}', home).replace('{parent}', parent) } };
};

test('a workspace that contains Ruby’s home is refused: tools could rewrite config, secrets or skills', () => {
  for (const ws of ['{home}', '{parent}', '.', '..']) {
    const { home, config } = withWorkspace(ws);
    createRuby({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    assert.throws(() => createRuby({ home, memoryDb: true, noModel: true }), (e) => isRubyError(e, 'config') && /workspace/.test(e.message), ws);
  }
});

test('a workspace beside or below home is fine', () => {
  for (const ws of ['workspace', '{parent}/elsewhere', '{home}/deep/work']) {
    const { home, config } = withWorkspace(ws);
    createRuby({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    createRuby({ home, memoryDb: true, noModel: true }).close();
  }
});
