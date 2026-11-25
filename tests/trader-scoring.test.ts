import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/alpaca";
import { buyAndHold, calibration, decisionGate, fifteenMinute, grossPl, randomBaseline, simulateTrade, slippage, stats, vwapRuleDay, type ScoredTrade } from "@/lib/trader/scoring";
import { etToUtc } from "@/lib/time";

const D = "2024-03-11";
/** Regular-session bars with closes from fn(i); wick ±w. */
function day(fn: (i: number) => number, w = 0.05, date = D): Bar[] {
  const start = etToUtc(date, "09:30").getTime();
  let prev = fn(0);
  return Array.from({ length: 390 }, (_, i) => {
    const c = fn(i);
    const o = prev;
    prev = c;
    return { symbol: "QQQ", ts: new Date(start + i * 60000).toISOString(), o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, v: 100, feed: "iex" as const };
  });
}
const t = (hhmm: string) => etToUtc(D, hhmm).getTime();

describe("simulateTrade", () => {
  it("target hit on a rising day", () => {
    const s = simulateTrade(day((i) => 400 + i * 0.05), D, t("10:00"), "long", 0.002, 0.004, 120)!;
    expect(s.reason).toBe("target");
    expect(s.qty).toBe(Math.floor(10000 / s.entry));
    expect(s.gross).toBeGreaterThan(0);
  });
  it("stop wins when stop and target are touched in the same bar", () => {
    const bars = day(() => 400);
    const i = bars.findIndex((b) => Date.parse(b.ts) === t("10:05"));
    bars[i] = { ...bars[i], h: 410, l: 390 };
    expect(simulateTrade(bars, D, t("10:00"), "long", 0.002, 0.004, 60)!.reason).toBe("stop");
  });
  it("v4: size override and the breakeven move (from the bar after the trade is ahead by its risk)", () => {
    // Up 1R (400 → 400.8 with a 0.2% stop), then back down through the entry.
    const path = (i: number) => (i < 30 ? 400 : i < 40 ? 400 + (i - 29) * 0.1 : 401 - (i - 39) * 0.1);
    const bars = day(path, 0);
    const plain = simulateTrade(bars, D, t("10:00"), "long", 0.002, 0.01, 120, { qty: 7 })!;
    expect(plain).toMatchObject({ qty: 7, reason: "stop" });
    expect(plain.gross).toBeCloseTo(-7 * 0.8, 6);
    const be = simulateTrade(bars, D, t("10:00"), "long", 0.002, 0.01, 120, { qty: 7, breakeven: true })!;
    expect(be).toMatchObject({ qty: 7, reason: "stop", exit: 400, gross: 0 });
    expect(be.exitAt).toBeLessThan(plain.exitAt);
  });

  it("time limit and 15:55 exit", () => {
    expect(simulateTrade(day(() => 400, 0), D, t("10:00"), "short", 0.002, 0.004, 30)!).toMatchObject({ reason: "time", gross: 0 });
    expect(simulateTrade(day(() => 400, 0), D, t("15:30"), "long", 0.002, 0.004, 120)!.reason).toBe("eod");
  });
});

describe("stats", () => {
  it("win rate, expectancy, drawdown", () => {
    const s = stats([100, -50, -70, 200, -10]);
    expect(s).toMatchObject({ n: 5, wins: 2, winRate: 0.4, avgWin: 150, avgLoss: -43.33, expectancy: 34, total: 170, maxDrawdown: 120 });
  });
  it("net = gross − $0.01/share each way", () => {
    expect(slippage(20)).toBeCloseTo(0.4);
    expect(grossPl({ side: "short", qty: 20, entryPrice: 500, exitPrice: 499 })).toBe(20);
  });
});

describe("baselines", () => {
  const mk = (id: number, side: "long" | "short", entry: number, exit: number): ScoredTrade => ({
    id, date: D, side, qty: 25, entryPrice: entry, exitPrice: exit, entryAt: etToUtc(D, "10:00").toISOString(), exitAt: etToUtc(D, "10:30").toISOString(),
    stop: side === "long" ? entry * 0.998 : entry * 1.002, target: side === "long" ? entry * 1.004 : entry * 0.996, maxHoldMinutes: 60, confidence: 70, catalyst: "technical", exitReason: "target",
  });
  const bars = new Map([[D, day((i) => 400 + Math.sin(i / 7) * 1.5)]]);

  it("random entries: deterministic, 20 sims per trade, real result placed in the distribution", () => {
    const trades = [mk(1, "long", 400, 401.6), mk(2, "short", 401, 399.4), mk(3, "long", 400, 401.6)];
    const a = randomBaseline(trades, bars);
    const b = randomBaseline(trades, bars);
    expect(a.percentile).toBe(b.percentile);
    expect(a.simsPerTrade.map((s) => s.length)).toEqual([20, 20, 20]);
    // Every real trade hit its target, which random entries rarely all do.
    expect(a.percentile!).toBeGreaterThan(0.9);
    const losers = randomBaseline([mk(1, "long", 400, 399.2), mk(2, "long", 400, 399.2)], bars);
    expect(losers.percentile!).toBeLessThan(0.1);
  });

  it("buy and hold open→close at the same notional", () => {
    const bh = buyAndHold(new Map([[D, day((i) => 400 + i * 0.01, 0)]]), [D, "2024-03-12"]);
    expect(bh).toHaveLength(1);
    // qty = floor(10000 / 400) = 25; close = 400 + 389 × 0.01
    expect(bh[0].gross).toBeCloseTo(25 * 3.89, 2);
    expect(bh[0].net).toBeCloseTo(25 * 3.89 - 0.5, 2);
  });
});

