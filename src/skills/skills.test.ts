import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import type { ToolContext } from '../contracts/index.ts';
import { SkillStore, skillTools } from './index.ts';

function setup() {
  const root = tempDir();
  let t = Date.parse('2026-01-01T00:00:00Z');
  const clock = { advanceDays: (d: number) => (t += d * 86_400_000) };
  const store = new SkillStore({ root, now: () => new Date(t) });
  const file = (n: string, f = 'SKILL.md') => join(root, n, f);
  const read = (n: string, f = 'SKILL.md') => readFileSync(file(n, f), 'utf8');
  const meta = (n: string) => JSON.parse(read(n, '.ruby.json'));
  return { root, store, clock, file, read, meta };
}

const ctx: ToolContext = { sessionId: 's', callId: 'c', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal };

test('create, list and index are deterministic and sorted', () => {
  const { store, read, file } = setup();
  assert.match(store.index(), /none yet/);
  store.create('zeta', 'Last one', 'Step 1');
  store.create('alpha', 'First one', 'Step A');
  assert.deepEqual(store.list().map((s) => s.name), ['alpha', 'zeta']);
  const idx = store.index();
  assert.match(idx, /skill_view/);
  assert.match(idx, /- alpha: First one\n- zeta: Last one$/);
  store.view('alpha');
  assert.equal(store.index(), idx);
  assert.throws(() => store.create('alpha', 'dup', 'x'), /already exists/);
  assert.match(read('alpha'), /^---\nname: alpha\n/);
  assert.equal(statSync(file('alpha')).mode & 0o777, 0o600);
  assert.equal(statSync(join(file('alpha'), '..')).mode & 0o777, 0o700);
});

test('view increments uses without touching SKILL.md', () => {
  const { store, read, meta, clock } = setup();
  store.create('a', 'desc', 'Body text');
  const before = read('a');
  clock.advanceDays(1);
  const v = store.view('a');
  assert.equal(v.body.trim(), 'Body text');
  store.view('a');
  assert.equal(read('a'), before);
  assert.equal(meta('a').uses, 2);
  assert.equal(store.list()[0]!.uses, 2);
  assert.equal(store.list()[0]!.lastUsedAt, '2026-01-02T00:00:00.000Z');
});

test('agent update works while unlocked', () => {
  const { store, read } = setup();
  store.create('a', 'desc', 'v1');
  assert.deepEqual(store.update('a', { body: 'v2', description: 'new desc' }), { status: 'updated' });
  assert.match(read('a'), /v2/);
  assert.equal(store.list()[0]!.description, 'new desc');
  assert.equal(store.list()[0]!.locked, false);
});

test('owner hand-edit locks the skill; agent update becomes a proposal', () => {
  const { store, read, file } = setup();
  store.create('a', 'desc', 'v1');
  writeFileSync(file('a'), read('a').replace('v1', 'hand tuned'));
  assert.equal(store.list()[0]!.locked, true);
  const bytes = readFileSync(file('a'));
  assert.deepEqual(store.update('a', { body: 'agent idea' }), { status: 'proposed' });
  assert.ok(readFileSync(file('a')).equals(bytes));
  assert.match(store.proposal('a')!, /agent idea/);
  assert.equal(store.list()[0]!.hasProposal, true);
  // accept: owner content replaced; agent provenance becomes unlocked again
  store.acceptProposal('a');
  assert.match(read('a'), /agent idea/);
  assert.equal(store.proposal('a'), null);
  assert.equal(store.list()[0]!.locked, false);
});

test('reject discards the proposal and leaves the skill alone', () => {
  const { store, read, file } = setup();
  store.create('a', 'desc', 'v1');
  writeFileSync(file('a'), read('a') + '\nextra\n');
  const bytes = readFileSync(file('a'));
  store.update('a', { body: 'other' });
  store.rejectProposal('a');
  assert.equal(store.proposal('a'), null);
  assert.ok(readFileSync(file('a')).equals(bytes));
  assert.equal(store.list()[0]!.locked, true);
});

