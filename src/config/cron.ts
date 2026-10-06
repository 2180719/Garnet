import { RubyError } from '../contracts/index.ts';

/**
 * Standard 5-field cron (minute hour day-of-month month day-of-week) evaluated
 * in an IANA time zone. Supports `*`, lists, ranges, steps and names
 * (jan-dec, sun-sat). Day-of-month and day-of-week combine with OR when both
 * are restricted, as in Vixie cron.
 */
export type Cron = {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** Hour field starts with `*` (e.g. `*`, `*\/2`): such jobs follow elapsed time through a repeated (fall-back) hour. */
  hourWildcard?: boolean;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

function field(text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const value = (v: string) => {
    const i = names.indexOf(v.toLowerCase());
    const n = i >= 0 ? i + nameBase : Number(v);
    if (!Number.isInteger(n)) throw new RubyError('invalid_input', `Invalid cron value "${v}"`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new RubyError('invalid_input', `Invalid cron step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range!.includes('-')) [lo, hi] = range!.split('-').map(value) as [number, number];
    else [lo, hi] = [value(range!), stepText === undefined ? value(range!) : max];
    if (lo < min || hi > max || lo > hi) throw new RubyError('invalid_input', `Cron value out of range in "${part}" (${min}-${max})`);
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): Cron {
  const expr = ALIASES[expression.trim()] ?? expression.trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new RubyError('invalid_input', `Cron needs 5 fields (minute hour day month weekday), got "${expression}"`);
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const weekdays = field(dow, 0, 7, DAYS);
  if (weekdays.has(7)) weekdays.add(0); // 7 is also Sunday
  weekdays.delete(7);
  return {
    minutes: field(m, 0, 59),
    hours: field(h, 0, 23),
    days: field(dom, 1, 31),
    months: field(mon, 1, 12, MONTHS, 1),
    weekdays,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
    hourWildcard: h.startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: DAYS.indexOf(p.weekday!.toLowerCase().slice(0, 3)),
  };
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function matches(cron: Cron, p: ReturnType<typeof zonedParts>): boolean {
  if (!cron.minutes.has(p.minute) || !cron.hours.has(p.hour) || !cron.months.has(p.month)) return false;
  const dom = cron.days.has(p.day);
  const dow = cron.weekdays.has(p.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

/** Largest DST shift we guard against, in minutes (real zones shift by 30, 60 or, historically, 120). */
const MAX_SHIFT = 120;

/**
 * The first matching minute strictly after `after`, scanning UTC minutes and
 * testing local wall-clock fields. Local times skipped by a DST jump never
 * match. A wall-clock minute that occurs twice (fall-back) fires only at its
 * first instance, as in cron; jobs whose hour field is a wildcard keep
 * following elapsed time instead (as cronie does), so an hourly job is not
 * silent for the repeated hour. Returns null if nothing matches within a year.
 */
export function nextRun(cron: Cron, after: Date, timeZone: string): Date | null {
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 86_400_000;
  while (t < limit) {
    const p = zonedParts(new Date(t), timeZone);
    if (!cron.months.has(p.month) || (!dayMatches(cron, p))) {
      // Skip towards the next local midnight without overshooting it: a day can
      // be shorter than 24 hours, so stop short by MAX_SHIFT and finish hour by hour.
      const toMidnight = 24 * 60 - (p.hour * 60 + p.minute);
      t += (toMidnight > MAX_SHIFT + 60 ? toMidnight - MAX_SHIFT - 60 : 60 - p.minute) * 60_000;
      continue;
    }
    if (!cron.hours.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
      continue;
    }
    if (matches(cron, p) && (cron.hourWildcard || !repeated(t, p, timeZone))) return new Date(t);
    t += 60_000;
  }
  return null;
}

/** Whether the wall-clock minute `p` (at instant `t`) already occurred earlier, i.e. `t` is a fall-back repeat. */
function repeated(t: number, p: ReturnType<typeof zonedParts>, timeZone: string): boolean {
  const offset = (at: number, z: ReturnType<typeof zonedParts>) => Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute) - at;
  const earlier = t - MAX_SHIFT * 60_000;
  // Only a fall-back (the UTC offset decreasing) can repeat a wall-clock minute.
  if (offset(earlier, zonedParts(new Date(earlier), timeZone)) <= offset(t, p)) return false;
  for (let back = 15; back <= MAX_SHIFT; back += 15) {
    const q = zonedParts(new Date(t - back * 60_000), timeZone);
    if (q.day === p.day && q.hour === p.hour && q.minute === p.minute && q.month === p.month && q.year === p.year) return true;
  }
  return false;
}

function dayMatches(cron: Cron, p: ReturnType<typeof zonedParts>): boolean {
  const dom = cron.days.has(p.day);
  const dow = cron.weekdays.has(p.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}
