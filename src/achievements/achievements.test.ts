import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../store/index.ts';
import { Achievements, type Stats } from './index.ts';

const zero: Stats = { tasksCompleted: 0, toolCalls: 0, agentSkills: 0, memoryChars: 0, channelsPaired: 0, approvalsDecided: 0, jobRuns: 0, quietHeartbeats: 0, uptimeDays: 0, lateNightTasks: 0, compactions: 0, apiKeys: 0 };

test('achievements unlock once, hidden ones stay secret, earned ones cannot be forced', () => {
  const a = new Achievements(openDb(':memory:'));
  let list = a.evaluate(zero);
  assert.ok(list.every((x) => x.unlockedAt === null));
  assert.equal(list.find((x) => x.id === 'night-owl')?.title, '???');
  list = a.evaluate({ ...zero, tasksCompleted: 1, lateNightTasks: 1 });
  const hello = list.find((x) => x.id === 'hello-garnet')!;
  assert.ok(hello.unlockedAt);
  assert.equal(list.find((x) => x.id === 'night-owl')?.title, 'Night Owl');
  assert.equal(a.evaluate({ ...zero, tasksCompleted: 5 }).find((x) => x.id === 'hello-garnet')?.unlockedAt, hello.unlockedAt, 'first unlock date is kept');
  assert.equal(a.unlockEasterEgg('regular'), false);
  assert.equal(a.unlockEasterEgg('konami'), true);
  assert.equal(a.unlockEasterEgg('konami'), false, 'already unlocked');
});
