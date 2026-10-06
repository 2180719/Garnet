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

test('a short (spring-forward) day does not make the day skip overshoot the next midnight', () => {
  // 2026-03-08 is 23 hours long in New York; Monday 00:30 must still be found on 2026-03-09.
  assert.equal(next('30 0 * * 1', '2026-03-02T12:00:00Z', 'America/New_York'), '2026-03-09T04:30:00.000Z');
  // London springs forward on 2026-03-29 (Sunday).
  assert.equal(next('30 0 * * 1', '2026-03-23T12:00:00Z', 'Europe/London'), '2026-03-29T23:30:00.000Z');
  // Lord Howe springs forward by 30 minutes on 2026-10-04 (Sunday).
  assert.equal(next('15 0 * * 1', '2026-09-28T12:00:00Z', 'Australia/Lord_Howe'), '2026-10-04T13:15:00.000Z');
  // A skipped wall time still never matches.
  assert.equal(next('15 2 * * *', '2026-10-03T16:00:00Z', 'Australia/Lord_Howe'), '2026-10-04T15:15:00.000Z');
  assert.equal(next('30 1 * * *', '2026-03-28T12:00:00Z', 'Europe/London'), '2026-03-30T00:30:00.000Z');
});

test('a repeated (fall-back) wall-clock minute fires once, at its first instance', () => {
  // New York 2026-11-01: 01:30 occurs at 05:30Z (EDT) and again at 06:30Z (EST).
  assert.equal(next('30 1 * * *', '2026-11-01T00:00:00Z', 'America/New_York'), '2026-11-01T05:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z');
  // Starting between the two instances does not pick up the repeat either.
  assert.equal(next('30 1 * * *', '2026-11-01T06:00:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z');
  // London 2026-10-25: 01:30 occurs at 00:30Z (BST) and 01:30Z (GMT).
  assert.equal(next('30 1 * * *', '2026-10-25T00:30:00Z', 'Europe/London'), '2026-10-26T01:30:00.000Z');
  // Lord Howe 2026-04-05 falls back 30 minutes: 01:45 occurs at 14:45Z (+11) and 15:15Z (+10:30).
  assert.equal(next('45 1 * * *', '2026-04-04T14:00:00Z', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z');
  assert.equal(next('45 1 * * *', '2026-04-04T14:45:00Z', 'Australia/Lord_Howe'), '2026-04-05T15:15:00.000Z');
  // Jobs with a wildcard hour keep running on elapsed time through the repeated hour (as in cronie).
  assert.equal(next('30 * * * *', '2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-01T06:30:00.000Z');
});
