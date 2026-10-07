// A small iCalendar (RFC 5545) reader: VEVENTs with their times, and the
// common recurrence rules expanded in the event's own time zone. Anything it
// does not understand is reported, never guessed.
import { localToUtc, validTimeZone, zonedParts } from '../config/index.ts';

/** A date (all-day) or a date-time: in UTC, in a named zone, or floating (no zone: the owner's). */
export type When =
  | { date: true; y: number; m: number; d: number }
  | { date: false; y: number; m: number; d: number; hh: number; mi: number; zone: string | null; utc: boolean };

export type IcsEvent = {
  uid: string;
  summary: string;
  location: string;
  description: string;
  status: string;
  start: When;
  end: When | null;
  /** DURATION, when given instead of DTEND: nominal days (weeks are 7) kept apart from exact time, because a day is not always 24 hours. */
  duration: Duration | null;
  rrule: string | null;
  exdates: When[];
  recurrenceId: When | null;
};

export type Occurrence = {
  event: IcsEvent;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Set when something could not be honored exactly (an unknown time zone, a rule not expanded). */
  note?: string;
};

const MAX_EVENTS = 20_000;
const MAX_STEPS = 20_000;

/** Parses VEVENTs out of an ICS document. Malformed events are skipped. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> & { exdates: When[] } | null = null;
  let nested = 0; // components inside a VEVENT (VALARM) whose properties are ignored
  for (const raw of lines) {
    if (!raw) continue;
    const prop = parseLine(raw);
    if (!prop) continue;
    const { name, params, value } = prop;
    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !current) current = { exdates: [] };
      else if (current) nested++;
      continue;
    }
    if (name === 'END') {
      if (current && nested > 0) nested--;
      else if (current && value.toUpperCase() === 'VEVENT') {
        if (current.start && events.length < MAX_EVENTS) {
          events.push({
            uid: current.uid ?? '',
            summary: current.summary ?? '',
            location: current.location ?? '',
            description: current.description ?? '',
            status: current.status ?? '',
            start: current.start,
            end: current.end ?? null,
            duration: current.duration ?? null,
            rrule: current.rrule ?? null,
            exdates: current.exdates,
            recurrenceId: current.recurrenceId ?? null,
          });
        }
        current = null;
      }
      continue;
    }
    if (!current || nested > 0) continue;
    switch (name) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value);
        break;
      case 'LOCATION':
        current.location = unescapeText(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value);
        break;
      case 'STATUS':
        current.status = value.toUpperCase();
        break;
      case 'DTSTART': {
        const w = parseWhen(value, params);
        if (w) current.start = w;
        break;
      }
      case 'DTEND': {
        const w = parseWhen(value, params);
        if (w) current.end = w;
        break;
      }
      case 'DURATION':
        current.duration = parseDurationParts(value);
        break;
      case 'RRULE':
        current.rrule = value;
        break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const w = parseWhen(v, params);
          if (w) current.exdates.push(w);
        }
        break;
      case 'RECURRENCE-ID': {
        const w = parseWhen(value, params);
        if (w) current.recurrenceId = w;
        break;
      }
    }
  }
  return events;
}

function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts: string[] = [];
  let buf = '';
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      parts.push(buf);
      buf = '';
    } else buf += c;
  }
  parts.push(buf);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: parts[0]!.toUpperCase(), params, value: line.slice(colon + 1) };
}

export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** `20261006`, `20261006T090000`, `20261006T090000Z`, with VALUE=DATE and TZID parameters. */
export function parseWhen(value: string, params: Record<string, string> = {}): When | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date) return { date: true, y: Number(date[1]), m: Number(date[2]), d: Number(date[3]) };
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return null;
  const utc = dt[7] === 'Z';
  const tzid = params.TZID?.replace(/^\/+/, '') ?? null;
  return { date: false, y: Number(dt[1]), m: Number(dt[2]), d: Number(dt[3]), hh: Number(dt[4]), mi: Number(dt[5]), zone: utc ? 'UTC' : tzid, utc };
}

