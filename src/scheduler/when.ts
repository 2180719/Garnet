// Natural schedules ("every weekday at 9am", "in 20 minutes", "tomorrow 8:30",
// cron) and plain-language descriptions of them, in the owner's time zone.
import { localToUtc, nextRun, parseCron, zonedParts, type JobConfig } from '../config/index.ts';
import { RubyError } from '../contracts/index.ts';

export type When =
  | { kind: 'cron'; cron: string }
  | { kind: 'heartbeat'; everyMinutes: number }
  /** `shifted`: the local time did not exist (DST gap) and was moved forward. */
  | { kind: 'once'; at: Date; shifted: boolean };

export const WHEN_HELP =
  'Use "in 20 minutes", "at 17:30", "tomorrow at 9am", "friday 18:00", "2026-12-24 09:00", "every 30 minutes", "every day at 8am", "every weekday at 9:15", "every mon,thu at 19:00", or a 5-field cron expression like "0 9 * * 1-5".';

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10_080 };

const bad = (text: string, why = 'I could not read that time.'): RubyError => new RubyError('invalid_input', `"${text}": ${why} ${WHEN_HELP}`);

function dayIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return -1;
  return DAY_NAMES.findIndex((d) => d.startsWith(w) && (w.length >= 3));
}

/** "9", "9am", "9:30", "9.30pm", "17:00", "noon", "midnight" → hour and minute (24-hour). */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'noon' || t === 'midday') return { hour: 12, minute: 0 };
  if (t === 'midnight') return { hour: 0, minute: 0 };
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.replaceAll('.', '');
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

/** "20 minutes", "1h30m", "2 hours 15 min", "an hour", "half an hour" → minutes. */
export function parseDuration(text: string): number | null {
  let t = text.trim().toLowerCase();
  if (/^half an? hour$/.test(t)) return 30;
  t = t.replace(/\b(an?)\s+(?=[a-z])/g, '1 ').replace(/\band\b/g, ' ').replace(/,/g, ' ');
  const re = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])/g;
  let total = 0;
  let consumed = '';
  for (const m of t.matchAll(re)) {
    total += Number(m[1]) * UNIT_MINUTES[m[2]![0]!]!;
    consumed += m[0];
  }
  if (!consumed || t.replace(re, '').trim() !== '') return null;
  return Math.round(total);
}

/** Calendar date `days` after the local date of `now` in `zone`. */
function localDate(now: Date, zone: string, days = 0): { year: number; month: number; day: number; weekday: number } {
  const p = zonedParts(now, zone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

function cronIfValid(text: string): string | null {
  const t = text.trim();
  if (/^@(hourly|daily|weekly|monthly)$/i.test(t)) return t.toLowerCase();
  const fields = t.split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => /^[\w*,/-]+$/.test(f)) || !/[\d*]/.test(fields[0]!)) return null;
  try {
    parseCron(t);
    return t;
  } catch (e) {
    throw new RubyError('invalid_input', `"${text}" looks like a cron expression but is not valid: ${(e as Error).message}`);
  }
}

/** Weekday spec: "day", "weekday(s)", "weekend(s)", "monday", "mon,wed,fri", "mon-fri" → cron day-of-week field. */
function weekdayField(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s*(,|and)\s*/g, ',');
  if (['day', 'days', 'daily', 'everyday', 'morning', 'evening', 'night'].includes(t)) return '*';
  if (t === 'weekday' || t === 'weekdays' || t === 'workday' || t === 'workdays') return '1-5';
  if (t === 'weekend' || t === 'weekends') return '0,6';
  const range = /^([a-z]+)-([a-z]+)$/.exec(t);
  if (range) {
    const [a, b] = [dayIndex(range[1]!), dayIndex(range[2]!)];
    return a >= 0 && b >= 0 ? `${a}-${b}` : null;
  }
  const days = t.split(',').map((d) => dayIndex(d.replace(/s$/, '')));
  return days.length && days.every((d) => d >= 0) ? [...new Set(days)].sort().join(',') : null;
}

/**
 * Parses a schedule. Relative and wall-clock times are read in `zone`; a bare
 * clock time that already passed today means tomorrow.
 */