describe("VWAP-side rule (same limits, sizing and stops as the trader)", () => {
  // Earlier day's 15-min bars with a $2 range: ATR 2, so the rule's stop is $2 (1× ATR) and size $50 ÷ $2 = 25.
  const prior15 = fifteenMinute(day(() => 400, 1, "2024-03-08"), "2024-03-08").map((b) => ({ ...b, h: 401, l: 399 }));

  it("rising day: long above VWAP, at most 3 trades, never overlapping", () => {
    const trades = vwapRuleDay(day((i) => 400 + i * 0.1), D, prior15);
    expect(trades.length).toBe(3);
    expect(trades.every((x) => x.side === "long" && x.reason === "target")).toBe(true);
    expect(trades[0].qty).toBe(25); // later trades re-size as today's own 15-min bars join the ATR
    expect(trades[0].entryAt).toBe(t("09:35"));
    for (let i = 1; i < trades.length; i++) expect(trades[i].entryAt).toBeGreaterThan(trades[i - 1].entryAt);
    expect(trades[0].net).toBeCloseTo(25 * 3 - slippage(25), 2); // target 1.5 × $2
  });

  it("falling day: short below VWAP; without an earlier day it waits for today's ATR", () => {
    expect(vwapRuleDay(day((i) => 400 - i * 0.1), D, prior15).every((x) => x.side === "short")).toBe(true);
    // ATR needs 5 ranges: six completed 15-min bars, at 11:00.
    expect(vwapRuleDay(day((i) => 400 - i * 0.1), D, [])[0].entryAt).toBe(t("11:00"));
  });
});

describe("calibration", () => {
  it("stated chance vs how often the target came first", () => {
    const mk = (confidence: number, exitReason: string): ScoredTrade => ({
      id: 1, date: D, side: "long", qty: 10, entryPrice: 1, exitPrice: 1, entryAt: "", exitAt: "", stop: 0, target: 2, maxHoldMinutes: 30, confidence, catalyst: "none", exitReason,
    });
    expect(calibration([mk(60, "target"), mk(64, "stop"), mk(62, "target"), mk(66, "time"), mk(85, "target")])).toEqual([
      { band: "60–69", n: 4, stated: 0.63, targetFirst: 0.5, stopFirst: 0.25, other: 0.25 },
      { band: "80–100", n: 1, stated: 0.85, targetFirst: 1, stopFirst: 0, other: 0 },
    ]);
  });
});

describe("decision gate", () => {
  const base = { strategyTotal: 2000, strategyMaxDd: 500, bhTotal: 1000, bhMaxDd: 800, vwapTotal: 500 };
  it("waits for 100 trades AND 40 days", () => {
    expect(decisionGate({ ...base, trades: 200, tradingDays: 39, netExpectancy: 10, percentile: 0.99 }).ready).toBe(false);
    expect(decisionGate({ ...base, trades: 99, tradingDays: 90, netExpectancy: 10, percentile: 0.99 }).ready).toBe(false);
  });
  it("pass only if all four checks hold, including beating the VWAP rule", () => {
    expect(decisionGate({ ...base, trades: 100, tradingDays: 40, netExpectancy: 10, percentile: 0.96 }).verdict).toBe("pass");
    expect(decisionGate({ ...base, trades: 100, tradingDays: 40, netExpectancy: 10, percentile: 0.94 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, trades: 100, tradingDays: 40, netExpectancy: -1, percentile: 0.99 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, bhTotal: 5000, bhMaxDd: 100, trades: 100, tradingDays: 40, netExpectancy: 10, percentile: 0.99 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, vwapTotal: 2500, trades: 100, tradingDays: 40, netExpectancy: 10, percentile: 0.99 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, vwapTotal: null, trades: 100, tradingDays: 40, netExpectancy: 10, percentile: 0.99 }).verdict).toBe("fail");
  });
});