/** A DURATION split as RFC 5545 3.3.6 needs: nominal `days` (weeks are 7 days) and exact `ms` (hours, minutes, seconds), both signed. */
export type Duration = { days: number; ms: number };

/** RFC 5545 DURATION (`PT1H30M`, `P1D`, `P2W`, signed) as nominal days and exact milliseconds; null when malformed. */
export function parseDurationParts(v: string): Duration | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || v.trim() === 'P' || v.trim().endsWith('T')) return null;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  const sign = m[1] === '-' ? -1 : 1;
  return { days: sign * (w * 7 + d) || 0, ms: sign * (((h * 60 + mi) * 60 + s) * 1000) || 0 };
}

/** RFC 5545 DURATION in milliseconds, counting a day as 24 hours (only right away from DST changes; occurrences use `parseDurationParts`). Null when malformed. */
export function parseDuration(v: string): number | null {
  const d = parseDurationParts(v);
  return d && d.days * DAY_MS + d.ms;
}

type Wall = { y: number; m: number; d: number; hh: number; mi: number };

const DAY_MS = 86_400_000;

/** The instant a `When` names. All-day dates and floating times are in `ownerZone`; an unknown TZID falls back to it, flagged. */
export function toInstant(w: When, ownerZone: string): { at: Date; unknownZone?: string } {
  if (w.date) return { at: localToUtc({ year: w.y, month: w.m, day: w.d, hour: 0, minute: 0 }, ownerZone).at };
  if (w.utc) return { at: new Date(Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mi)) };
  const zone = w.zone && validTimeZone(w.zone) ? w.zone : ownerZone;
  const at = localToUtc({ year: w.y, month: w.m, day: w.d, hour: w.hh, minute: w.mi }, zone).at;
  return w.zone && zone !== w.zone ? { at, unknownZone: w.zone } : { at };
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SUPPORTED = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);

