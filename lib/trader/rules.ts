/**
 * Rules the code enforces (never the model). Pure functions over plain data;
 * every time check uses the server clock passed in as `now`.
 */

import { z } from "zod";
import { TRADER } from "@/config/trader";
import type { Bar } from "../alpaca";
import { etToUtc, hhmmToMinutes, toEt } from "../time";

// ---------------------------------------------------------------- reply

export const ACTIONS = ["long", "short", "close", "hold"] as const;
export const CATALYSTS = ["news", "technical", "macro", "panic_reversal", "none"] as const;

export const replySchema = z.object({
  action: z.enum(ACTIONS),
  /** v4: the stated chance (%) that the target is hit before the stop; required for entries, null otherwise. */
  confidence: z.number().min(0).max(100).nullable(),
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
    confidence: { anyOf: [{ type: "number" }, { type: "null" }] },
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
  /** The stop given at entry (the breakeven move changes `stop`, never this). */
  stopInitial: number;
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
  | { ok: true; kind: "hold" }
  | { ok: false; reason: string };

const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Average true range of the last `period` true ranges of the given bars (ascending). v4 feeds it regular-session
 * 15-min bars from the last few days. Null with fewer than 5 ranges.
 */
export function atr(bars: Array<{ h: number; l: number; c: number }>, period = TRADER.atrPeriod): number | null {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c;
    trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  const last = trs.slice(-period);
  return last.length >= 5 ? last.reduce((a, b) => a + b, 0) / last.length : null;
}

/** Regular-session bars only (bar start 09:30–15:59 ET), ascending. */
export function regularSession<T extends { ts: string }>(bars: T[]): T[] {
  return bars
    .filter((b) => {
      const m = toEt(new Date(b.ts)).minutes;
      return m >= 9 * 60 + 30 && m < 16 * 60;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Allowed stop distance ($) for an entry at `price` given the 15-min ATR. */
export function stopBand(price: number, atr15: number): { min: number; max: number } {
  const min = Math.max(TRADER.stopMinAtr * atr15, TRADER.stopFloorFraction * price);
  const max = Math.min(TRADER.stopMaxAtr * atr15, TRADER.stopCapFraction * price);
  return { min: r2(min), max: r2(Math.max(max, min)) };
}

/** Shares for a stop `stopDist` away: riskPerTrade ÷ stopDist, capped at maxNotional. */
export function positionSize(price: number, stopDist: number): number {
  if (!(stopDist > 0) || !(price > 0)) return 0;
  return Math.max(0, Math.min(Math.floor(TRADER.riskPerTrade / stopDist), Math.floor(TRADER.maxNotional / price)));
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** v5: % chance of target-before-stop at which a trade breaks even (before costs): stop ÷ (stop + target). */
export function breakEvenRate(stopDist: number, targetDist: number): number {
  return (100 * stopDist) / (stopDist + targetDist);
}

/**
 * Turn a model reply into something the code may act on. `price` is the reference price (the last completed
 * 1-min bar's close) and `atr15` the 15-min ATR at decision time. v4: a hold never changes the stop.
 */
export function validateAction(reply: Reply, price: number, now: Date, s: DayState, atr15: number | null): Validated {
  if (reply.action === "hold") return { ok: true, kind: "hold" };
  if (reply.action === "close") {
    if (!s.open) return { ok: false, reason: "close requested with no open position" };
    return { ok: true, kind: "close" };
  }

  const blocked = entryBlocked(now, s);
  if (blocked) return { ok: false, reason: blocked };
  const { stop, target, max_hold_minutes: hold, confidence } = reply;
  if (stop === null || target === null || hold === null) return { ok: false, reason: "entry needs stop, target and max_hold_minutes" };
  if (confidence === null) return { ok: false, reason: "entry needs confidence (chance of target before stop)" };
  if (!(price > 0)) return { ok: false, reason: "no reference price" };
  const long = reply.action === "long";
  if (long ? !(stop < price && target > price) : !(stop > price && target < price)) {
    return { ok: false, reason: `stop/target on the wrong side of price ${price} for a ${reply.action}` };
  }
  if (atr15 === null) return { ok: false, reason: "no 15-min ATR to size the stop" };
  const stopDist = Math.abs(price - stop);
  const band = stopBand(price, atr15);
  if (stopDist < band.min - 1e-9 || stopDist > band.max + 1e-9) {
    return { ok: false, reason: `stop distance ${stopDist.toFixed(2)} outside the allowed ${band.min.toFixed(2)}–${band.max.toFixed(2)}` };
  }
  if (Math.abs(target - price) < TRADER.targetMinMultiple * stopDist - 1e-9) {
    return { ok: false, reason: `target distance ${Math.abs(target - price).toFixed(2)} < ${TRADER.targetMinMultiple}× stop distance ${stopDist.toFixed(2)}` };
  }
  const needed = breakEvenRate(stopDist, Math.abs(target - price)) + TRADER.minEdgePoints;
  if (!(confidence > needed + 1e-9)) {
    return { ok: false, reason: `chance of target before stop ${confidence}% is not above the ${r1(needed)}% break-even for this reward-to-risk` };
  }
  if (hold < TRADER.minHoldMinutes) return { ok: false, reason: `max_hold_minutes ${hold} < ${TRADER.minHoldMinutes}` };
  const qty = positionSize(price, stopDist);
  if (qty < 1) return { ok: false, reason: "stop too wide for one share at the risk limit" };
  // The time limit never runs past the flat-by time.
  const untilFlat = hhmmToMinutes(TRADER.flatBy) - minutesEt(now);
  return { ok: true, kind: "enter", side: long ? "long" : "short", qty, stop, target, maxHoldMinutes: Math.min(hold, untilFlat) };
}

/**
 * v4's only stop change: once the trade has been ahead by breakevenAtR × its initial risk (`high`/`low` are the
 * extremes since entry), move the stop to the entry price. Null when not due or already done.
 */
export function breakevenStop(t: OpenTrade, high: number, low: number): number | null {
  if (t.entryPrice === null) return null;
  const risk = Math.abs(t.entryPrice - t.stopInitial);
  if (!(risk > 0)) return null;
  const long = t.side === "long";
  if (long ? t.stop >= t.entryPrice : t.stop <= t.entryPrice) return null; // already at or past breakeven
  const reached = long ? high >= t.entryPrice + TRADER.breakevenAtR * risk : low <= t.entryPrice - TRADER.breakevenAtR * risk;
  return reached ? r2(t.entryPrice) : null;
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
 * "No action: bad data" checks against the server clock (v4: bars only, the quote is not used):
 *  - the last N completed minutes have 1-min bars, at most TRADER.maxMissingBars missing, and never the latest;
 *  - no bar is timestamped more than 5 s ahead of the server clock.
 * Returns problems found (empty = data OK).
 */
export function dataProblems(args: { now: Date; bars1m: Bar[]; sessionOpen: Date }): string[] {
  const { now, bars1m } = args;
  const out: string[] = [];
  const skew = TRADER.maxClockSkewSeconds * 1000;
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

/** Decision slot for `now` (server clock): an intraday HH:MM slot every few minutes in the entry window, or null. v4 has no pre-market read. */
export function decisionSlot(now: Date): { phase: "premarket" | "intraday"; hhmm: string } | null {
  const et = toEt(now);
  const m = et.minutes;
  if (m < hhmmToMinutes(TRADER.firstEntry) || m > hhmmToMinutes(TRADER.lastEntry)) return null;
  if ((m - hhmmToMinutes(TRADER.firstEntry)) % TRADER.decisionEveryMinutes !== 0) return null;
  return { phase: "intraday", hhmm: et.hhmm };
}

/** Stable id for a slot: one decision per slot per version. */
export const slotKey = (date: string, hhmm: string) => `${date} ${hhmm}`;

export const sessionOpenUtc = (date: string) => etToUtc(date, "09:30");
