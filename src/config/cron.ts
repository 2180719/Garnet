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

/**
 * The first matching minute strictly after `after`, scanning UTC minutes and
 * testing local wall-clock fields. Local times skipped by a DST jump never
 * match; a repeated local hour matches each time it occurs (the scheduler
 * coalesces by local minute). Returns null if nothing matches within a year.
 */
export function nextRun(cron: Cron, after: Date, timeZone: string): Date | null {
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 86_400_000;
  while (t < limit) {
    const p = zonedParts(new Date(t), timeZone);
    if (!cron.months.has(p.month) || (!dayMatches(cron, p))) {
      t += (24 * 60 - (p.hour * 60 + p.minute)) * 60_000; // jump to next local midnight (approximately)
      continue;
    }
    if (!cron.hours.has(p.hour)) {
      t += (60 - p.minute) * 60_000;
      continue;
    }
    if (matches(cron, p)) return new Date(t);
    t += 60_000;
  }
  return null;
}

function dayMatches(cron: Cron, p: ReturnType<typeof zonedParts>): boolean {
  const dom = cron.days.has(p.day);
  const dow = cron.weekdays.has(p.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}
