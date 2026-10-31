/**
 * Pure America/New_York time helpers. No dependency on the host time zone:
 * everything goes through Intl with an explicit timeZone, so DST is handled by
 * the platform tz database.
 */

export const ET_TZ = "America/New_York";

const etFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

export interface EtParts {
  /** YYYY-MM-DD in ET */
  date: string;
  /** HH:MM in ET */
  hhmm: string;
  /** minutes since ET midnight */
  minutes: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  second: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function toEt(d: Date): EtParts {
  const parts: Record<string, string> = {};
  for (const p of etFormatter.formatToParts(d)) parts[p.type] = p.value;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS[parts.weekday],
    second: Number(parts.second),
  };
}

/** "HH:MM" -> minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Offset of ET from UTC, in minutes (EST -300, EDT -240), at instant d. */
function etOffsetMinutes(d: Date): number {
  const p = toEt(d);
  const [y, mo, da] = p.date.split("-").map(Number);
  const asUtc = Date.UTC(y, mo - 1, da, Math.floor(p.minutes / 60), p.minutes % 60, p.second);
  return Math.round((asUtc - (d.getTime() - d.getMilliseconds())) / 60000);
}

/**
 * The UTC instant of a wall-clock time in ET on a given date, e.g.
 * etToUtc("2024-03-11", "09:30") -> 2024-03-11T13:30:00Z (EDT).
 * Wall times in the spring-forward gap resolve to the later offset; market
 * hours never fall in the gap or the fall-back overlap.
 */
export function etToUtc(date: string, hhmm: string): Date {
  const [y, mo, da] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, da, h, mi);
  // Two passes converge for every real-world offset change.
  let guess = naive - etOffsetMinutes(new Date(naive)) * 60000;
  guess = naive - etOffsetMinutes(new Date(guess)) * 60000;
  return new Date(guess);
}

/** Add calendar days to a YYYY-MM-DD string. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO timestamp truncated to the minute, UTC: "2024-03-11T13:30:00Z". */
export function isoMinute(d: Date): string {
  return d.toISOString().slice(0, 16) + ":00Z";
}

// ---------------------------------------------------------------------------
// Trading calendar
// ---------------------------------------------------------------------------

export interface Session {
  /** YYYY-MM-DD */
  date: string;
  /** "HH:MM" ET */
  open: string;
  /** "HH:MM" ET; "13:00" on early-close days */
  close: string;
}

/** Normalize Alpaca /v2/calendar rows ({date, open, close} with "0930"/"09:30"). */
export function parseCalendar(rows: Array<{ date: string; open: string; close: string }>): Session[] {
  const norm = (t: string) => (t.includes(":") ? t.slice(0, 5) : `${t.slice(0, 2)}:${t.slice(2, 4)}`);
  return rows
    .map((r) => ({ date: r.date, open: norm(r.open), close: norm(r.close) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function isEarlyClose(s: Session): boolean {
  return hhmmToMinutes(s.close) < hhmmToMinutes("16:00");
}

/** The session strictly before `date` (calendar must include it). */
export function priorSession(sessions: Session[], date: string): Session | undefined {
  let best: Session | undefined;
  for (const s of sessions) if (s.date < date && (!best || s.date > best.date)) best = s;
  return best;
}

export function sessionOn(sessions: Session[], date: string): Session | undefined {
  return sessions.find((s) => s.date === date);
}

export type CronGate =
  | { action: "skip"; reason: string }
  | { action: "ingest"; et: EtParts; session: Session }
  | { action: "decide_only"; et: EtParts; session: Session };

/**
 * Decide what a cron invocation at `now` should do. Pure: the caller supplies
 * the trading session for today's ET date (or undefined if it's a holiday).
 */
export function cronGate(
  now: Date,
  session: Session | undefined,
  opts: { windowStart: string; windowEnd: string; catchUpUntil: string },
): CronGate {
  const et = toEt(now);
  if (et.weekday === 0 || et.weekday === 6) return { action: "skip", reason: `weekend (${et.date})` };
  if (!session || session.date !== et.date) return { action: "skip", reason: `not a trading day (${et.date})` };
  const m = et.minutes;
  if (m < hhmmToMinutes(opts.windowStart)) return { action: "skip", reason: `before window (${et.hhmm} ET)` };
  if (m <= hhmmToMinutes(opts.windowEnd)) return { action: "ingest", et, session };
  if (m <= hhmmToMinutes(opts.catchUpUntil)) return { action: "decide_only", et, session };
  return { action: "skip", reason: `after window (${et.hhmm} ET)` };
}
