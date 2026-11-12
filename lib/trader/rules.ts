/**
 * Rules the code enforces (never the model). Pure functions over plain data;
 * every time check uses the server clock passed in as `now`.
 */

import { z } from "zod";
import { TRADER } from "@/config/trader";
import type { Bar, Quote } from "../alpaca";
import { etToUtc, hhmmToMinutes, toEt } from "../time";

// ---------------------------------------------------------------- reply

export const ACTIONS = ["long", "short", "close", "hold"] as const;
export const CATALYSTS = ["news", "technical", "macro", "panic_reversal", "none"] as const;

export const replySchema = z.object({
  action: z.enum(ACTIONS),
  confidence: z.number().min(0).max(100),
  stop: z.number().positive().nullable(),
  target: z.number().positive().nullable(),
  max_hold_minutes: z.number().int().min(0).max(400).nullable(),
  catalyst: z.enum(CATALYSTS),
  thesis: z.string().min(1),
});
export type Reply = z.infer<typeof replySchema>;

/** JSON schema for structured output. */
export const REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "confidence", "stop", "target", "max_hold_minutes", "catalyst", "thesis"],
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    confidence: { type: "number" },
    stop: { anyOf: [{ type: "number" }, { type: "null" }] },
    target: { anyOf: [{ type: "number" }, { type: "null" }] },
    max_hold_minutes: { anyOf: [{ type: "integer" }, { type: "null" }] },
    catalyst: { type: "string", enum: [...CATALYSTS] },
    thesis: { type: "string" },
  },
} as const;

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Parse and validate the model's text. Throws a readable error. A thesis over the word limit is trimmed. */
export function parseReply(text: string): Reply {
  return parseReplyChecked(text).reply;
}

