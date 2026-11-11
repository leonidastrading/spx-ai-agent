import { describe, expect, it } from "vitest";
import type { Bar } from "@/lib/alpaca";
import { buyAndHold, decisionGate, grossPl, randomBaseline, simulateTrade, slippage, stats, type ScoredTrade } from "@/lib/trader/scoring";
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

describe("decision gate", () => {
  const base = { strategyTotal: 2000, strategyMaxDd: 500, bhTotal: 1000, bhMaxDd: 800 };
  it("waits for 150 trades AND 60 days", () => {
    expect(decisionGate({ ...base, trades: 200, tradingDays: 59, netExpectancy: 10, percentile: 0.99 }).ready).toBe(false);
    expect(decisionGate({ ...base, trades: 149, tradingDays: 90, netExpectancy: 10, percentile: 0.99 }).ready).toBe(false);
  });
  it("pass only if all three checks hold", () => {
    expect(decisionGate({ ...base, trades: 150, tradingDays: 60, netExpectancy: 10, percentile: 0.96 }).verdict).toBe("pass");
    expect(decisionGate({ ...base, trades: 150, tradingDays: 60, netExpectancy: 10, percentile: 0.94 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, trades: 150, tradingDays: 60, netExpectancy: -1, percentile: 0.99 }).verdict).toBe("fail");
    expect(decisionGate({ ...base, bhTotal: 5000, bhMaxDd: 100, trades: 150, tradingDays: 60, netExpectancy: 10, percentile: 0.99 }).verdict).toBe("fail");
  });
});
