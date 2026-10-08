import { z } from 'zod';
import { GarnetError, type ToolDefinition } from '../../contracts/index.ts';

const MINUTE = 60_000;

function checkZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new GarnetError('invalid_input', `"${tz}" is not a time zone. Use an IANA name like Europe/Lisbon or America/New_York, or UTC.`);
  }
}

/** Wall-clock parts of an instant in a zone. */
function partsIn(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; weekday: string; offsetMin: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second), weekday: p.weekday!, offsetMin: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE) };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `2026-10-08T14:30:00+01:00` style text for an instant in a zone. */
export function formatIn(ms: number, tz: string): string {
  const p = partsIn(ms, tz);
  const sign = p.offsetMin < 0 ? '-' : '+';
  const off = Math.abs(p.offsetMin);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)} (${p.weekday}, ${tz})`;
}

/**
 * Parses a timestamp. With an explicit offset or `Z` it is exact; without one the wall time is read in `tz`
 * (two passes of offset correction settle it across a DST change).
 */
export function parseInstant(text: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text.trim());
  if (!m) throw new GarnetError('invalid_input', `Could not read "${text}". Use ISO form like 2026-10-08, 2026-10-08T14:30 or 2026-10-08T14:30:00+01:00.`);
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  // setUTCFullYear keeps years below 100 as written; the round trip rejects 2026-02-31, month 13 and hour 25.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec, 0);
  const wall = date.getTime();
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getUTCHours() !== h || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== sec) {
    throw new GarnetError('invalid_input', `"${text}" is not a real date and time.`);
  }
  if (m[7]) {
    if (m[7].toUpperCase() === 'Z') return wall;
    const sign = m[7][0] === '-' ? -1 : 1;
    const digits = m[7].slice(1).replace(':', '');
    return wall - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * MINUTE;
  }
  // A wall time with no offset: try the offsets in force a day before and after. If both fit, the clocks went back
  // and the time happens twice: take the first. If neither fits, the clocks skipped it: use the offset from before the
  // change, which lands just after the gap (02:30 in a spring-forward gap becomes 03:30).
  const before = wall - partsIn(wall - 86_400_000, tz).offsetMin * MINUTE;
  const after = wall - partsIn(wall + 86_400_000, tz).offsetMin * MINUTE;
  const fits = (t: number) => {
    const p = partsIn(t, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  };
  const valid = [before, after].filter(fits);
  return valid.length ? Math.min(...valid) : before;
}

function humanDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(ms);
  const days = Math.floor(rest / 86_400_000);
  rest -= days * 86_400_000;
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / MINUTE);
  const bits = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean);
  return sign + (bits.join(' ') || '0m');
}

type DateTimeInput = {
  operation: 'now' | 'convert' | 'add' | 'diff';
  time?: string;
  to?: string;
  timezone?: string;
  to_timezone?: string;
  days: number;
  hours: number;
  minutes: number;
};

/** `datetime`: the current time and date arithmetic, so the model never guesses either. Reads the clock only. */
export function datetimeTool(opts: { defaultTimeZone: string; now?: () => number }): ToolDefinition<DateTimeInput> {
  const now = opts.now ?? Date.now;
  return {
    name: 'datetime',
    version: 1,
    description: 'Current time and date arithmetic. operation: now (time in a zone), convert (time to another zone), add (time plus days/hours/minutes), diff (time to "to"). Times are ISO, e.g. 2026-10-08T14:30; a time with no offset is read in `timezone`.',
    input: z.object({
      operation: z.enum(['now', 'convert', 'add', 'diff']),
      time: z.string().max(64).optional().describe('Start time (ISO). Defaults to now.'),
      to: z.string().max(64).optional().describe('diff: the end time (ISO). Defaults to now.'),
      timezone: z.string().max(64).optional().describe(`IANA zone for the time. Defaults to ${opts.defaultTimeZone}.`),
      to_timezone: z.string().max(64).optional().describe('convert: zone to show the result in.'),
      days: z.number().int().min(-100_000).max(100_000).default(0).describe('add: days to add (negative to subtract). Calendar days are 24 hours here.'),
      hours: z.number().int().min(-1_000_000).max(1_000_000).default(0),
      minutes: z.number().int().min(-10_000_000).max(10_000_000).default(0),
    }),
    capability: 'fs.read',
    capabilitiesFor: () => [],
    idempotent: true,
    async run(i) {
      const tz = checkZone(i.timezone ?? opts.defaultTimeZone);
      const start = i.time ? parseInstant(i.time, tz) : now();
      switch (i.operation) {
        case 'now':
          return { content: `${formatIn(start, tz)}\nUTC ${new Date(start).toISOString()}\nUnix ${Math.floor(start / 1000)}` };
        case 'convert': {
          if (!i.to_timezone) throw new GarnetError('invalid_input', 'convert needs to_timezone.');
          const to = checkZone(i.to_timezone);
          return { content: `${formatIn(start, tz)}\n= ${formatIn(start, to)}` };
        }
        case 'add': {
          const end = start + i.days * 86_400_000 + i.hours * 3_600_000 + i.minutes * MINUTE;
          if (!Number.isFinite(new Date(end).getTime())) throw new GarnetError('invalid_input', 'The result is outside the representable date range.');
          return { content: `${formatIn(start, tz)}\n+ ${i.days}d ${i.hours}h ${i.minutes}m\n= ${formatIn(end, tz)}` };
        }
        case 'diff': {
          const end = i.to ? parseInstant(i.to, tz) : now();
          return { content: `${formatIn(start, tz)}\nto ${formatIn(end, tz)}\n= ${humanDuration(end - start)} (${Math.round((end - start) / MINUTE)} minutes)` };
        }
      }
    },
  };
}
