import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRun, parseCron, validTimeZone } from './cron.ts';

const next = (expr: string, after: string, tz = 'UTC') => nextRun(parseCron(expr), new Date(after), tz)?.toISOString();

test('parses fields, names, ranges, steps and aliases', () => {
  const c = parseCron('*/15 9-17 * jan-mar mon-fri');
  assert.deepEqual([...c.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...c.months], [1, 2, 3]);
  assert.deepEqual([...c.weekdays].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0]);
  assert.equal(next('@daily', '2026-03-01T10:00:00Z'), '2026-03-02T00:00:00.000Z');
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('60 * * * *'), /out of range/);
});

test('computes next runs, strictly after the given time', () => {
  assert.equal(next('30 8 * * *', '2026-10-05T08:30:00Z'), '2026-10-06T08:30:00.000Z');
  assert.equal(next('0 9 * * mon', '2026-10-05T09:00:00Z'), '2026-10-12T09:00:00.000Z'); // 2026-10-05 is a Monday
  assert.equal(next('0 0 29 2 *', '2026-03-01T00:00:00Z'), undefined, 'no Feb 29 within a year of 2026-03');
  assert.equal(next('0 12 1 * 1', '2026-10-05T13:00:00Z'), '2026-10-12T12:00:00.000Z', 'dom OR dow when both restricted');
});

test('evaluates in the job time zone, across DST', () => {
  assert.equal(next('0 9 * * *', '2026-07-01T00:00:00Z', 'America/New_York'), '2026-07-01T13:00:00.000Z');
  assert.equal(next('0 9 * * *', '2026-12-01T00:00:00Z', 'America/New_York'), '2026-12-01T14:00:00.000Z');
  // 2026-03-08 02:30 does not exist in New York; the next match is the following day.
  assert.equal(next('30 2 * * *', '2026-03-08T00:00:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z');
  assert.ok(validTimeZone('Europe/Berlin'));
  assert.ok(!validTimeZone('Mars/Olympus'));
});
