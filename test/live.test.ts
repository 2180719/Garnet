// Opt-in smoke test against a real provider. Costs a few cents at most.
// Run: RUBY_LIVE_TESTS=1 ANTHROPIC_API_KEY=... npm test -- --test-name-pattern=live
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { createRuby } from '../src/main.ts';

const enabled = process.env.RUBY_LIVE_TESTS === '1';

test('live: a real model completes a tool-backed task', { skip: enabled ? false : 'set RUBY_LIVE_TESTS=1 to run' }, async () => {
  const home = tempDir();
  const ruby = createRuby({ home, approver: async () => 'approved' });
  try {
    const session = ruby.store.createSession('live');
    const task = await ruby.agent.run(session.id, 'Create a file named hello.txt containing exactly: ruby works. Then tell me you are done.');
    assert.equal(task.status, 'completed', task.reason ?? '');
    assert.equal(readFileSync(join(ruby.paths.workspace, 'hello.txt'), 'utf8').trim(), 'ruby works');
    assert.ok((task.usage.inputTokens ?? 0) > 0, 'usage was reported');
  } finally {
    ruby.close();
  }
});
