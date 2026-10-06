import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localToUtc, parseConfig, type JobConfig } from '../config/index.ts';
import { isRubyError } from '../contracts/index.ts';
import { describeDistance, describeNext, describeSchedule, describeTime, nextRunOf, parseWhen } from './index.ts';

const LONDON = 'Europe/London';
// Tuesday 6 October 2026, 16:20 in London (BST, UTC+1).
const now = new Date('2026-10-06T15:20:00Z');
const at = (text: string, zone = LONDON, when = now) => {
  const w = parseWhen(text, { now: when, zone });
  assert.equal(w.kind, 'once', text);
  return (w as { at: Date }).at.toISOString();
};
const job = (over: object): JobConfig => parseConfig({ version: 1, jobs: [{ id: 'j', kind: 'cron', cron: '0 9 * * *', message: 'x', ...over }] }).jobs[0]!;

test('relative and wall-clock one-shot times are read in the owner zone', () => {
  assert.equal(at('in 20 minutes'), '2026-10-06T15:40:00.000Z');
  assert.equal(at('in 1h30m'), '2026-10-06T16:50:00.000Z');
  assert.equal(at('in an hour'), '2026-10-06T16:20:00.000Z');
  assert.equal(at('in half an hour'), '2026-10-06T15:50:00.000Z');
  assert.equal(at('in 2 days'), '2026-10-08T15:20:00.000Z');
  assert.equal(at('at 17:30'), '2026-10-06T16:30:00.000Z');
  assert.equal(at('5pm'), '2026-10-06T16:00:00.000Z');
  assert.equal(at('9:15pm'), '2026-10-06T20:15:00.000Z');
  assert.equal(at('tomorrow at 9am'), '2026-10-07T08:00:00.000Z');
  assert.equal(at('tomorrow 8:30'), '2026-10-07T07:30:00.000Z');
  assert.equal(at('friday 18:00'), '2026-10-09T17:00:00.000Z');
  assert.equal(at('next tuesday at 9'), '2026-10-13T08:00:00.000Z');
  assert.equal(at('2026-12-24 09:00'), '2026-12-24T09:00:00.000Z', 'GMT in winter');
  assert.equal(at('2026-12-24T09:00:00Z'), '2026-12-24T09:00:00.000Z');
  assert.equal(at('2026-10-06T23:00+02:00'), '2026-10-06T21:00:00.000Z', 'an explicit offset wins');
  assert.equal(at('at 9am', 'America/New_York'), '2026-10-07T13:00:00.000Z', 'another zone');
});

test('a bare time that already passed means tomorrow; "today" in the past is an error', () => {
  assert.equal(at('10am'), '2026-10-07T09:00:00.000Z');
  assert.equal(at('tuesday at 9'), '2026-10-13T08:00:00.000Z', 'this weekday, already past: next week');
  assert.throws(() => parseWhen('today at 9am', { now, zone: LONDON }), (e) => isRubyError(e, 'invalid_input') && /already in the past/.test(e.message));
});

test('recurring schedules become cron in the owner zone or intervals', () => {
  const w = (t: string) => parseWhen(t, { now, zone: LONDON });
  assert.deepEqual(w('every day at 8am'), { kind: 'cron', cron: '0 8 * * *' });
  assert.deepEqual(w('daily at 7'), { kind: 'cron', cron: '0 7 * * *' });
  assert.deepEqual(w('weekdays at 9:15'), { kind: 'cron', cron: '15 9 * * 1-5' });
  assert.deepEqual(w('every mon, wed and fri at 6pm'), { kind: 'cron', cron: '0 18 * * 1,3,5' });
  assert.deepEqual(w('every monday 9am'), { kind: 'cron', cron: '0 9 * * 1' });
  assert.deepEqual(w('0 9 * * 1-5'), { kind: 'cron', cron: '0 9 * * 1-5' });
  assert.deepEqual(w('every 30 minutes'), { kind: 'heartbeat', everyMinutes: 30 });
  assert.deepEqual(w('every 2 hours'), { kind: 'heartbeat', everyMinutes: 120 });
  assert.deepEqual(w('hourly'), { kind: 'heartbeat', everyMinutes: 60 });
});