const dayNumber = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
const fromDayNumber = (n: number): { y: number; m: number; d: number } => {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const weekday = (n: number): number => (((n + 4) % 7) + 7) % 7; // day 0 (1970-01-01) was a Thursday
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Days (as day numbers) of month y/m matching BYDAY entries like `MO`, `2TU`, `-1FR`. */
function byDayInMonth(y: number, m: number, byday: { n: number; wd: number }[]): number[] {
  const first = dayNumber(y, m, 1);
  const len = daysInMonth(y, m);
  const out: number[] = [];
  for (const { n, wd } of byday) {
    const all: number[] = [];
    for (let i = 0; i < len; i++) if (weekday(first + i) === wd) all.push(first + i);
    if (n === 0) out.push(...all);
    else {
      const pick = n > 0 ? all[n - 1] : all[all.length + n];
      if (pick !== undefined) out.push(pick);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Every occurrence of the events overlapping [from, to), sorted by start.
 * Recurring events are expanded in their own zone (so 09:00 stays 09:00 across
 * a DST change); EXDATEs and moved or cancelled instances (RECURRENCE-ID) are
 * honored. Cancelled events are left out.
 */
export function occurrences(events: IcsEvent[], from: Date, to: Date, ownerZone: string): Occurrence[] {
  const out: Occurrence[] = [];
  const overridden = new Set<string>();
  for (const e of events) {
    if (e.recurrenceId) overridden.add(`${e.uid}|${toInstant(e.recurrenceId, ownerZone).at.getTime()}`);
  }
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    for (const o of expand(e, from, to, ownerZone)) {
      if (!e.recurrenceId && overridden.has(`${e.uid}|${o.start.getTime()}`)) continue;
      if (o.start < to && (o.end > from || (o.end.getTime() === o.start.getTime() && o.start >= from))) out.push(o);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.event.summary.localeCompare(b.event.summary));
}

function expand(e: IcsEvent, from: Date, to: Date, ownerZone: string): Occurrence[] {
  const allDay = e.start.date;
  const first = toInstant(e.start, ownerZone);
  const endOf = lengthOf(e, first.at, ownerZone);
  const zoneNote = first.unknownZone ? `time zone "${first.unknownZone}" not recognized; shown as if in ${ownerZone}` : undefined;
  const one = (start: Date, note?: string): Occurrence => {
    const notes = [zoneNote, note].filter(Boolean).join('; ');
    return { event: e, start, end: endOf(start), allDay, ...(notes ? { note: notes } : {}) };
  };
  if (!e.rrule || e.recurrenceId) return [one(first.at)];

  const rule = new Map(e.rrule.split(';').map((p) => {
    const eq = p.indexOf('=');
    return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).toUpperCase()] as const;
  }));
  const freq = rule.get('FREQ');
  const unsupported = [...rule.keys()].filter((k) => !SUPPORTED.has(k));
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq) || unsupported.length) {
    return [one(first.at, `repeats (${unsupported.length ? `rule part ${unsupported.join(', ')}` : `frequency ${freq ?? '?'}`} not supported; only the first date is shown)`)];
  }
  const interval = Math.max(1, Number(rule.get('INTERVAL') ?? 1) || 1);
  const count = rule.has('COUNT') ? Number(rule.get('COUNT')) : Infinity;
  const untilWhen = rule.get('UNTIL') ? parseWhen(rule.get('UNTIL')!) : null;
  const until = untilWhen ? toInstant(untilWhen, ownerZone).at.getTime() : Infinity;
  const byday = (rule.get('BYDAY') ?? '')
    .split(',')
    .filter(Boolean)
    .map((t) => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(t);
      return m ? { n: Number(m[1] ?? 0), wd: WEEKDAYS.indexOf(m[2]!) } : null;
    });
  if (byday.some((b) => b === null)) return [one(first.at, 'repeats (BYDAY not understood; only the first date is shown)')];
  const days = byday as { n: number; wd: number }[];
  const monthDays = (rule.get('BYMONTHDAY') ?? '').split(',').filter(Boolean).map(Number);
  const months = (rule.get('BYMONTH') ?? '').split(',').filter(Boolean).map(Number);
  const wkst = WEEKDAYS.indexOf(rule.get('WKST') ?? 'MO');
  if (freq === 'YEARLY' && days.length && !months.length) return [one(first.at, 'repeats (yearly by weekday without a month is not supported; only the first date is shown)')];

  const s = e.start;
  const wall = (n: number): Wall => ({ ...fromDayNumber(n), hh: s.date ? 0 : s.hh, mi: s.date ? 0 : s.mi });
  const instant = (w: Wall): Date =>
    toInstant(s.date ? { date: true, y: w.y, m: w.m, d: w.d } : { date: false, y: w.y, m: w.m, d: w.d, hh: w.hh, mi: w.mi, zone: s.zone, utc: s.utc }, ownerZone).at;
  const start0 = dayNumber(s.y, s.m, s.d);
  const excluded = new Set(e.exdates.map((x) => toInstant(x, ownerZone).at.getTime()));

  /** Candidate days of period k (sorted). */
  const period = (k: number): number[] => {
    switch (freq) {
      case 'DAILY': {
        const n = start0 + k * interval;
        return !days.length || days.some((b) => b.wd === weekday(n)) ? [n] : [];
      }
      case 'WEEKLY': {
        const weekStart = start0 - ((weekday(start0) - wkst + 7) % 7) + k * interval * 7;
        const wds = days.length ? days.map((b) => b.wd) : [weekday(start0)];
        return wds.map((wd) => weekStart + ((wd - wkst + 7) % 7)).sort((a, b) => a - b);
      }
      case 'MONTHLY': {
        const idx = s.m - 1 + k * interval;
        const y = s.y + Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        if (months.length && !months.includes(m)) return [];
        return inMonth(y, m);
      }
      default: {
        const y = s.y + k * interval;
        return (months.length ? months : [s.m]).flatMap((m) => inMonth(y, m)).sort((a, b) => a - b);
      }
    }
  };
  const inMonth = (y: number, m: number): number[] => {
    const len = daysInMonth(y, m);
    if (monthDays.length) {
      return monthDays
        .map((md) => (md > 0 ? md : len + md + 1))
        .filter((d) => d >= 1 && d <= len)
        .map((d) => dayNumber(y, m, d))
        .sort((a, b) => a - b);
    }
    if (days.length) return byDayInMonth(y, m, days);
    return s.d <= len ? [dayNumber(y, m, s.d)] : []; // e.g. the 31st skips shorter months (RFC 5545)
  };

  // Without COUNT, earlier periods cannot matter: start a little before the window (a long-running rule stays cheap).
  let k0 = 0;
  if (count === Infinity) {
    const behind = Math.floor(from.getTime() / DAY_MS) - 2 - start0;
    const per = freq === 'DAILY' ? interval : freq === 'WEEKLY' ? 7 * interval : freq === 'MONTHLY' ? 31 * interval : 366 * interval; // the longest period, so k0 never skips one
    k0 = Math.max(0, Math.floor(behind / per) - 1);
  }
  const out: Occurrence[] = [];
  let produced = 0;
  for (let k = k0; k < k0 + MAX_STEPS; k++) {
    const candidates = period(k).filter((n) => n >= start0);
    let past = false;
    for (const n of candidates) {
      const at = instant(wall(n));
      if (at.getTime() > until || produced >= count) {
        past = true;
        break;
      }
      produced++;
      if (at >= to) {
        past = true;
        break;
      }
      if (excluded.has(at.getTime())) continue;
      const o = one(at);
      if (o.end.getTime() > from.getTime() - 1) out.push(o);
    }
    if (past) break;
  }
  return out;
}