test('owner-dropped skill without sidecar is user provenance and locked; accept keeps it locked', () => {
  const { store, root, read, file } = setup();
  mkdirSync(join(root, 'mine'));
  writeFileSync(join(root, 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Hand made\n---\n\nDo it my way.\n');
  const [s] = store.list();
  assert.equal(s!.provenance, 'user');
  assert.equal(s!.locked, true);
  const bytes = readFileSync(file('mine'));
  assert.equal(store.update('mine', { body: 'agent way' }).status, 'proposed');
  assert.ok(readFileSync(file('mine')).equals(bytes));
  store.view('mine');
  assert.ok(readFileSync(file('mine')).equals(bytes));
  store.acceptProposal('mine');
  assert.match(read('mine'), /agent way/);
  assert.equal(store.list()[0]!.locked, true);
  assert.equal(store.update('mine', { body: 'again' }).status, 'proposed');
});

test('archive hides from list and index, never deletes; unarchive restores', () => {
  const { store, file } = setup();
  store.create('a', 'desc', 'x');
  store.archive('a');
  assert.equal(store.list().length, 0);
  assert.match(store.index(), /none yet/);
  assert.ok(existsSync(file('a')));
  store.unarchive('a');
  assert.equal(store.list().length, 1);
});

test('stale lists only agent skills unused beyond the cutoff', () => {
  const { store, clock, root } = setup();
  store.create('old', 'd', 'x');
  store.create('used', 'd', 'x');
  store.create('owner', 'd', 'x', 'user');
  clock.advanceDays(50);
  store.view('used');
  clock.advanceDays(20);
  assert.deepEqual(store.stale().map((s) => s.name), ['old']);
  assert.deepEqual(store.stale(10).map((s) => s.name), ['old', 'used']);
  assert.ok(existsSync(join(root, 'old', 'SKILL.md')));
});

test('names are validated against traversal and bad characters', () => {
  const { store, root } = setup();
  for (const n of ['../evil', 'Evil', 'a/b', '', '-x', 'a'.repeat(65)]) {
    assert.throws(() => store.create(n, 'd', 'b'), /Invalid skill name/);
    assert.throws(() => store.view(n), /Invalid skill name/);
  }
  assert.equal(existsSync(join(root, '..', 'evil')), false);
  assert.throws(() => store.create('ok', 'x'.repeat(301), 'b'), /description/);
  assert.throws(() => store.create('ok', 'd', 'b'.repeat(20_001)), /too long/);
  assert.throws(() => store.create('ok', 'two\nlines', 'b'), /description/);
});

test('malformed skills are skipped and reported', () => {
  const { store, root } = setup();
  store.create('good', 'fine', 'x');
  for (const [n, text] of [
    ['nofm', 'just markdown'],
    ['unterminated', '---\nname: unterminated\ndescription: x\n'],
    ['nodesc', '---\nname: nodesc\n---\nbody'],
    ['mismatch', '---\nname: other\ndescription: x\n---\nbody'],
    ['garbage', '---\nname: garbage\nthis is not a pair\n---\nbody'],
  ] as const) {
    mkdirSync(join(root, n));
    writeFileSync(join(root, n, 'SKILL.md'), text);
  }
  assert.deepEqual(store.list().map((s) => s.name), ['good']);
  assert.deepEqual(store.problems().map((p) => p.name).sort(), ['garbage', 'mismatch', 'nodesc', 'nofm', 'unterminated']);
});

test('quoted values parse and unknown frontmatter keys survive rewrites', () => {
  const { store, root, read, file } = setup();
  mkdirSync(join(root, 'q'));
  writeFileSync(
    join(root, 'q', 'SKILL.md'),
    '---\nname: "q"\ndescription: \'It\'\'s quoted\'\nlicense: MIT\nmetadata:\n  author: me\n  version: "1"\n---\n\nOriginal\n',
  );
  assert.equal(store.list()[0]!.description, "It's quoted");
  store.update('q', { body: 'Proposed body' });
  store.acceptProposal('q');
  const out = read('q');
  assert.match(out, /license: MIT\nmetadata:\n  author: me\n  version: "1"\n---/);
  assert.match(out, /Proposed body/);
  // and an agent-owned skill with extra keys keeps them on a direct update
  store.create('b', 'd', 'one');
  writeFileSync(file('b'), read('b').replace('---\n\n', 'x-custom: keep me\n---\n\n'));
  store.update('b', { body: 'two' });
  store.acceptProposal('b');
  assert.match(read('b'), /x-custom: keep me/);
});

test('tools validate input and run end to end', async () => {
  const { store, read, file } = setup();
  const [view, create, update] = skillTools(store) as [any, any, any];
  assert.deepEqual([view.capability, create.capability, update.capability], ['fs.read', 'memory.write', 'memory.write']);
  assert.deepEqual([view.idempotent, create.idempotent, update.idempotent], [true, false, false]);
  assert.equal(create.input.safeParse({ name: 'x', description: '', body: 'b' }).success, false);
  assert.equal(create.input.safeParse({ name: 'x', description: 'd', body: 'b'.repeat(20_001) }).success, false);
  assert.equal(view.input.safeParse({}).success, false);

  const c = await create.run(create.input.parse({ name: 'deploy', description: 'Deploy it', body: '1. build' }), ctx);
  assert.match(c.content, /created/);
  const v = await view.run({ name: 'deploy' }, ctx);
  assert.match(v.content, /1\. build/);
  const u = await update.run(update.input.parse({ name: 'deploy', body: '1. build\n2. ship' }), ctx);
  assert.match(u.content, /updated/);

  writeFileSync(file('deploy'), read('deploy') + '\nOwner note\n');
  const p = await update.run({ name: 'deploy', body: 'rewrite' }, ctx);
  assert.match(p.content, /edited by your owner, so your change was saved as a proposal/);
  assert.doesNotMatch(read('deploy'), /rewrite/);
  await assert.rejects(() => view.run({ name: 'missing' }, ctx), /No skill named/);
  await assert.rejects(() => create.run({ name: 'deploy', description: 'd', body: 'b' }, ctx), /already exists/);
});
