// CLI argument handling for the owner commands (memory, skills, flags).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempDir } from './helpers.ts';
import { main } from '../src/cli/main.ts';
import { MemoryStore } from '../src/memory/index.ts';

const home = tempDir();
const saved = { home: process.env.RUBY_HOME, editor: process.env.EDITOR, visual: process.env.VISUAL };
process.env.RUBY_HOME = home;
after(() => {
  for (const [k, v] of [['RUBY_HOME', saved.home], ['EDITOR', saved.editor], ['VISUAL', saved.visual]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function run(...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

test('memory rollback takes the id even when --ns comes last', async () => {
  let t = Date.parse('2026-10-06T10:00:00Z');
  const store = new MemoryStore({ root: join(home, 'memory'), now: () => new Date((t += 1000)) });
  store.add('work', 'memory', 'first');
  store.add('work', 'memory', 'second');
  const id = store.history('work', 'memory')[0]!.id;
  const r = await run('memory', 'rollback', 'memory', id, '--ns', 'work');
  assert.equal(r.code, 0, r.err);
  assert.equal(store.read('work', 'memory'), '- first');
});

test('memory edit runs $EDITOR with its arguments', async () => {
  const script = join(tempDir(), 'ed.sh');
  writeFileSync(script, '#!/bin/sh\n[ "$1" = "--wait" ] || exit 3\nprintf -- "- edited by %s\\n" "$1" > "$2"\n');
  chmodSync(script, 0o755);
  delete process.env.VISUAL;
  process.env.EDITOR = `${script} --wait`;
  const r = await run('memory', 'edit', 'user');
  assert.equal(r.code, 0, r.err);
  assert.equal(new MemoryStore({ root: join(home, 'memory') }).read('default', 'user'), '- edited by --wait');
});

test('bad flags are a usage error (exit 2), not an unexpected error', async () => {
  const r = await run('doctor', '--bogus');
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.err, /Unexpected error/);
  assert.match(r.err, /--bogus/);
});

test('skills stale rejects a non-number', async () => {
  const r = await run('skills', 'stale', 'soon');
  assert.equal(r.code, 2);
});

test('backup and restore round-trip the database, config, memory, skills, artifacts and workspace', async () => {
  const mem = new MemoryStore({ root: join(home, 'memory') });
  mem.write('default', 'memory', '- backed up fact');
  mkdirSync(join(home, 'workspace'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'notes.md'), 'workspace file');
  mkdirSync(join(home, 'artifacts'), { recursive: true });
  writeFileSync(join(home, 'artifacts', 'art_1.txt'), 'large tool output');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, persona: 'Backed up.' }));
  const target = join(tempDir(), 'bk');
  const b = await run('backup', target);
  assert.equal(b.code, 0, b.err);
  for (const name of ['ruby.db', 'config.json', 'memory', 'workspace', 'artifacts', 'BACKUP.json']) assert.ok(existsSync(join(target, name)), name);

  mem.write('default', 'memory', '- changed after the backup');
  writeFileSync(join(home, 'artifacts', 'art_1.txt'), 'changed');
  const r = await run('restore', target);
  assert.equal(r.code, 0, r.err);
  assert.equal(mem.read('default', 'memory'), '- backed up fact');
  assert.equal(readFileSync(join(home, 'artifacts', 'art_1.txt'), 'utf8'), 'large tool output');
  assert.equal(readFileSync(join(home, 'workspace', 'notes.md'), 'utf8'), 'workspace file');
  const aside = readdirSync(home).find((n) => n.startsWith('pre-restore-'))!;
  assert.equal(readFileSync(join(home, aside, 'artifacts', 'art_1.txt'), 'utf8'), 'changed', 'the replaced data is moved aside, not deleted');
});