/** As parseReply, and says whether the thesis was trimmed to TRADER.maxThesisWords (v2: trimmed, never rejected). */
export function parseReplyChecked(text: string): { reply: Reply; trimmed: boolean } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in reply");
  const r = replySchema.safeParse(JSON.parse(text.slice(start, end + 1)));
  if (!r.success) throw new Error(`schema: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const w = r.data.thesis.trim().split(/\s+/).filter(Boolean);
  if (w.length <= TRADER.maxThesisWords) return { reply: r.data, trimmed: false };
  return { reply: { ...r.data, thesis: `${w.slice(0, TRADER.maxThesisWords).join(" ")}…` }, trimmed: true };
}

// ---------------------------------------------------------------- state

export interface OpenTrade {
  id: number;
  side: "long" | "short";
  qty: number;
  entryPrice: number | null;
  entryAt: string | null;
  stop: number;
  target: number;
  maxHoldMinutes: number;
}

export interface ClosedTrade {
  side: "long" | "short";
  pl: number;
  exitAt: string;
}

export interface DayState {
  open: OpenTrade | null;
  /** Trades entered today (any status except failed-to-submit). */
  tradesToday: number;
  /** Closed trades today, in exit order. */
  closedToday: ClosedTrade[];
  gateFailed: boolean;
  enabled: boolean;
  /** Why trading is disabled, when it is (default: "trading disabled"). */
  disabledReason?: string;
}

/** Realized loss limit and losing-streak stop. */
export function dailyStopHit(closed: ClosedTrade[]): string | null {
  const loss = -closed.reduce((a, t) => a + t.pl, 0);
  if (loss >= TRADER.dailyLossFraction * TRADER.notional) return `daily loss $${loss.toFixed(2)} >= ${(TRADER.dailyLossFraction * 100).toFixed(1)}% of notional`;
  const last = closed.slice(-TRADER.maxConsecutiveLosses);
  if (last.length === TRADER.maxConsecutiveLosses && last.every((t) => t.pl < 0)) return `${TRADER.maxConsecutiveLosses} losing trades in a row`;
  return null;
}

const minutesEt = (now: Date) => toEt(now).minutes;

/** Why a new entry is not allowed right now, or null if it is. */
export function entryBlocked(now: Date, s: DayState): string | null {
  if (!s.enabled) return s.disabledReason ?? "trading disabled";
  if (s.gateFailed) return "decision gate failed for this version";
  const m = minutesEt(now);
  if (m < hhmmToMinutes(TRADER.firstEntry)) return `before ${TRADER.firstEntry} ET`;
  if (m > hhmmToMinutes(TRADER.lastEntry)) return `after ${TRADER.lastEntry} ET`;
  if (s.open) return "already in a position";
  if (s.tradesToday >= TRADER.maxTradesPerDay) return `${TRADER.maxTradesPerDay} trades already today`;
  return dailyStopHit(s.closedToday);
}

export type Validated =
  | { ok: true; kind: "enter"; side: "long" | "short"; qty: number; stop: number; target: number; maxHoldMinutes: number }
  | { ok: true; kind: "close" }
  | { ok: true; kind: "hold"; tightenStop: number | null }
  | { ok: false; reason: string };

/**
 * Turn a model reply into something the code may act on. `price` is the
 * reference price (quote mid) at decision time.
 */
export function validateAction(reply: Reply, price: number, now: Date, s: DayState): Validated {
  if (reply.action === "hold") {
    if (s.open && reply.stop !== null && reply.stop !== s.open.stop) {
      const tighter = s.open.side === "long" ? reply.stop > s.open.stop : reply.stop < s.open.stop;
      const validSide = s.open.side === "long" ? reply.stop < price : reply.stop > price;
      if (!tighter) return { ok: true, kind: "hold", tightenStop: null }; // widening is ignored, not applied
      if (!validSide) return { ok: false, reason: `new stop ${reply.stop} is on the wrong side of price ${price}` };
      return { ok: true, kind: "hold", tightenStop: reply.stop };
    }
    return { ok: true, kind: "hold", tightenStop: null };
  }
  if (reply.action === "close") {
    if (!s.open) return { ok: false, reason: "close requested with no open position" };
    return { ok: true, kind: "close" };
  }

  const blocked = entryBlocked(now, s);
  if (blocked) return { ok: false, reason: blocked };
  const { stop, target, max_hold_minutes: hold } = reply;
  if (stop === null || target === null || hold === null) return { ok: false, reason: "entry needs stop, target and max_hold_minutes" };
  const long = reply.action === "long";
  if (long ? !(stop < price && target > price) : !(stop > price && target < price)) {
    return { ok: false, reason: `stop/target on the wrong side of price ${price} for a ${reply.action}` };
  }
  const stopDist = Math.abs(price - stop);
  const stopFrac = stopDist / price;
  if (stopFrac < TRADER.minStopFraction || stopFrac > TRADER.maxStopFraction) {
    return { ok: false, reason: `stop distance ${(stopFrac * 100).toFixed(3)}% outside ${TRADER.minStopFraction * 100}%–${TRADER.maxStopFraction * 100}%` };
  }
  if (Math.abs(target - price) < TRADER.targetMinMultiple * stopDist - 1e-9) {
    return { ok: false, reason: `target distance ${Math.abs(target - price).toFixed(2)} < ${TRADER.targetMinMultiple}× stop distance ${stopDist.toFixed(2)}` };
  }
  if (hold < TRADER.minHoldMinutes) return { ok: false, reason: `max_hold_minutes ${hold} < ${TRADER.minHoldMinutes}` };
  const qty = Math.floor(TRADER.notional / price);
  if (qty < 1) return { ok: false, reason: "price above notional" };
  // The time limit never runs past the flat-by time.
  const untilFlat = hhmmToMinutes(TRADER.flatBy) - minutesEt(now);
  return { ok: true, kind: "enter", side: long ? "long" : "short", qty, stop, target, maxHoldMinutes: Math.min(hold, untilFlat) };
}

// ---------------------------------------------------------------- exits

/** Exit reason due now for an open position (stop/target are broker-side), or null. */
export function timeExitDue(now: Date, t: OpenTrade): "time" | "eod" | null {
  if (minutesEt(now) >= hhmmToMinutes(TRADER.flatBy)) return "eod";
  if (t.entryAt && now.getTime() >= Date.parse(t.entryAt) + t.maxHoldMinutes * 60000) return "time";
  return null;
}

// ---------------------------------------------------------------- data guards

/**
 * "No action: bad data" checks against the server clock:
 *  - the latest quote is at most 10 s old (and not from the future);
 *  - the last N completed minutes have 1-min bars, at most TRADER.maxMissingBars missing, and never the latest;
 *  - no bar or quote is timestamped more than 5 s ahead of the server clock.
 * Returns problems found (empty = data OK).
 */
export function dataProblems(args: { now: Date; quote: Quote | undefined; bars1m: Bar[]; sessionOpen: Date }): string[] {
  const { now, quote, bars1m } = args;
  const out: string[] = [];
  const skew = TRADER.maxClockSkewSeconds * 1000;
  if (!quote) out.push("no quote");
  else {
    const qt = Date.parse(quote.ts);
    const age = (now.getTime() - qt) / 1000;
    if (age > TRADER.maxQuoteAgeSeconds) out.push(`quote ${age.toFixed(1)}s old`);
    if (qt - now.getTime() > skew) out.push(`quote timestamp ${((qt - now.getTime()) / 1000).toFixed(1)}s ahead of server clock`);
    if (!(quote.bid > 0 && quote.ask > 0 && quote.ask >= quote.bid)) out.push("quote bid/ask invalid");
  }
  // No bar may be stamped later than the server clock (allowing 5 s of skew).
  const ahead = bars1m.find((b) => Date.parse(b.ts) - now.getTime() > skew);
  if (ahead) out.push(`bar ${ahead.ts} is ahead of server clock`);
  const lastClosedStart = Math.floor(now.getTime() / 60000) * 60000 - 60000;
  const from = Math.max(args.sessionOpen.getTime(), lastClosedStart - (TRADER.barCompletenessMinutes - 1) * 60000);
  const have = new Set(bars1m.map((b) => Date.parse(b.ts)));
  const missing: string[] = [];
  for (let t = from; t <= lastClosedStart; t += 60000) if (!have.has(t)) missing.push(toEt(new Date(t)).hhmm);
  const latestMissing = !have.has(lastClosedStart);
  if (missing.length > TRADER.maxMissingBars || latestMissing) out.push(`missing 1-min bars at ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
  return out;
}

// ---------------------------------------------------------------- schedule

/** Decision slot for `now` (server clock): "premarket", an intraday HH:MM slot, or null. */
export function decisionSlot(now: Date): { phase: "premarket" | "intraday"; hhmm: string } | null {
  const et = toEt(now);
  if (et.hhmm === TRADER.premarketRead) return { phase: "premarket", hhmm: et.hhmm };
  const m = et.minutes;
  if (m < hhmmToMinutes(TRADER.firstEntry) || m > hhmmToMinutes(TRADER.lastEntry)) return null;
  if ((m - hhmmToMinutes(TRADER.firstEntry)) % TRADER.decisionEveryMinutes !== 0) return null;
  return { phase: "intraday", hhmm: et.hhmm };
}

/** Stable id for a slot: one decision per slot per version. */
export const slotKey = (date: string, hhmm: string) => `${date} ${hhmm}`;

export const sessionOpenUtc = (date: string) => etToUtc(date, "09:30");