export function parseWhen(input: string, opts: { now: Date; zone: string }): When {
  const text = input.trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  if (!text) throw bad(input, 'The schedule is empty.');
  const { now, zone } = opts;

  const cron = cronIfValid(text);
  if (cron) return { kind: 'cron', cron };

  // Recurring.
  const recurring = /^(?:every|each) (.+)$/.exec(lower)?.[1] ?? (/^(hourly|daily|weekdays|weekends)\b/.test(lower) ? lower : null);
  if (recurring !== null) {
    const rest = recurring.replace(/^daily\b/, 'day').replace(/^hourly$/, 'hour').replace(/^other /, '2 ');
    const at = /^(.+?)(?: at | )([\d:.]+ ?(?:am|pm)?|noon|midnight|midday)$/.exec(rest);
    if (at) {
      const dow = weekdayField(at[1]!);
      const clock = parseClock(at[2]!);
      if (dow !== null && clock) return { kind: 'cron', cron: `${clock.minute} ${clock.hour} * * ${dow}` };
      if (dow !== null) throw bad(input, `"${at[2]}" is not a time of day.`);
    }
    if (/^(?:1 |2 )?(?:day|week)s?$/.test(rest) || weekdayField(rest) !== null) {
      throw bad(input, 'Say what time of day, e.g. "every day at 9am" or "every monday at 9am".');
    }
    const minutes = parseDuration(/^\d/.test(rest) ? rest : `1 ${rest}`);
    if (minutes === null) throw bad(input);
    if (minutes < 5) throw bad(input, 'Recurring jobs run at most every 5 minutes.');
    if (minutes > 10_080) throw bad(input, 'Intervals can be at most a week; use a cron expression for longer.');
    return { kind: 'heartbeat', everyMinutes: minutes };
  }

  // Relative one-shot.
  const rel = /^in (.+)$/.exec(lower);
  if (rel) {
    const minutes = parseDuration(rel[1]!);
    if (minutes === null || minutes < 1) throw bad(input);
    return { kind: 'once', at: new Date(Math.ceil(now.getTime() / 60_000) * 60_000 + minutes * 60_000), shifted: false };
  }

  // Absolute: ISO-like date and time, with or without an offset.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ]|\s+at\s+)(.+)$/i.exec(text);
  if (iso) {
    const tail = iso[4]!.trim();
    if (/(z|[+-]\d{2}:?\d{2})$/i.test(tail)) {
      const at = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T${tail.replace(/ /g, '')}`);
      if (Number.isNaN(at.getTime())) throw bad(input);
      return { kind: 'once', at, shifted: false };
    }
    const clock = parseClock(tail.replace(/^(\d{1,2}:\d{2}):\d{2}(\.\d+)?$/, '$1'));
    if (!clock) throw bad(input);
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw bad(input, 'That date does not exist.');
    const r = localToUtc({ year, month, day, ...clock }, zone);
    return { kind: 'once', at: r.at, shifted: r.shifted };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) throw bad(input, 'Say what time on that day, e.g. "2026-12-24 09:00".');

  // "[at] <time>", optionally after "today", "tonight", "tomorrow", "<weekday>" or "next <weekday>".
  let rest = lower.replace(/^at /, '');
  let dayWord: string | null = null;
  const dm = /^(today|tonight|tomorrow|next [a-z]+|[a-z]+)\b(?: at\b)?\s*(.*)$/.exec(rest);
  if (dm && (['today', 'tonight', 'tomorrow'].includes(dm[1]!) || dayIndex(dm[1]!.replace(/^next /, '')) >= 0)) {
    dayWord = dm[1]!;
    rest = dm[2]!;
    if (!rest) throw bad(input, 'Say what time.');
  }
  const clock = parseClock(rest);
  if (!clock) throw bad(input);
  let offset = 0;
  if (dayWord === 'tomorrow') offset = 1;
  else if (dayWord && dayWord !== 'today' && dayWord !== 'tonight') {
    offset = (dayIndex(dayWord.replace(/^next /, '')) - localDate(now, zone).weekday + 7) % 7;
    if (dayWord.startsWith('next ') && offset === 0) offset = 7;
  }
  const on = (days: number) => {
    const d = localDate(now, zone, days);
    return localToUtc({ year: d.year, month: d.month, day: d.day, ...clock }, zone);
  };
  let r = on(offset);
  if (r.at.getTime() <= now.getTime()) {
    if (dayWord === 'today' || dayWord === 'tonight' || dayWord === 'tomorrow') {
      throw new RubyError('invalid_input', `"${input}" is already in the past (it is now ${describeTime(now, zone, now)} in ${zone}).`);
    }
    r = on(offset + (dayWord ? 7 : 1)); // a bare time that passed today means tomorrow; a weekday means next week
  }
  return { kind: 'once', at: r.at, shifted: r.shifted };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "today at 17:00", "tomorrow at 09:00", "Thu 9 Oct at 09:00" (with the year when it differs). */
export function describeTime(at: Date, zone: string, now: Date): string {
  const p = zonedParts(at, zone);
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  const today = localDate(now, zone);
  const tomorrow = localDate(now, zone, 1);
  const yesterday = localDate(now, zone, -1);
  const same = (d: { year: number; month: number; day: number }) => d.year === p.year && d.month === p.month && d.day === p.day;
  if (same(today)) return `today at ${clock}`;
  if (same(tomorrow)) return `tomorrow at ${clock}`;
  if (same(yesterday)) return `yesterday at ${clock}`;
  return `${SHORT_DAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}${p.year !== today.year ? ` ${p.year}` : ''} at ${clock}`;
}

/** "in 5 min", "in 3 h 20 min", "in 2 days", "2 h ago". */
export function describeDistance(at: Date, now: Date): string {
  const ms = at.getTime() - now.getTime();
  // Whole minutes rounded towards zero: "in 20 min" until less than 20 minutes remain.
  const abs = Math.floor(Math.abs(ms) / 60_000);
  const diff = ms < 0 ? -abs : abs;
  let text: string;
  if (abs < 1) return ms > 0 ? 'in under a minute' : 'just now';
  if (abs < 60) text = `${abs} min`;
  else if (abs < 48 * 60) text = `${Math.floor(abs / 60)} h${abs % 60 ? ` ${abs % 60} min` : ''}`;
  else text = `${Math.round(abs / 1440)} days`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** "tomorrow at 09:00 (Europe/London, in 14 h 2 min)". */
export function describeNext(at: Date, zone: string, now: Date): string {
  return `${describeTime(at, zone, now)} (${zone}, ${describeDistance(at, now)})`;
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Plain-language schedule: "every weekday at 09:15", "every 30 minutes", "once, tomorrow at 09:00". */
export function describeSchedule(job: Pick<JobConfig, 'kind' | 'cron' | 'everyMinutes' | 'at'>, zone: string, now: Date): string {
  if (job.kind === 'once') return `once, ${describeTime(new Date(job.at!), zone, now)}`;
  if (job.kind === 'heartbeat') {
    const n = job.everyMinutes!;
    if (n % 60 === 0) return n === 60 ? 'every hour' : `every ${n / 60} hours`;
    return `every ${n} minutes`;
  }
  const expr = job.cron!.trim();
  const aliases: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
  const fields = (aliases[expr] ?? expr).split(/\s+/);
  if (fields.length === 5 && /^\d+$/.test(fields[0]!) && /^\d+$/.test(fields[1]!) && fields[2] === '*' && fields[3] === '*') {
    const clock = `${pad(Number(fields[1]))}:${pad(Number(fields[0]))}`;
    const dow = fields[4]!;
    if (dow === '*') return `every day at ${clock}`;
    if (dow === '1-5') return `every weekday at ${clock}`;
    if (dow === '0,6' || dow === '6,0') return `every weekend day at ${clock}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) return `every ${LIST.format([...new Set(dow.split(',').map((d) => SHORT_DAYS[Number(d) % 7]!))])} at ${clock}`;
  }
  if (fields.length === 5 && /^\d+$/.test(fields[0]!) && fields.slice(1).every((f) => f === '*')) return `every hour at ${pad(Number(fields[0]))} past`;
  return `cron "${expr}"`;
}

/** The next time a job is due after `now`, or null (a once job that already ran, or nothing within a year). */
export function nextRunOf(job: JobConfig, lastScheduledFor: string | null, now: Date, zone: string): Date | null {
  if (job.kind === 'once') {
    const at = new Date(job.at!);
    return lastScheduledFor && new Date(lastScheduledFor) >= at ? null : at;
  }
  if (job.kind === 'heartbeat') {
    const every = job.everyMinutes! * 60_000;
    return new Date((Math.floor(now.getTime() / every) + 1) * every);
  }
  return nextRun(parseCron(job.cron!), now, zone);
}

/** The shortest gap between the next few runs, in minutes (to refuse schedules that fire too often). */
export function minGapMinutes(job: JobConfig, now: Date, zone: string): number {
  if (job.kind === 'once') return Infinity;
  if (job.kind === 'heartbeat') return job.everyMinutes!;
  const cron = parseCron(job.cron!);
  let gap = Infinity;
  let prev = nextRun(cron, now, zone);
  for (let i = 0; prev && i < 6; i++) {
    const next = nextRun(cron, prev, zone);
    if (!next) break;
    gap = Math.min(gap, (next.getTime() - prev.getTime()) / 60_000);
    prev = next;
  }
  return gap;
}