test('unclear or too frequent schedules are refused with examples', () => {
  for (const [text, why] of [
    ['every day', /what time of day/],
    ['tomorrow', /Say what time/],
    ['every 2 minutes', /at most every 5 minutes/],
    ['whenever', /could not read/],
    ['61 9 * * *', /not valid/],
    ['2026-02-30 09:00', /does not exist/],
  ] as const) {
    assert.throws(() => parseWhen(text, { now, zone: LONDON }), (e) => isRubyError(e, 'invalid_input') && why.test(e.message) && (/every weekday/.test(e.message) || /cron/.test(e.message)), text);
  }
});

test('DST: a local time skipped by spring-forward moves forward; a repeated one picks the first instance', () => {
  // London springs forward at 01:00 GMT on 29 March 2026: 01:30 local does not exist.
  const spring = parseWhen('2027-03-28 01:30', { now, zone: LONDON });
  assert.equal(spring.kind === 'once' && spring.shifted, true);
  assert.equal(spring.kind === 'once' && spring.at.toISOString(), '2027-03-28T01:30:00.000Z', '02:30 BST');
  // It falls back at 02:00 BST on 25 October 2026: 01:30 local happens twice.
  assert.equal(at('2026-10-25 01:30'), '2026-10-25T00:30:00.000Z', 'the first (BST) instance');
  assert.deepEqual(localToUtc({ year: 2026, month: 10, day: 25, hour: 3, minute: 0 }, LONDON), { at: new Date('2026-10-25T03:00:00Z'), shifted: false });
  // "tomorrow at 9am" across the change still means 9am on the wall clock.
  assert.equal(at('tomorrow at 9am', LONDON, new Date('2026-10-24T12:00:00Z')), '2026-10-25T09:00:00.000Z');
  // A daily cron job keeps its wall-clock time across the change.
  const daily = job({ cron: '0 9 * * *', timezone: LONDON });
  assert.equal(nextRunOf(daily, null, new Date('2026-10-24T09:00:00Z'), LONDON)?.toISOString(), '2026-10-25T09:00:00.000Z');
  assert.equal(nextRunOf(daily, null, new Date('2026-10-24T07:00:00Z'), LONDON)?.toISOString(), '2026-10-24T08:00:00.000Z');
});

test('plain-language descriptions in the owner zone', () => {
  assert.equal(describeTime(new Date('2026-10-06T16:00:00Z'), LONDON, now), 'today at 17:00');
  assert.equal(describeTime(new Date('2026-10-07T08:00:00Z'), LONDON, now), 'tomorrow at 09:00');
  assert.equal(describeTime(new Date('2026-10-09T17:00:00Z'), LONDON, now), 'Fri 9 Oct at 18:00');
  assert.equal(describeTime(new Date('2027-01-02T09:00:00Z'), LONDON, now), 'Sat 2 Jan 2027 at 09:00');
  assert.equal(describeDistance(new Date('2026-10-06T18:25:00Z'), now), 'in 3 h 5 min');
  assert.equal(describeNext(new Date('2026-10-06T15:25:00Z'), LONDON, now), 'today at 16:25 (Europe/London, in 5 min)');
  assert.equal(describeSchedule(job({ cron: '15 9 * * 1-5' }), LONDON, now), 'every weekday at 09:15');
  assert.equal(describeSchedule(job({ cron: '0 19 * * 1,4' }), LONDON, now), 'every Mon and Thu at 19:00');
  assert.equal(describeSchedule(job({ cron: '*/10 9-17 * * *' }), LONDON, now), 'cron "*/10 9-17 * * *"');
  assert.equal(describeSchedule(job({ kind: 'heartbeat', cron: undefined, everyMinutes: 90 }), LONDON, now), 'every 90 minutes');
  assert.equal(describeSchedule(job({ kind: 'once', cron: undefined, at: '2026-10-07T08:00:00Z' }), LONDON, now), 'once, tomorrow at 09:00');
});

test('next run: once jobs that ran have none', () => {
  const once = job({ kind: 'once', cron: undefined, at: '2026-10-07T08:00:00Z' });
  assert.equal(nextRunOf(once, '2026-10-06T00:00:00Z', now, LONDON)?.toISOString(), '2026-10-07T08:00:00.000Z');
  assert.equal(nextRunOf(once, '2026-10-07T08:00:00.000Z', now, LONDON), null);
});
