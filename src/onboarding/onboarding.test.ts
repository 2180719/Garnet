import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { loadConfig, readPersona, writeConfig, defaultConfig } from '../config/index.ts';
import type { SessionEvent, ToolContext } from '../contracts/index.ts';
import { MAX_OWNER_REPLIES, OnboardingWatch, applyProfile, profileTool } from './index.ts';

test('applyProfile keeps hand-written persona text and fields it was not given', () => {
  const home = tempDir();
  const config = defaultConfig();
  config.persona = 'Speak like a pirate.';
  writeConfig(home, config);
  applyProfile(home, { name: 'Ruby', owner: 'Sam', notes: 'Brief.' });
  applyProfile(home, { timezone: 'Europe/Lisbon' });
  applyProfile(home, { notes: 'Brief, no em-dashes.' });
  const c = loadConfig(home).config;
  assert.deepEqual(readPersona(c.persona), { name: 'Ruby', owner: 'Sam', notes: 'Brief, no em-dashes.' });
  assert.ok(c.persona!.endsWith('Speak like a pirate.'));
  assert.equal(c.timezone, 'Europe/Lisbon');
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).version, c.version);
});

test('applyProfile rejects bad input without writing anything', () => {
  const home = tempDir();
  writeConfig(home, defaultConfig());
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  for (const bad of [{ name: 'two\nlines' }, { owner: 'x <!-- y' }, { notes: 'z'.repeat(501) }, { timezone: 'Mars/Base' }]) {
    assert.throws(() => applyProfile(home, bad), /invalid|time zone|single line|HTML|Keep it/i);
  }
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
});

test('applyProfile: a whitespace-only owner name is rejected and does not clear the stored owner', () => {
  const home = tempDir();
  writeConfig(home, defaultConfig());
  applyProfile(home, { name: 'Ruby', owner: 'Sam' });
  for (const bad of ['  ', ' ', 'Sam Evil', 'a\u0085b']) {
    assert.throws(() => applyProfile(home, { owner: bad }), /single line|control|only spaces/i, JSON.stringify(bad));
  }
  assert.equal(readPersona(loadConfig(home).config.persona).owner, 'Sam');
});

test('set_profile: needs the memory.write permission and summarizes what it saves', async () => {
  const home = tempDir();
  const tool = profileTool(home);
  assert.equal(tool.capability, 'memory.write');
  const result = await tool.run({ assistant_name: 'Ruby', owner_name: 'Sam' }, {} as ToolContext);
  assert.match(result.content, /Saved profile \(name Ruby, owner Sam\)/);
  assert.match(tool.summarize!({ assistant_name: 'Ruby', timezone: 'Europe/Lisbon' }, {} as ToolContext), /assistant name "Ruby", time zone Europe\/Lisbon/);
});

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, at: '2026-10-06T12:00:00Z', sessionId: 's', ...e }) as unknown as SessionEvent;
const user = () => ev({ type: 'user_message', message: { role: 'user', content: [{ type: 'text', text: 'x' }] }, source: 'cli' });
const call = (id: string, name: string) => ev({ type: 'tool_started', call: { type: 'tool_call', id, name, input: {} }, operationId: id });
const done = (id: string, status: 'ok' | 'error') => ev({ type: 'tool_finished', callId: id, operationId: id, result: { status, content: '', ...(status === 'error' ? { category: 'invalid_input' } : {}) } });

test('OnboardingWatch: verified after a successful set_profile, and says so once', () => {
  const events = [user(), call('1', 'set_profile'), done('1', 'ok'), call('2', 'memory'), done('2', 'ok')];
  const w = new OnboardingWatch(() => events);
  const first = w.afterTurn('completed');
  assert.equal(first.next, 'continue');
  assert.match((first as { note?: string }).note ?? '', /set_profile, memory/);
  assert.equal((w.afterTurn('completed') as { note?: string }).note, undefined);
  assert.equal(w.state, 'verified');
});

test('OnboardingWatch: failures count per turn and only for set_profile and memory', () => {
  // A bad time zone and a failing memory call in the same reply are one strike.
  const oneReply = [user(), user(), call('1', 'set_profile'), done('1', 'error'), call('2', 'memory'), done('2', 'error'), call('3', 'set_profile'), done('3', 'error')];
  assert.equal(new OnboardingWatch(() => oneReply).afterTurn('completed').next, 'continue');
  // Other tools failing (a denied command, say) never count.
  const other = [user(), user(), call('1', 'run_command'), done('1', 'error'), user(), call('2', 'read_file'), done('2', 'error')];
  assert.equal(new OnboardingWatch(() => other).afterTurn('completed').next, 'continue');
});

test('OnboardingWatch: a successful memory call also passes the tool check, without claiming a profile was saved', () => {
  const events = [user(), user(), call('1', 'set_profile'), done('1', 'error'), call('2', 'memory'), done('2', 'ok')];
  const v = new OnboardingWatch(() => events).afterTurn('completed');
  assert.equal(v.next, 'continue');
  assert.match((v as { note?: string }).note ?? '', /Tool check passed.*\(memory\); it has not called set_profile yet/);
});

test('OnboardingWatch: gives up on failures, failed turns, a spent budget and endless chatter, and never recovers', () => {
  const failing = [user(), user(), call('1', 'set_profile'), done('1', 'error'), user(), call('2', 'memory'), done('2', 'error')];
  assert.deepEqual(new OnboardingWatch(() => failing).afterTurn('completed'), { next: 'fallback', reason: 'saving kept failing' });

  const w = new OnboardingWatch(() => [user()]);
  assert.equal(w.afterTurn('failed').next, 'continue');
  assert.equal(w.afterTurn('failed').next, 'fallback');
  assert.equal(w.afterTurn('completed').next, 'fallback', 'once fallen back, always fallen back');

  assert.equal(new OnboardingWatch(() => [user()]).afterTurn('budget_exhausted').next, 'fallback');

  const chatter = Array.from({ length: MAX_OWNER_REPLIES + 1 }, user);
  assert.equal(new OnboardingWatch(() => chatter.slice(0, MAX_OWNER_REPLIES)).afterTurn('completed').next, 'continue', 'kickoff is not an answer');
  assert.equal(new OnboardingWatch(() => chatter).afterTurn('completed').next, 'fallback');

  // A turn that completes between failures resets the failed-turn count.
  const flaky = new OnboardingWatch(() => [user()]);
  assert.equal(flaky.afterTurn('failed').next, 'continue');
  assert.equal(flaky.afterTurn('completed').next, 'continue');
  assert.equal(flaky.afterTurn('failed').next, 'continue');
});
