/** Deterministic sample data for tests. No randomness, no network. */
import type { Bar } from "@/lib/alpaca";
import type { Session } from "@/lib/time";
import { etToUtc, parseCalendar } from "@/lib/time";

/** Alpaca /v2/calendar rows around the 2024 DST transitions and early closes. */
export const CALENDAR = parseCalendar([
  { date: "2024-03-07", open: "09:30", close: "16:00" },
  { date: "2024-03-08", open: "09:30", close: "16:00" }, // last EST session before spring-forward (Sun 03-10)
  { date: "2024-03-11", open: "09:30", close: "16:00" }, // first EDT session
  { date: "2024-07-02", open: "09:30", close: "16:00" },
  { date: "2024-07-03", open: "09:30", close: "13:00" }, // early close
  { date: "2024-07-05", open: "09:30", close: "16:00" }, // 07-04 holiday
  { date: "2024-11-01", open: "09:30", close: "16:00" }, // last EDT session before fall-back (Sun 11-03)
  { date: "2024-11-04", open: "09:30", close: "16:00" }, // first EST session
  { date: "2024-11-27", open: "0930", close: "1600" },  // Alpaca also returns HHMM
  { date: "2024-11-29", open: "0930", close: "1300" },  // day after Thanksgiving, early close
  { date: "2024-12-02", open: "0930", close: "1600" },
]);

export const session = (date: string): Session => CALENDAR.find((s) => s.date === date)!;

/**
 * Regular-session 1-minute bars for one symbol. closes[i] is the close of
 * minute i after the open; each bar opens at the previous close (the first at
 * `open`) and has a fixed wick of `wick` either side.
 */
export function makeBars(symbol: string, s: Session, open: number, closes: number[], wick = 0.05, feed: "sip" | "iex" = "sip"): Bar[] {
  const start = etToUtc(s.date, s.open).getTime();
  let prev = open;
  return closes.map((c, i) => {
    const o = prev;
    prev = c;
    return { symbol, ts: new Date(start + i * 60000).toISOString(), o, h: Math.max(o, c) + wick, l: Math.min(o, c) - wick, c, v: 1000, feed };
  });
}

/** A flat full session ending at `close` (every bar closes at `close`). */
export function flatSession(symbol: string, s: Session, close: number): Bar[] {
  const [oh, om] = s.open.split(":").map(Number);
  const [ch, cm] = s.close.split(":").map(Number);
  const minutes = ch * 60 + cm - (oh * 60 + om);
  return makeBars(symbol, s, close, Array(minutes).fill(close), 0);
}
