import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { BUILTIN_SKILLS } from '../config/index.ts';
import { isGarnetError, type ToolContext } from '../contracts/index.ts';
import { BUILTIN_SKILLS_DIR, BuiltinSkills, SkillStore, skillTools } from './index.ts';

const ctx = (sessionId = 's1'): ToolContext => ({ sessionId, callId: 'c', workspace: '/tmp', memoryNamespace: 'default', signal: new AbortController().signal });

test('the shipped skills load, are valid agentskills.io files, and match the names config accepts', () => {
  const skills = new BuiltinSkills();
  assert.deepEqual(skills.list().map((s) => s.name), [...BUILTIN_SKILLS]);
  assert.deepEqual(readdirSync(BUILTIN_SKILLS_DIR).sort(), [...BUILTIN_SKILLS]);
  for (const s of skills.list()) {
    assert.ok(s.description.length > 20 && s.description.length <= 300, s.name);
    assert.ok(s.body.startsWith('# '), `${s.name} has a title`);
    const raw = readFileSync(join(BUILTIN_SKILLS_DIR, s.name, 'SKILL.md'), 'utf8');
    assert.ok(raw.startsWith(`---\nname: ${s.name}\n`), `${s.name} frontmatter`);
    assert.ok(!raw.includes('—'), `${s.name} has no em-dashes`);
    // Each one treats outside content as data.
    assert.match(s.body, /untrusted/i, s.name);
  }
});

test('index lists only the active, shipped and unshadowed skills, deterministically', () => {
  const skills = new BuiltinSkills();
  assert.equal(skills.index([]), '');
  assert.equal(skills.index(['nope']), '');
  const text = skills.index(['web-research', 'daily-briefing']);
  assert.match(text, /^Built-in skills/);
  assert.ok(text.indexOf('- daily-briefing:') < text.indexOf('- web-research:'), 'sorted');
  assert.ok(!text.includes('github-triage'));
  assert.equal(text, skills.index(['daily-briefing', 'web-research']));
  assert.ok(!skills.index(['web-research'], (n) => n === 'web-research').includes('web-research'), 'a local skill of the same name wins');
});

test('a broken shipped skill is an install error, not silently skipped', () => {
  const root = tempDir();
  mkdirSync(join(root, 'bad'));
  writeFileSync(join(root, 'bad', 'SKILL.md'), '---\nname: other\ndescription: x\n---\nbody');
  assert.throws(() => new BuiltinSkills(root), (e) => isGarnetError(e, 'internal') && /frontmatter name/.test(e.message));
  assert.deepEqual(new BuiltinSkills(join(root, 'missing')).list(), []);
});

test('skill_view serves a built-in only when it is active in the session, and a local skill always wins', async () => {
  const store = new SkillStore({ root: tempDir() });
  const builtins = new BuiltinSkills();
  const active = new Map([['s1', ['web-research', 'daily-briefing']]]);
  const [view] = skillTools(store, { builtin: (name, sessionId) => (active.get(sessionId)?.includes(name) ? builtins.get(name) : undefined) });
  const out = await view!.run({ name: 'web-research' }, ctx('s1'));
  assert.match(out.content, /^# Skill: web-research \(built in\)/);
  assert.match(out.content, /web_search/);
  await assert.rejects(view!.run({ name: 'web-research' }, ctx('s2')), /No skill named "web-research"/, 'not active in another session');
  await assert.rejects(view!.run({ name: 'github-triage' }, ctx('s1')), /No skill named/, 'shipped but not enabled');
  const file = await view!.run({ name: 'web-research', file: 'references/x.md' }, ctx('s1'));
  assert.equal(file.error, 'invalid_input');

  store.create('daily-briefing', 'My own morning routine.', '1. Coffee first.', 'user');
  const local = await view!.run({ name: 'daily-briefing' }, ctx('s1'));
  assert.match(local.content, /Coffee first/);
  assert.ok(store.has('daily-briefing') && !store.has('web-research') && !store.has('../x'));
});