/**
 * How each occurrence's end follows from its start (RFC 5545 3.6.1, 3.8.5.3). A date-time DTEND gives an exact
 * length, the same for every occurrence. Days are nominal: an all-day event with no end lasts one day, a date
 * DTEND counts whole days, and a DURATION's days are added on the calendar in the event's own zone (the owner's
 * for all-day and floating times), so they end at the same wall-clock time even across a DST change. A DURATION's
 * hours, minutes and seconds are exact. A negative length becomes zero.
 */
function lengthOf(e: IcsEvent, firstStart: Date, ownerZone: string): (start: Date) => Date {
  const s = e.start;
  const zone = s.date ? ownerZone : s.utc ? 'UTC' : s.zone && validTimeZone(s.zone) ? s.zone : ownerZone;
  const at = (start: Date, days: number, ms: number): Date => {
    const end = new Date(addDays(start, days, zone).getTime() + ms);
    return end < start ? start : end;
  };
  if (e.end) {
    if (s.date && e.end.date) {
      const days = dayNumber(e.end.y, e.end.m, e.end.d) - dayNumber(s.y, s.m, s.d);
      return (start) => at(start, days, 0);
    }
    const exact = toInstant(e.end, ownerZone).at.getTime() - firstStart.getTime();
    return (start) => at(start, 0, exact);
  }
  if (e.duration) {
    const { days, ms } = e.duration;
    return (start) => at(start, days, ms);
  }
  return (start) => at(start, s.date ? 1 : 0, 0);
}

/** The same wall-clock time `days` calendar days later in `zone` (a day is 23 to 25 hours around DST changes). */
function addDays(start: Date, days: number, zone: string): Date {
  if (days === 0) return start;
  const p = zonedParts(start, zone);
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  // Starts are whole minutes (parseWhen reads no seconds), so the wall clock to the minute is exact.
  return localToUtc({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), hour: p.hour, minute: p.minute }, zone).at;
}
